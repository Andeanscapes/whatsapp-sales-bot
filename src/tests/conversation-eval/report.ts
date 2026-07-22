import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { EvalReport, ScenarioResult } from './schema.js';

const ARTIFACT_DIR = 'artifacts';

function bar(score: number): string {
  const filled = Math.round(score / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

export function printReport(report: EvalReport): void {
  console.log('\n' + '═'.repeat(104));
  console.log(`  V2 Mode: ${report.mode}  |  Average: ${report.suite.average}  |  Hard fails: ${report.suite.hardFails}`);
  console.log('═'.repeat(104));

  for (const result of report.scenarios) {
    console.log(` ${result.hardFail ? 'FAIL' : ' OK '}  ${result.id.padEnd(48).slice(0, 48)} ${String(result.score).padStart(3)} ${bar(result.score)}`);
    for (const criterion of result.criteria) {
      const status = criterion.passed ? 'PASS' : 'FAIL';
      console.log(`      ${status} ${criterion.id}: ${criterion.evidence}`);
    }
    if (result.runs && result.runs.total > 1) console.log(`      Runs: ${result.runs.passed}/${result.runs.total} passed`);
  }

  const cost = report.suite.costUsd === undefined ? '' : `  |  Cost: $${report.suite.costUsd.toFixed(4)} USD`;
  console.log('═'.repeat(104));
  console.log(`  Suite average: ${report.suite.average}  |  Hard fails: ${report.suite.hardFails}  |  Scenarios: ${report.suite.count}${cost}`);
  console.log('');
}

export function writeReport(report: EvalReport, filename: string): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const path = join(ARTIFACT_DIR, filename);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return path;
}

export function buildReport(mode: 'deterministic' | 'live', scenarios: ScenarioResult[], costUsd?: number): EvalReport {
  const scores = scenarios.map(scenario => scenario.score);
  return {
    version: 2,
    mode,
    gitSha: process.env.GITHUB_SHA ?? 'local',
    generatedAt: new Date().toISOString(),
    suite: {
      average: scores.length === 0 ? 0 : Math.round(scores.reduce((total, score) => total + score, 0) / scores.length),
      min: scores.length === 0 ? 0 : Math.min(...scores),
      count: scenarios.length,
      hardFails: scenarios.filter(scenario => scenario.hardFail).length,
      ...(costUsd === undefined ? {} : { costUsd }),
    },
    scenarios,
  };
}
