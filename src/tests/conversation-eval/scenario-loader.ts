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

export function partitionLiveScenarios(scenarios: Scenario[]): { supported: Scenario[]; skipped: Scenario[] } {
  return {
    supported: scenarios.filter(scenario => scenario.runner === 'message'),
    skipped: scenarios.filter(scenario => scenario.runner !== 'message'),
  };
}
