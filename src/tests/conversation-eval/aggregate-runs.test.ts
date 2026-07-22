import { describe, expect, it } from 'vitest';
import { aggregateRuns } from './aggregate-runs.js';
import type { ScenarioResult } from './schema.js';

function result(score: number, hardFail: boolean): ScenarioResult {
  return { id: 'run', score, hardFail, notes: [], criteria: [], turnResults: [] };
}

describe('aggregateRuns', () => {
  it('preserves any critical failure even when a passing run scores lower', () => {
    const aggregated = aggregateRuns([result(80, true), result(20, false)]);
    expect(aggregated.hardFail).toBe(true);
    expect(aggregated.score).toBe(20);
    expect(aggregated.runs).toEqual({ total: 2, passed: 1 });
  });
});
