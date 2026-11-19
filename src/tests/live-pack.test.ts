import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';
import { loadScenarios, partitionLiveScenarios } from './conversation-eval/scenario-loader.js';
import { loadLivePackIds } from './conversation-eval/live-packs.js';
import type { Scenario } from './conversation-eval/schema.js';

const ES_DIR = fileURLToPath(new URL('./conversation-eval/scenarios', import.meta.url));
const EN_DIR = fileURLToPath(new URL('./conversation-eval/scenarios-en', import.meta.url));
const PR_TURN_BUDGET = 135;
// Spanish CI regressions from 2026-11-18 (run 44330324141). Remove an ID only after its
// failure is diagnosed and covered by another pack scenario.
const PREVIOUSLY_FAILING_IN_CI = [
  'ad-opener-price-asked-solo',
  'two-destinations-group-first',
  'pickup-bogota-assumed',
  'two-doubts-then-cupo-offer',
];

function liveTurns(scenarios: Scenario[]): number {
  return scenarios.reduce((total, scenario) => total + scenario.turns.filter(turn => !turn.replay).length * scenario.liveRuns, 0);
}

describe('PR live pack', () => {
  const ids = loadLivePackIds('pr');
  const es = loadScenarios(ES_DIR);
  const en = loadScenarios(EN_DIR);

  it('has unique IDs shared by both language packs', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(es.filter(scenario => ids.includes(scenario.id)).map(scenario => scenario.id).sort())
      .toEqual([...ids].sort());
    expect(en.filter(scenario => ids.includes(scenario.id)).map(scenario => scenario.id).sort())
      .toEqual([...ids].sort());
  });

  it('keeps every pack scenario a live message scenario', () => {
    for (const scenarios of [es, en]) {
      const selected = scenarios.filter(scenario => ids.includes(scenario.id));
      const { supported, deselected } = partitionLiveScenarios(selected);
      expect(supported).toHaveLength(ids.length);
      expect(deselected).toHaveLength(0);
    }
  });

  it('keeps the scenarios that failed in the last Spanish CI run', () => {
    for (const id of PREVIOUSLY_FAILING_IN_CI) expect(ids).toContain(id);
  });

  it('stays within the paid turn budget in each language', () => {
    for (const scenarios of [es, en]) {
      const selected = scenarios.filter(scenario => ids.includes(scenario.id));
      expect(liveTurns(selected)).toBeLessThanOrEqual(PR_TURN_BUDGET);
    }
  });
});
