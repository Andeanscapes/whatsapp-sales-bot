/**
 * Mirror every media object the bot catalogs reference into `r2-cache/`.
 *
 *   npm run media:pull
 *
 * Reads `scripts/bot-dynamic-dev.json`, `scripts/bot-dynamic.json` and the CI
 * fixture, then downloads each `whatsapp_bot/...` object from origin. Existing
 * files matching the origin hash are skipped. Differing local files are preserved;
 * --overwrite backs them up before replacement. A referenced object that origin reports
 * as 404 fails the run (the catalog points at media that is not published),
 * unless the file is already staged in `r2-cache/` waiting for `media:push`.
 */

import { CACHE_DIR } from './lib/catalog-media.js';
import { catalogMediaKeys, localMediaMd5, writeMediaBase } from './lib/media-r2.js';
import { pullMediaFile, type PullOutcome } from './lib/pull-media-file.js';

const overwrite = process.argv.includes('--overwrite');

function fail(message: string): never {
  console.error(`[media:pull] ${message}`);
  process.exit(1);
}

/** Every key referenced by the catalogs that exist on disk. */
function referencedKeys(): Set<string> {
  const { keys, catalogsRead } = catalogMediaKeys();
  if (catalogsRead === 0) fail('no catalog file found in scripts/. Run `npm run dynamic:pull` first.');
  return keys;
}

async function pull(key: string): Promise<PullOutcome> {
  try {
    return await pullMediaFile(CACHE_DIR, key, overwrite);
  } catch (error) {
    console.error(`[media:pull] ${key}: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}

async function main(): Promise<void> {
  const keys = Array.from(referencedKeys()).sort();
  console.log(`[media:pull] ${keys.length} object(s) referenced -> r2-cache/`);

  const counts: Record<PullOutcome, number> = { downloaded: 0, cached: 0, 'local-only': 0, preserved: 0, missing: 0, failed: 0 };
  const missing: string[] = [];

  for (const key of keys) {
    const outcome = await pull(key);
    counts[outcome] += 1;
    // Local now equals R2: record it so `media:sync` can tell later edits from remote changes.
    if (outcome === 'downloaded' || outcome === 'cached') writeMediaBase({ [key]: localMediaMd5(key) });
    if (outcome === 'downloaded') console.log(`  ✓ ${key}`);
    if (outcome === 'missing') {
      console.error(`  ✗ ${key}: 404, referenced by the catalog but not published`);
      missing.push(key);
    }
  }

  console.log(
    `[media:pull] ${counts.downloaded} downloaded, ${counts.cached} cached, ` +
      `${counts['local-only']} staged locally but not published (run \`npm run media:push\`)`,
  );
  if (counts.preserved > 0) {
    console.log(`[media:pull] ${counts.preserved} local replacement(s) preserved. --overwrite backs up and replaces them.`);
  }
  if (missing.length > 0 || counts.failed > 0) {
    fail(`FAILED: ${missing.length} missing, ${counts.failed} read error(s)`);
  }
}

await main();
