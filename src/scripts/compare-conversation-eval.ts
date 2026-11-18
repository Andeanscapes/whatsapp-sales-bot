import { existsSync, readFileSync } from 'fs';
import { evalReportSchema, type EvalReport } from '../tests/conversation-eval/schema.js';
import { loadLivePackIds } from '../tests/conversation-eval/live-packs.js';

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function load(path: string): EvalReport {
  if (!existsSync(path)) throw new Error(`Evaluation report not found: ${path}`);
  return evalReportSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function main(): void {
  const baselinePath = option('--baseline', 'src/tests/conversation-eval/baselines/master-deterministic.json');
  const currentPath = option('--current', 'artifacts/conversation-eval.json');
  const baseline = load(baselinePath);
  const current = load(currentPath);
  const minAverage = Number(option('--min-average', process.env.MIN_CONVERSATION_SCORE ?? '90'));
  const maxDrop = Number(option('--max-drop', process.env.MAX_SCORE_DROP ?? '5'));
  // --pack <name> limits both sides to that live pack; with --require-complete every pack ID must be reported.
  const packName = option('--pack', '');
  const packIds = packName ? new Set(loadLivePackIds(packName)) : null;
  const inPack = (id: string): boolean => !packIds || packIds.has(id);
  const baselineMap = new Map(baseline.scenarios.filter(scenario => inPack(scenario.id)).map(scenario => [scenario.id, scenario]));
  const currentMap = new Map(current.scenarios.filter(scenario => inPack(scenario.id)).map(scenario => [scenario.id, scenario]));
  const requireComplete = process.argv.includes('--require-complete');
  const missingPackIds = packIds ? [...packIds].filter(id => !current.scenarios.some(scenario => scenario.id === id)) : [];
  if (missingPackIds.length > 0) console.log(`MISSING ${missingPackIds.join(', ')}`);
  // Warning only: a scenario new to the pack has no score to drop from until the baseline is refreshed.
  const noBaselineIds = packIds ? [...packIds].filter(id => !baselineMap.has(id)) : [];
  if (noBaselineIds.length > 0) console.log(`WARNING no baseline for ${noBaselineIds.length} pack scenario(s), drops not checked: ${noBaselineIds.join(', ')}`);
  // Duplicates are checked on the whole report; hard fails only inside the compared set (the pack, if any).
  const duplicateIds = new Set(current.scenarios.map(scenario => scenario.id)).size !== current.scenarios.length;
  const comparedHardFail = [...currentMap.values()].some(scenario => scenario.hardFail)
    || (!packIds && current.suite.hardFails > 0);
  let failed = requireComplete && (
    current.scenarios.length === 0 || current.suite.count !== current.scenarios.length
    || duplicateIds || comparedHardFail || missingPackIds.length > 0
  );

  console.log('\nConversation Eval V2 Compare');
  for (const id of [...new Set([...baselineMap.keys(), ...currentMap.keys()])].sort()) {
    const before = baselineMap.get(id);
    const after = currentMap.get(id);
    const retried = after?.retries ? ` (retried ${after.retries}x)` : '';
    if (!before) {
      if (!after) continue;
      const state = after.hardFail ? 'NEW-FAIL' : 'NEW';
      console.log(`${state.padEnd(7)} ${id} ${after.score}${retried}`);
      continue;
    }
    if (!after) {
      console.log(`REMOVED ${id}`);
      if (requireComplete) failed = true;
      continue;
    }
    const state = after.hardFail ? 'FAIL' : after.score >= before.score ? 'PASS' : 'DOWN';
    console.log(`${state.padEnd(7)} ${id} ${before.score} -> ${after.score}${retried}`);
    if (before.score - after.score > maxDrop) failed = true;
  }

  // With --pack both sides are averaged over the pack only, so a full-suite report compares like for like.
  const average = (scores: number[]): number => Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  const baselineScores = [...baselineMap.values()].map(scenario => scenario.score);
  const currentScores = [...currentMap.values()].map(scenario => scenario.score);
  const baselineAverage = packIds && baselineScores.length > 0 ? average(baselineScores) : baseline.suite.average;
  const currentAverage = packIds && currentScores.length > 0 ? average(currentScores) : current.suite.average;
  const hardFails = packIds ? [...currentMap.values()].filter(scenario => scenario.hardFail).length : current.suite.hardFails;
  console.log(`Average ${baselineAverage} -> ${currentAverage}; hard fails ${hardFails}`);
  if (current.suite.count === 0) {
    console.log('No scenarios in current run — average gate skipped');
  } else if (currentAverage < minAverage) {
    failed = true;
  }
  if (failed) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}
