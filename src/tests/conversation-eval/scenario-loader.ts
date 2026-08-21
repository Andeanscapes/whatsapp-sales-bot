import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { scenarioSchema, type Scenario } from './schema.js';

const manifestSchema = z.object({
  totalTests: z.number().int().nonnegative(),
  scenarioIds: z.array(z.string().min(1)),
}).passthrough();

export function loadScenarios(scenariosDir: string): Scenario[] {
  const scenarios = readdirSync(scenariosDir)
    .filter(file => file.endsWith('.json') && file !== 'manifest.json')
    .sort()
    .map(file => scenarioSchema.parse(JSON.parse(readFileSync(join(scenariosDir, file), 'utf8'))));
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(scenariosDir, 'manifest.json'), 'utf8')));
  const actualIds = scenarios.map(scenario => scenario.id).sort();
  const expectedIds = [...manifest.scenarioIds].sort();

  if (new Set(actualIds).size !== actualIds.length) throw new Error('Conversation scenario IDs must be unique');
  if (manifest.totalTests !== scenarios.length) {
    throw new Error(`Conversation manifest totalTests=${manifest.totalTests}, scenario files=${scenarios.length}`);
  }
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    throw new Error('Conversation manifest scenarioIds do not match scenario files');
  }
  return scenarios;
}

export const LIVE_TAG = 'live';

export interface LivePartition {
  /** Scenarios that will actually be sent to the provider. */
  supported: Scenario[];
  /** Skipped because their runner cannot drive a real provider turn. */
  skipped: Scenario[];
  /** Message scenarios excluded because they are not part of the bounded live subset. */
  deselected: Scenario[];
}

/**
 * Live runs cost provider tokens, so only scenarios tagged `live` are sent by
 * default. Every scenario still runs for free in the deterministic suite.
 * `includeAll` opts into the full message set (explicit `--scenario` / `--all`).
 */
export function partitionLiveScenarios(scenarios: Scenario[], options?: { includeAll?: boolean }): LivePartition {
  const message = scenarios.filter(scenario => scenario.runner === 'message');
  const skipped = scenarios.filter(scenario => scenario.runner !== 'message');
  const tagged = message.filter(scenario => scenario.tags?.includes(LIVE_TAG));

  if (options?.includeAll || tagged.length === 0) {
    return { supported: message, skipped, deselected: [] };
  }
  return {
    supported: tagged,
    skipped,
    deselected: message.filter(scenario => !scenario.tags?.includes(LIVE_TAG)),
  };
}
