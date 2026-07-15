import { readFileSync, existsSync } from 'fs';
import { evalReportSchema, type EvalReport } from '../tests/conversation-eval/schema.js';

function loadReport(path: string): EvalReport | null {
  if (!existsSync(path)) {
    console.error(`Baseline not found: ${path}`);
    return null;
  }
  const raw = readFileSync(path, 'utf8');
  try {
    return evalReportSchema.parse(JSON.parse(raw));
  } catch (e) {
    console.error(`Invalid report format in ${path}:`, (e as Error).message);
    return null;
  }
}

function main(): void {
  const args = process.argv.slice(2);

  const baselineArg = args.findIndex(a => a === '--baseline');
  const currentArg = args.findIndex(a => a === '--current');
  const minAvgArg = args.findIndex(a => a === '--min-average');
  const maxDropArg = args.findIndex(a => a === '--max-drop');

  const baselinePath = baselineArg !== -1 ? args[baselineArg + 1] : 'src/tests/conversation-eval/baselines/master-deterministic.json';
  const currentPath = currentArg !== -1 ? args[currentArg + 1] : 'artifacts/conversation-eval.json';
  const minAverage = Number(minAvgArg !== -1 ? args[minAvgArg + 1] : process.env.MIN_CONVERSATION_SCORE ?? 70);
  const maxDrop = Number(maxDropArg !== -1 ? args[maxDropArg + 1] : process.env.MAX_SCORE_DROP ?? 5);

  const baseline = loadReport(baselinePath);
  const current = loadReport(currentPath);

  if (!baseline || !current) {
    process.exit(2);
  }

  let failed = false;

  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  Conversation Eval Compare                                  │');
  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log(`│  Baseline: ${baselinePath.padEnd(50).slice(0, 50)} │`);
  console.log(`│  Current:  ${currentPath.padEnd(50).slice(0, 50)} │`);
  console.log('├─────────────────────────────────────────────────────────────┤');

  const baseMap = new Map(baseline.scenarios.map(s => [s.id, s]));
  const currMap = new Map(current.scenarios.map(s => [s.id, s]));

  const allIds = new Set([...baseMap.keys(), ...currMap.keys()]);
  const deltas: number[] = [];

  for (const id of [...allIds].sort()) {
    const b = baseMap.get(id);
    const c = currMap.get(id);

    if (!b) {
      console.log(`│  NEW    ${id.padEnd(45)} => ${String(c!.total).padStart(3)}`);
      continue;
    }
    if (!c) {
      console.log(`│  REMOVED ${id.padEnd(45)} <= ${String(b.total).padStart(3)}  DELETED`);
      failed = true;
      continue;
    }

    const delta = c.total - b.total;
    deltas.push(Math.abs(delta));

    const arrow = delta === 0 ? '  ' : delta > 0 ? '↑' : '↓';
    const color = delta < 0 && Math.abs(delta) > maxDrop ? 'DOWN' : delta < 0 ? 'down' : delta > 0 ? 'up  ' : 'ok  ';

    console.log(`│  ${color} ${arrow} ${id.padEnd(45)} ${String(b.total).padStart(3)} → ${String(c.total).padStart(3)}  ${delta > 0 ? '+' + delta : String(delta)}`);

    if (delta < 0 && Math.abs(delta) > maxDrop) {
      console.log(`│       WARNING: drop exceeds max-drop of ${maxDrop}`);
      failed = true;
    }
  }

  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log(`│  Baseline avg: ${String(baseline.suite.average).padStart(3)} → Current avg: ${String(current.suite.average).padStart(3)}  delta: ${current.suite.average - baseline.suite.average > 0 ? '+' : ''}${current.suite.average - baseline.suite.average}`);
  console.log(`│  Baseline fails: ${baseline.suite.hardFails} → Current fails: ${current.suite.hardFails}`);

  if (current.suite.average < minAverage) {
    console.log(`│  FAIL: average ${current.suite.average} below min ${minAverage}`);
    console.log('└─────────────────────────────────────────────────────────────┘\n');
    process.exit(1);
  }

  if (failed) {
    console.log('│  FAIL: some scenarios dropped beyond max-drop');
    console.log('└─────────────────────────────────────────────────────────────┘\n');
    process.exit(1);
  }

  console.log('│  PASS');
  console.log('└─────────────────────────────────────────────────────────────┘\n');
  process.exit(0);
}

main();
