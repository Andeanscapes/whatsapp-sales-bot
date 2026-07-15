import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { EvalReport, ScenarioResult } from './schema.js';

const ARTIFACT_DIR = 'artifacts';
const MAX_LINE_LENGTH = 80;

function bar(score: number): string {
  const filled = Math.round(score / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function pad(s: string, len: number): string {
  return s.padEnd(len).slice(0, len);
}

export function printReport(report: EvalReport): void {
  const dims = ['qualification', 'salesStrategy', 'closeStrategy', 'safety', 'mediaGuards'] as const;
  const colWidth = 50;

  const liveApproved = report.scenarios.filter(s => s.llmJudge?.approved === true).length;
  const liveRejected = report.scenarios.filter(s => s.llmJudge?.approved === false).length;
  const judgeInfo = report.mode === 'live' ? `  |  LLM approved: ${liveApproved}  |  LLM rejected: ${liveRejected}` : '';

  console.log('\n' + '═'.repeat(colWidth + 12 * (dims.length + 2)));
  console.log(`  Mode: ${report.mode}  |  Average: ${report.suite.average}  |  Hard fails: ${report.suite.hardFails}${judgeInfo}`);
  console.log('═'.repeat(colWidth + 12 * (dims.length + 2)));

  for (const r of report.scenarios) {
    const llmVerdict = r.llmJudge
      ? (r.llmJudge.approved ? ' [LLM: APPROVE]' : ' [LLM: REJECT]')
      : '';
    const flag = r.hardFail ? ' FAIL' : ' OK ';
    const total = `${r.total}`.padStart(3);
    console.log(` ${flag}  ${pad(r.id, colWidth - 18)}${dims.map(d => `${d.slice(0, 3)} ${String(r.scores[d]).padStart(3)} ${bar(r.scores[d])}`).join('  ')}  => ${total}${llmVerdict}`);

    for (const note of r.notes) {
      const truncated = note.length > MAX_LINE_LENGTH ? note.slice(0, MAX_LINE_LENGTH - 3) + '...' : note;
      console.log(`      └─ ${truncated}`);
    }
    if (r.llmJudge?.recommendations) {
      console.log(`      ┌─ LLM recommends: ${r.llmJudge.recommendations.slice(0, MAX_LINE_LENGTH)}`);
    }
  }

  console.log('═'.repeat(colWidth + 12 * (dims.length + 2)));
  const costLine = report.suite.costUsd != null ? `  |  Cost: $${report.suite.costUsd.toFixed(4)} USD` : '';
  const tokenLine = report.suite.totalTokens != null ? `  |  Tokens: ${report.suite.totalTokens}` : '';
  console.log(`  Suite average: ${report.suite.average}  |  Hard fails: ${report.suite.hardFails}  |  Scenarios: ${report.suite.count}${costLine}${tokenLine}`);
  console.log('');
}

export function writeReport(report: EvalReport, filename?: string): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const path = join(ARTIFACT_DIR, filename ?? 'conversation-eval.json');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return path;
}

export function buildReport(
  mode: 'deterministic' | 'live',
  results: ScenarioResult[],
  costUsd?: number,
  totalTokens?: number,
): EvalReport {
  const scores = results.map(r => r.total);
  const average = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;
  const min = scores.length > 0 ? Math.min(...scores) : 0;
  const hardFails = results.filter(r => r.hardFail).length;

  return {
    mode,
    gitSha: process.env.GITHUB_SHA ?? 'local',
    generatedAt: new Date().toISOString(),
    suite: {
      average,
      min,
      count: results.length,
      hardFails,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    },
    scenarios: results,
  };
}
