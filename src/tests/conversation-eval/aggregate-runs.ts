import type { ScenarioResult } from './schema.js';

export function aggregateRuns(results: ScenarioResult[]): ScenarioResult {
  if (results.length === 0) throw new Error('Cannot aggregate zero runs');
  const failed = results.filter(result => result.hardFail);
  const worst = results.reduce((current, candidate) => candidate.score < current.score ? candidate : current);
  const representative = failed.length > 0
    ? failed.reduce((current, candidate) => candidate.score < current.score ? candidate : current)
    : worst;
  return {
    ...representative,
    score: worst.score,
    hardFail: failed.length > 0,
    runs: { total: results.length, passed: results.length - failed.length },
  };
}
