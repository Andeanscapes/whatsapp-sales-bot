import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLivePackIds } from './conversation-eval/live-packs.js';
import type { EvalReport } from './conversation-eval/schema.js';

// The paid CI gate runs `compare --pack pr --require-complete`. These pin what fails it.
const BASELINE = 'src/tests/conversation-eval/baselines/master-llm-bot.json';
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as EvalReport;
const packIds = loadLivePackIds('pr');
const template = baseline.scenarios[0];
const clean = (id: string, score = 100): EvalReport['scenarios'][number] => ({ ...template, id, score, hardFail: false, notes: [] });

function compare(scenarios: EvalReport['scenarios'], pack = 'pr') {
  const report: EvalReport = {
    ...baseline,
    scenarios,
    suite: { ...baseline.suite, average: 50, count: scenarios.length, hardFails: scenarios.filter(s => s.hardFail).length },
  };
  // Match CI's file input; Linux cannot reopen spawnSync's stdin via /dev/stdin.
  const dir = mkdtempSync(join(tmpdir(), 'compare-conversation-eval-'));
  try {
    const current = join(dir, 'current.json');
    writeFileSync(current, JSON.stringify(report));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/compare-conversation-eval.ts',
      '--baseline', BASELINE, '--current', current, '--min-average', '90', '--max-drop', '8', '--pack', pack, '--require-complete'],
    { encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('compare-conversation-eval --pack', () => {
  const full = packIds.map(id => clean(id));

  it('passes a complete pack and ignores scenarios outside it (score and hard fail)', () => {
    const outside = { ...clean('outside-pack', 0), hardFail: true };
    const { status, stdout, stderr } = compare([...full, outside]);
    expect(status, stderr).toBe(0);
    expect(stdout).toMatch(/-> 100; hard fails 0/);
  });

  it('fails when a pack scenario is missing from the report', () => {
    const { status, stdout, stderr } = compare(full.slice(1));
    expect(status, stderr).toBe(1);
    expect(stdout).toContain(`MISSING ${packIds[0]}`);
  });

  it('fails on a hard fail inside the pack', () => {
    const { status, stderr } = compare([{ ...full[0], hardFail: true }, ...full.slice(1)]);
    expect(status, stderr).toBe(1);
  });

  it('warns, but does not fail, on pack scenarios with no baseline', () => {
    const noBaseline = packIds.filter(id => !baseline.scenarios.some(s => s.id === id));
    const { status, stdout, stderr } = compare(full);
    expect(status, stderr).toBe(0);
    if (noBaseline.length > 0) expect(stdout).toContain(`WARNING no baseline for ${noBaseline.length} pack scenario(s)`);
  });

  it('fails on an unknown pack name', () => {
    const { status, stderr } = compare(full, 'no-such-pack');
    expect(status, stderr).toBe(2);
    expect(stderr).toContain('no-such-pack');
  });
});
