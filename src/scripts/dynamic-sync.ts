/**
 * Sync the bot's catalog JSON with the R2 bucket.
 *
 *   npm run dynamic:pull -- --target dev|prod [--force]
 *   npm run dynamic:push -- --target dev|prod [--dry-run] [--force] [--confirm]
 *
 * Targets:
 *   dev   scripts/bot-dynamic-dev.json  -> whatsapp_bot/bot-dynamic-dev.json
 *   prod  scripts/bot-dynamic.json      -> whatsapp_bot/bot-dynamic.json
 *
 * Push order: validate (validate-dynamic, the same checks as CI), classify against
 * the last synced copy, require every referenced media object to be on the CDN,
 * back up the live file, upload, record the new base, purge the CDN.
 *
 * Classification uses `scripts/.dynamic-base/<file>`, the live bytes the local copy
 * was last synced from. A local edit with an unchanged live file pushes; a live
 * change with an unedited local file pulls; both changed is a conflict. `--force`
 * overrides the classification.
 *
 * Prod push requires `--confirm` and refuses placeholder photos (a site photo
 * byte-identical to another site's). R2 object versioning is off, so the backup in
 * `scripts/.dynamic-previous/<timestamp>/` is the only undo.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { downloadFromOrigin, purgeCache, readOriginLength } from './lib/cdn.js';
import {
  BASE_DIR,
  CATALOG_TARGETS,
  PREVIOUS_DIR,
  REPO_ROOT,
  bucketName,
  classifyCatalogSync,
  collectMediaKeys,
  decideCatalogPull,
  decideCatalogPush,
  isCatalogTarget,
  keyToUrl,
  type CatalogSyncAction,
  type CatalogTarget,
} from './lib/catalog-media.js';
import { checkCrossSiteDuplicates, describeCrossSiteDuplicates } from './lib/media-guard.js';
import { assertDynamicCatalogReady, dynamicDataSchema } from '../services/dynamic-data-schema.js';
import { requireMatchingPublishedMedia } from './lib/published-media.js';
import { savePulledCatalog } from './lib/pulled-catalog.js';

const argv = process.argv.slice(2);
const command = argv[0];
const dryRun = argv.includes('--dry-run');
const force = argv.includes('--force');
const confirmed = argv.includes('--confirm');

function fail(message: string): never {
  console.error(`[dynamic:${command ?? '?'}] ${message}`);
  process.exit(1);
}

function parseTarget(): CatalogTarget {
  const index = argv.indexOf('--target');
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || !isCatalogTarget(value)) {
    fail(`--target must be one of: ${Object.keys(CATALOG_TARGETS).join(', ')}`);
  }
  return value;
}

/** Live bytes, or null when the object does not exist. Unreadable aborts. */
async function readLive(url: string): Promise<Buffer | null> {
  const probe = await readOriginLength(url);
  if (probe.status === 'absent') return null;
  if (probe.status === 'unavailable') fail(`could not read ${url}: ${probe.reason}`);

  const download = await downloadFromOrigin(url);
  if (!download.ok) fail(`could not download ${url}: ${download.reason}`);
  return download.body;
}

function readIfExists(location: string): Buffer | null {
  return existsSync(location) ? readFileSync(location) : null;
}

function describe(action: CatalogSyncAction): string {
  switch (action) {
    case 'in-sync':
      return 'local and live are identical';
    case 'push':
      return 'local has edits, live is unchanged';
    case 'pull':
      return 'live has changed, local has no edits';
    case 'create':
      return 'not published yet';
    case 'conflict':
      return 'local has edits AND live has changed since the last sync';
    case 'missing-live':
      return 'neither local nor live exists';
  }
}

async function pullCommand(target: CatalogTarget): Promise<void> {
  const { file, key } = CATALOG_TARGETS[target];
  const location = path.join(REPO_ROOT, file);
  const basePath = path.join(BASE_DIR, path.basename(file));

  const live = await readLive(keyToUrl(key));
  if (live) assertDynamicCatalogReady(dynamicDataSchema.parse(JSON.parse(live.toString('utf8')) as unknown));
  const local = readIfExists(location);
  const base = readIfExists(basePath);
  const action = force && live ? 'pull' : classifyCatalogSync({ local, live, base });

  console.log(`[dynamic:pull] ${target}: ${describe(action)}`);

  const decision = decideCatalogPull(action);
  if (decision.kind === 'fail') fail(`${file} (${bucketName()}/${key}): ${decision.reason}`);
  if (decision.kind === 'noop') {
    if (decision.recordBase && live) recordBase(basePath, live);
    return;
  }
  if (!live) fail(`${key} is not published in ${bucketName()}.`);

  if (local) {
    const previous = backUp(file, local);
    console.log(`[dynamic:pull] local copy backed up to ${previous}`);
  }
  savePulledCatalog(location, basePath, live);
  console.log(`[dynamic:pull] wrote ${file}`);
}

function recordBase(basePath: string, bytes: Buffer): void {
  mkdirSync(path.dirname(basePath), { recursive: true });
  writeFileSync(basePath, bytes);
}

function backUp(file: string, bytes: Buffer): string {
  const dir = path.join(PREVIOUS_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, path.basename(file));
  writeFileSync(destination, bytes);
  return path.relative(REPO_ROOT, destination);
}

/** `npm run validate:dynamic` checks, run as a child process so CI and publish share one gate. */
function validate(file: string): void {
  try {
    execFileSync('npx', ['--no-install', 'tsx', 'src/scripts/validate-dynamic.ts', file], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } catch {
    fail(`${file} is not valid. Nothing was uploaded.`);
  }
}

async function requirePublishedMedia(json: unknown): Promise<void> {
  const keys = Array.from(collectMediaKeys(json)).sort();
  const missing: string[] = [];

  for (const key of keys) {
    const remote = await readOriginLength(keyToUrl(key));
    if (remote.status === 'absent') missing.push(key);
    if (remote.status === 'unavailable') fail(`could not check ${key}: ${remote.reason}`);
  }

  if (missing.length > 0) {
    console.error('[dynamic:push] these media objects are not on the CDN yet:');
    missing.forEach((key) => console.error(`  ✗ ${key}`));
    fail('publish them first with `npm run media:push`. Nothing was uploaded.');
  }
  console.log(`[dynamic:push] media OK: ${keys.length} referenced object(s) on the CDN`);
}

/**
 * Prod never receives placeholder photos. Unlike `sync:fixture`, an unchecked key
 * fails too: prod is the one place a placeholder reaches real customers.
 */
function requireNoPlaceholders(json: unknown): void {
  const check = checkCrossSiteDuplicates(json);
  const failure = describeCrossSiteDuplicates(check);
  if (failure) fail(`${failure}\nNothing was uploaded.`);
  if (check.unverified.length > 0) {
    fail(
      `${check.unverified.length} site photo(s) are not in r2-cache/, so they cannot be checked for ` +
        'placeholders. Run `npm run media:pull` first. Nothing was uploaded.',
    );
  }
}

function upload(key: string, location: string): void {
  // Never resolve a missing binary from the registry: this runs with R2 credentials loaded.
  execFileSync(
    'npx',
    [
      '--no-install',
      'dotenv',
      '-e',
      '.env.wrangler',
      '--',
      'wrangler',
      'r2',
      'object',
      'put',
      `${bucketName()}/${key}`,
      '--file',
      location,
      '--content-type',
      'application/json',
      '--remote',
    ],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
}

async function pushCommand(target: CatalogTarget): Promise<void> {
  const { file, key } = CATALOG_TARGETS[target];
  const location = path.join(REPO_ROOT, file);
  const basePath = path.join(BASE_DIR, path.basename(file));

  const local = readIfExists(location);
  if (!local) fail(`${file} does not exist. Run \`npm run dynamic:pull -- --target ${target}\` first.`);

  validate(file);
  const json: unknown = JSON.parse(local.toString('utf8'));

  const live = await readLive(keyToUrl(key));
  const base = readIfExists(basePath);
  const action: CatalogSyncAction = force
    ? (live ? 'push' : 'create')
    : classifyCatalogSync({ local, live, base });

  console.log(`[dynamic:push] ${target}: ${describe(action)}`);

  const decision = decideCatalogPush({ action, target, baseMissing: base === null, confirmed, dryRun });
  if (decision.kind === 'fail') fail(`${decision.reason} Nothing was uploaded.`);
  if (decision.kind === 'noop') {
    if (decision.recordBase && live) recordBase(basePath, live);
    return;
  }

  if (target === 'prod') requireNoPlaceholders(json);
  await requirePublishedMedia(json);
  if (target === 'prod') await requireMatchingPublishedMedia(json);

  if (dryRun) {
    console.log(`[dynamic:push] DRY RUN: would upload ${file} -> ${bucketName()}/${key}`);
    return;
  }

  if (!existsSync(path.join(REPO_ROOT, '.env.wrangler'))) {
    fail('.env.wrangler is missing. Copy .env.wrangler.example and fill in the token.');
  }

  if (live) console.log(`[dynamic:push] live copy backed up to ${backUp(file, live)}`);

  upload(key, location);
  recordBase(basePath, local);
  console.log(`[dynamic:push] uploaded ${file} -> ${bucketName()}/${key}`);

  const purge = await purgeCache([keyToUrl(key)]);
  if (purge.ok) {
    console.log('[dynamic:push] purged the CDN cache for the catalog');
  } else {
    console.warn(`[dynamic:push] could not purge the CDN cache: ${purge.reason}`);
    console.warn(`[dynamic:push] purge by hand: ${purge.manual.join(', ')}`);
  }
}

async function main(): Promise<void> {
  bucketName();
  if (command !== 'pull' && command !== 'push') {
    fail('usage: dynamic-sync.ts <pull|push> --target dev|prod [--dry-run] [--force] [--confirm]');
  }
  const target = parseTarget();
  if (command === 'pull') await pullCommand(target);
  else await pushCommand(target);
}

await main();
