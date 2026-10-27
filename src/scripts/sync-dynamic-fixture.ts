import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dynamicDataSchema, assertDynamicCatalogReady } from '../services/dynamic-data-schema.js';
import { checkCrossSiteDuplicates, describeCrossSiteDuplicates } from './lib/media-guard.js';

export function syncDynamicFixture(source: string, destination: string | URL, cacheDir?: string): void {
  // Parsing strips private payment fields before anything reaches the tracked fixture.
  const catalog = dynamicDataSchema.parse(JSON.parse(readFileSync(source, 'utf8')) as unknown);
  assertDynamicCatalogReady(catalog);

  const crossSite = checkCrossSiteDuplicates(catalog, cacheDir);
  const placeholderFailure = describeCrossSiteDuplicates(crossSite);
  if (placeholderFailure) throw new Error(`[sync:fixture] ${placeholderFailure}`);
  if (crossSite.unverified.length > 0) {
    throw new Error(
      `[sync:fixture] ${crossSite.unverified.length} site photo(s) not in r2-cache/ could not be checked ` +
        'for placeholders. Run `npm run media:pull` first to check them.',
    );
  }
  if (catalog.referentAttribution) {
    for (const attribution of Object.values(catalog.referentAttribution.sources)) {
      attribution.sourceLabel = 'CI fixture';
    }
  }
  writeFileSync(destination, `${JSON.stringify(catalog, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.argv[2];
  if (!source) throw new Error('Usage: tsx src/scripts/sync-dynamic-fixture.ts <catalog.json>');
  syncDynamicFixture(source, new URL('../../scripts/bot-dynamic.ci.json', import.meta.url));
}
