/**
 * Upload `r2-cache/whatsapp_bot/**` to the R2 bucket behind `cdn.andeanscapes.com`.
 *
 *   npm run media:push                 # plan, then upload what differs
 *   npm run media:push -- --dry-run    # plan only
 *   npm run media:push -- --force      # upload every file, skip the diff
 *   npm run media:push -- --allow-orphan   # also upload files no catalog references
 *
 * Runs the optimizer first (see `lib/optimize-media.ts`). Sources are not deleted
 * here; `media:sync` removes them once their `.jpg` is confirmed on R2.
 *
 * Safety rules, all checked before the first upload:
 *   - only jpg/jpeg/png up to 5 MB (WhatsApp limit)
 *   - every file must be referenced by a catalog, unless --allow-orphan
 *   - the diff is against origin (md5 from the ETag), not the edge cache
 *
 * A `changed` object is downloaded to `r2-cache/.previous/<timestamp>/<key>`
 * before it is overwritten. R2 object versioning is off, so that is the only undo.
 *
 * Uploads go through `wrangler r2 object put --remote`. `--remote` is required:
 * without it wrangler writes to a local Miniflare bucket and still reports success.
 * Credentials come from `.env.wrangler` (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 * optional CLOUDFLARE_ZONE_ID for the best-effort cache purge).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { purgeCache, readOriginLength, type LocalFingerprint } from './lib/cdn.js';
import {
  CACHE_DIR,
  REPO_ROOT,
  bucketName,
  classifyMedia,
  fingerprintOf,
  keyToUrl,
  uploadRejection,
  type MediaVerdict,
} from './lib/catalog-media.js';
import {
  backUpPublishedMedia,
  backupDir,
  catalogMediaKeys,
  localMediaKeys,
  uploadMedia,
  writeMediaBase,
} from './lib/media-r2.js';
import { optimizeMediaCache, reportOptimize } from './lib/optimize-media.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const force = argv.includes('--force');
const allowOrphan = argv.includes('--allow-orphan');

function fail(message: string): never {
  console.error(`[media:push] ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  try {
    bucketName();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  // Same first step as media:sync, so a dropped .heic is never silently ignored.
  if (reportOptimize(await optimizeMediaCache({ dryRun }), 'media:push') > 0) {
    fail('some photos could not be converted. Nothing was uploaded.');
  }
  const keys = localMediaKeys();
  if (keys.length === 0) {
    fail('r2-cache/whatsapp_bot/ is empty. Run `npm run media:pull` or add files first.');
  }

  const fingerprints = new Map<string, LocalFingerprint>(
    keys.map((key) => [key, fingerprintOf(readFileSync(path.join(CACHE_DIR, key)))]),
  );
  const fingerprint = (key: string): LocalFingerprint => fingerprints.get(key) ?? fail(`${key}: not read`);

  const rejections = keys
    .map((key) => ({ key, reason: uploadRejection(key, fingerprint(key).size) }))
    .filter((entry): entry is { key: string; reason: string } => entry.reason !== null);
  if (rejections.length > 0) {
    console.error('[media:push] these files cannot be uploaded:');
    rejections.forEach(({ key, reason }) => console.error(`  ✗ ${key}: ${reason}`));
    fail('nothing was uploaded.');
  }

  const referenced = catalogMediaKeys().keys;
  const orphans = keys.filter((key) => !referenced.has(key));
  if (orphans.length > 0 && !allowOrphan) {
    console.error('[media:push] no catalog references these files:');
    orphans.forEach((key) => console.error(`  ✗ ${key}`));
    fail('nothing was uploaded. Reference them in the catalog, or pass --allow-orphan.');
  }

  if (!dryRun && !existsSync(path.join(REPO_ROOT, '.env.wrangler'))) {
    fail('.env.wrangler is missing. Copy .env.wrangler.example and fill in the token.');
  }

  console.log(`[media:push] r2-cache/ -> ${bucketName()} (${keys.length} file(s))`);
  if (force) console.log('[media:push] --force: skipping the diff, every file will be uploaded.');

  const pending: Array<{ key: string; overwrites: boolean }> = [];
  const current: string[] = [];
  const verdicts: Record<MediaVerdict, number> = { new: 0, changed: 0, current: 0, unreachable: 0 };

  for (const key of keys) {
    const verdict: MediaVerdict = force
      ? 'changed'
      : classifyMedia(fingerprint(key), await readOriginLength(keyToUrl(key)));
    verdicts[verdict] += 1;

    if (verdict === 'unreachable') {
      console.error(`  ✗ ${key}: could not read the published object to compare`);
    } else if (verdict === 'current') {
      current.push(key);
    } else {
      console.log(`  ${verdict === 'new' ? '+' : '~'} ${key}${verdict === 'changed' ? ' (differs)' : ''}`);
      pending.push({ key, overwrites: verdict === 'changed' });
    }
  }

  if (verdicts.unreachable > 0) fail('could not compare some objects. Nothing was uploaded.');

  console.log(
    `[media:push] ${pending.length} to upload, ${verdicts.current} already current` +
      (dryRun ? ' (dry run)' : ''),
  );
  if (dryRun) return;
  // Identical on both sides: record it so `media:sync` can tell later edits from remote changes.
  writeMediaBase(Object.fromEntries(current.map((key) => [key, fingerprint(key).md5])));
  if (pending.length === 0) return;

  const overwritten = pending.filter((entry) => entry.overwrites).map((entry) => entry.key);
  if (overwritten.length > 0) {
    const dir = backupDir();
    try {
      if (await backUpPublishedMedia(overwritten, dir) > 0) {
        console.log(`[media:push] published copies backed up to ${path.relative(REPO_ROOT, dir)}/`);
      }
    } catch (error) {
      fail(`${error instanceof Error ? error.message : String(error)}. Nothing was uploaded.`);
    }
  }

  const uploaded: string[] = [];
  for (const { key } of pending) {
    try {
      uploadMedia(key);
      writeMediaBase({ [key]: fingerprint(key).md5 });
      uploaded.push(key);
      console.log(`  ✓ ${key}`);
    } catch (error) {
      // First line only: a failed wrangler call carries its full argv and stderr.
      console.error(`  ✗ ${key}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      const purge = await purgeCache(uploaded.map(keyToUrl));
      if (purge.ok) console.log(`[media:push] purged ${purge.count} URL(s) from the CDN cache`);
      fail(`stopped after ${uploaded.length} of ${pending.length} upload(s). Re-run to finish.`);
    }
  }

  const purge = await purgeCache(uploaded.map(keyToUrl));
  if (purge.ok) {
    console.log(`[media:push] purged ${purge.count} URL(s) from the CDN cache`);
  } else {
    console.warn(`[media:push] could not purge the CDN cache: ${purge.reason}`);
    console.warn('[media:push] purge these URLs by hand, or visitors keep the old image until the cache expires:');
    purge.manual.forEach((url) => console.warn(`    ${url}`));
  }
  console.log(`[media:push] ${uploaded.length} uploaded`);
}

await main();
