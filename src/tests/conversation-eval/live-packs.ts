import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const packsSchema = z.record(z.string().min(1), z.object({
  scenarioIds: z.array(z.string().min(1)).min(1),
}).strict());

const PACKS_PATH = join(fileURLToPath(new URL('.', import.meta.url)), 'live-packs.json');

/** Named live subsets sent to the paid provider. Both languages share the same IDs. */
export function loadLivePackIds(name: string): string[] {
  const packs = packsSchema.parse(JSON.parse(readFileSync(PACKS_PATH, 'utf8')));
  const pack = packs[name];
  if (!pack) throw new Error(`Unknown live pack: ${name}`);
  if (new Set(pack.scenarioIds).size !== pack.scenarioIds.length) throw new Error(`Live pack ${name} has duplicate scenario IDs`);
  return pack.scenarioIds;
}
