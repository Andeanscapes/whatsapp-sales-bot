import { existsSync, readFileSync } from 'fs';
import { evalReportSchema, type EvalReport } from '../tests/conversation-eval/schema.js';

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function load(path: string): EvalReport {
  if (!existsSync(path)) throw new Error(`Baseline not found: ${path}`);
  return evalReportSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function main(): void {
  const baselinePath = option('--baseline', 'src/tests/conversation-eval/baselines/master-deterministic.json');
  const currentPath = option('--current', 'artifacts/conversation-eval.json');
  const baseline = load(baselinePath);
  const current = load(currentPath);
  const minAverage = Number(option('--min-average', process.env.MIN_CONVERSATION_SCORE ?? '70'));
  const maxDrop = Number(option('--max-drop', process.env.MAX_SCORE_DROP ?? '5'));
  const baselineMap = new Map(baseline.scenarios.map(scenario => [scenario.id, scenario]));
  const currentMap = new Map(current.scenarios.map(scenario => [scenario.id, scenario]));
  let failed = current.suite.hardFails > 0;

  console.log('\nConversation Eval V2 Compare');
  for (const id of [...new Set([...baselineMap.keys(), ...currentMap.keys()])].sort()) {
    const before = baselineMap.get(id);
    const after = currentMap.get(id);
    if (!before) {
      console.log(`NEW     ${id} ${after!.score}`);
      if (after!.hardFail || after!.score < 100) failed = true;
      continue;
    }
    if (!after) {
      console.log(`REMOVED ${id}`);
      failed = true;
      continue;
    }
    const state = after.hardFail ? 'FAIL' : after.score >= before.score ? 'PASS' : 'DOWN';
    console.log(`${state.padEnd(7)} ${id} ${before.score} -> ${after.score}`);
    if (after.hardFail || before.score - after.score > maxDrop) failed = true;
  }

  console.log(`Average ${baseline.suite.average} -> ${current.suite.average}; hard fails ${current.suite.hardFails}`);
  if (current.suite.average < minAverage) failed = true;
  if (failed) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}
