import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKUP_SCRIPT = join(ROOT, 'deploy', 'backup-db.sh');
const LAUNCHER_SCRIPT = join(ROOT, 'scripts', 'docker-up.sh');

const FAKE_DOCKER = `#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$DOCKER_LOG"

if [[ " $* " == *" ps --status running --services "* ]]; then
  if [ "\${FAKE_APP_RUNNING:-false}" = "true" ]; then printf 'app\n'; fi
  exit 0
fi

if [ "\${1:-}" = "volume" ] && [ "\${2:-}" = "inspect" ]; then
  if [ "\${FAKE_VOLUME_EXISTS:-false}" = "true" ]; then exit 0; fi
  exit 1
fi

if [[ " $* " == *" cp app:"* ]]; then
  if [ "\${FAKE_COPY_FAIL:-false}" = "true" ]; then exit 7; fi
  destination="\${!#}"
  printf 'sqlite-backup' > "$destination"
  exit 0
fi

if [[ " $* " == *" run --rm --no-deps "* ]]; then
  if [ "\${FAKE_DB_MISSING:-false}" = "true" ]; then exit 2; fi
  backup_arg="\${!#}"
  output_name="\${backup_arg##*/}"
  printf 'sqlite-backup' > "$BACKUP_DIR/$output_name"
  exit 0
fi

if [[ " $* " == *" down --remove-orphans "* ]] && [ "\${FAKE_DOWN_FAIL:-false}" = "true" ]; then
  exit 8
fi

exit 0
`;

describe('production database backup deployment', () => {
  let tempRoot: string;
  let backupDir: string;
  let dockerLog: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'andean-backup-'));
    backupDir = join(tempRoot, 'backups');
    dockerLog = join(tempRoot, 'docker.log');
    const binDir = join(tempRoot, 'bin');
    writeFileSync(dockerLog, '');
    mkdirSync(binDir);
    const dockerPath = join(binDir, 'docker');
    writeFileSync(dockerPath, FAKE_DOCKER);
    chmodSync(dockerPath, 0o700);
    const sleepPath = join(binDir, 'sleep');
    writeFileSync(sleepPath, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(sleepPath, 0o700);
    const curlPath = join(binDir, 'curl');
    writeFileSync(curlPath, '#!/usr/bin/env bash\nif [ "${FAKE_HEALTH_FAIL:-false}" = "true" ]; then exit 1; fi\nprintf "{}"\n');
    chmodSync(curlPath, 0o700);
    const flockPath = join(binDir, 'flock');
    writeFileSync(flockPath, '#!/usr/bin/env bash\nif [ "${FAKE_LOCK_BUSY:-false}" = "true" ]; then exit 1; fi\nexit 0\n');
    chmodSync(flockPath, 0o700);
    env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      BACKUP_DIR: backupDir,
      DOCKER_LOG: dockerLog,
      ENV_FILE: '.env.prod',
    };
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('routes the primary production command through the backup-enabled launcher', () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['docker:prod']).toBe('bash scripts/docker-up.sh --no-logs');
  });

  it('creates an online compressed backup with a persistent lock file', () => {
    const result = spawnSync('/bin/bash', [BACKUP_SCRIPT], {
      cwd: ROOT,
      env: { ...env, FAKE_APP_RUNNING: 'true' },
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(backupDir).filter(name => name.endsWith('.sqlite.gz'))).toHaveLength(1);
    expect(readdirSync(backupDir)).toContain('.backup.lock');
  });

  it('backs up a stopped app from its persistent volume', () => {
    const result = spawnSync('/bin/bash', [BACKUP_SCRIPT], {
      cwd: ROOT,
      env: { ...env, FAKE_VOLUME_EXISTS: 'true' },
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(backupDir).filter(name => name.endsWith('.sqlite.gz'))).toHaveLength(1);
    expect(readFileSync(dockerLog, 'utf-8')).toContain('run --rm --no-deps');
  });

  it('allows a first deployment when no database volume exists', () => {
    const result = spawnSync('/bin/bash', [BACKUP_SCRIPT], {
      cwd: ROOT,
      env,
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('nothing to back up');
    expect(readdirSync(backupDir).filter(name => name.endsWith('.gz'))).toEqual([]);
  });

  it('rejects a concurrent backup', () => {
    const result = spawnSync('/bin/bash', [BACKUP_SCRIPT], {
      cwd: ROOT,
      env: { ...env, FAKE_LOCK_BUSY: 'true' },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('already running');
    expect(readFileSync(dockerLog, 'utf-8')).toBe('');
  });

  it('backs up a stopped volume before shutting down', () => {
    const result = spawnSync('/bin/bash', [LAUNCHER_SCRIPT, '--no-logs'], {
      cwd: ROOT,
      env: { ...env, FAKE_VOLUME_EXISTS: 'true' },
      encoding: 'utf-8',
    });
    const commands = readFileSync(dockerLog, 'utf-8');

    expect(result.status, result.stderr).toBe(0);
    expect(commands.indexOf('run --rm --no-deps')).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('run --rm --no-deps')).toBeLessThan(commands.indexOf(' build'));
    expect(commands.indexOf(' build')).toBeLessThan(commands.indexOf('down --remove-orphans'));
  });

  it('supports an explicit backup skip', () => {
    const result = spawnSync('/bin/bash', [LAUNCHER_SCRIPT, '--build-only', '--skip-backup'], {
      cwd: ROOT,
      env,
      encoding: 'utf-8',
    });
    const commands = readFileSync(dockerLog, 'utf-8');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Skipping pre-restart backup');
    expect(commands).not.toContain('ps --status running');
    expect(commands).not.toContain('run --rm --no-deps');
    expect(commands).not.toContain('down --remove-orphans');
  });

  it('aborts deployment before shutdown and cleans partial backup state', () => {
    const result = spawnSync('/bin/bash', [LAUNCHER_SCRIPT, '--no-logs'], {
      cwd: ROOT,
      env: { ...env, FAKE_APP_RUNNING: 'true', FAKE_COPY_FAIL: 'true' },
      encoding: 'utf-8',
    });
    const commands = readFileSync(dockerLog, 'utf-8');

    expect(result.status).toBe(7);
    expect(commands).not.toContain('down --remove-orphans');
    expect(readdirSync(backupDir)).toEqual(['.backup.lock']);
  });

  it('does not recreate containers after shutdown fails', () => {
    const result = spawnSync('/bin/bash', [LAUNCHER_SCRIPT, '--no-logs'], {
      cwd: ROOT,
      env: { ...env, FAKE_DOWN_FAIL: 'true' },
      encoding: 'utf-8',
    });
    const commands = readFileSync(dockerLog, 'utf-8');

    expect(result.status).toBe(8);
    expect(commands).not.toContain('--profile tunnel up');
  });

  it('reports an unhealthy deployment as failed', () => {
    const result = spawnSync('/bin/bash', [LAUNCHER_SCRIPT, '--no-logs'], {
      cwd: ROOT,
      env: { ...env, FAKE_HEALTH_FAIL: 'true' },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Health check failed');
  });
});
