/**
 * Two-way sync between `r2-cache/whatsapp_bot/**` and R2.
 *
 *   npm run media:sync                    # plan, then pull remote changes and push local ones
 *   npm run media:sync -- --dry-run       # plan only
 *   npm run media:sync -- --prefer-local  # resolve conflicts by uploading the local copy
 *   npm run media:sync -- --prefer-remote # resolve conflicts by downloading the R2 copy
 *   npm run media:sync -- --allow-orphan  # also upload files no catalog references
 *   npm run media:sync -- --keep-sources  # do not delete .heic/.jpeg/... after upload
 *
 * Step 1 is the optimizer (`lib/optimize-media.ts`): drop a `.heic`, `.jpeg`,
 * `.tiff` or `.webp` at the key you want and it becomes a mobile-sized,
 * metadata-stripped `.jpg` at that key; an oversized `.jpg` is re-encoded. Any
 * conversion failure stops the run before anything is transferred. Sources are
 * never uploaded, and are deleted only after their `.jpg` is confirmed on R2 with
 * the same bytes (this run's push, or already in sync).
 *
 * Keys considered: every file in the local mirror plus every key the dev, prod
 * and CI catalogs reference. Each one is classified by content hash against the
 * base manifest (`r2-cache/.sync-base.json`):
 *
 *   only local changed    -> push      only R2 changed      -> pull
 *   missing on R2         -> push      missing locally      -> pull
 *   both changed / no base and different -> conflict: nothing is transferred
 *                                           unless --prefer-local or --prefer-remote
 *
 * Every overwrite is backed up first to `r2-cache/.previous/<timestamp>/{local,remote}/`.
 * R2 object versioning is off, so that is the only undo. Deleting an object on R2 is not
 * supported: remove it from the catalog instead.
 *
 * The catalog JSON is not touched; publish it with `npm run dynamic:push` afterwards.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { downloadFromOrigin, purgeCache } from './lib/cdn.js';
import {
  CACHE_DIR,
  REPO_ROOT,
  bucketName,
  classifyMediaSync,
  keyToUrl,
  md5Of,
  selectPrunableSources,
  uploadRejection,
  type MediaSyncAction,
} from './lib/catalog-media.js';
import {
  backUpPublishedMedia,
  backupDir,
  catalogMediaKeys,
  localMediaKeys,
  localMediaMd5,
  readMediaBase,
  safeCachePath,
  remoteMediaMd5,
  uploadMedia,
  writeMediaBase,
} from './lib/media-r2.js';
import { listSourceKeys, optimizeMediaCache, reportOptimize, writeOptimizeBase } from './lib/optimize-media.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const preferLocal = argv.includes('--prefer-local');
const preferRemote = argv.includes('--prefer-remote');
const allowOrphan = argv.includes('--allow-orphan');
const keepSources = argv.includes('--keep-sources');

function fail(message: string): never {
  console.error(`[media:sync] ${message}`);
  process.exit(1);
}

function errorText(error: unknown): string {
  // First line only: a failed wrangler call carries its full argv and stderr.
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

interface Entry {
  key: string;
  local: string | null;
  remote: string | null;
  action: MediaSyncAction;
}

async function plan(keys: readonly string[]): Promise<Entry[]> {
  const base = readMediaBase();
  const entries: Entry[] = [];
  for (const key of keys) {
    const local = localMediaMd5(key);
    const remote = await remoteMediaMd5(key);
    entries.push({ key, local, remote, action: classifyMediaSync({ local, remote, base: base[key] ?? null }) });
  }
  return entries;
}

/** Download the R2 copy over the local one, backing the local copy up first. */
async function pull(entry: Entry, localBackup: string): Promise<string> {
  const location = safeCachePath(CACHE_DIR, entry.key);
  if (!location) throw new Error(`${entry.key} escapes r2-cache/ or is a symlink`);

  const download = await downloadFromOrigin(keyToUrl(entry.key));
  if (!download.ok) throw new Error(download.reason);
  const md5 = md5Of(download.body);
  if (md5 !== entry.remote) throw new Error('downloaded bytes do not match the R2 hash read moments ago');

  if (existsSync(location)) {
    const backup = path.join(localBackup, entry.key);
    mkdirSync(path.dirname(backup), { recursive: true });
    writeFileSync(backup, readFileSync(location));
  }
  mkdirSync(path.dirname(location), { recursive: true });
  writeFileSync(location, download.body);
  return md5;
}

/** Delete sources whose `.jpg` R2 now holds with identical bytes. Never fatal. */
function pruneSources(confirmed: ReadonlySet<string>): void {
  if (keepSources) return;
  const prunable = selectPrunableSources(listSourceKeys(), confirmed);
  for (const key of prunable) {
    const location = safeCachePath(CACHE_DIR, key);
    if (!location) continue;
    try {
      rmSync(location);
      writeOptimizeBase({ [key]: null });
      console.log(`  - ${key} (published as ${path.basename(key, path.extname(key))}.jpg, source removed)`);
    } catch (error) {
      console.warn(`[media:sync] could not remove ${key}: ${errorText(error)}`);
    }
  }
  const leftover = listSourceKeys().length;
  if (leftover > 0) console.log(`[media:sync] ${leftover} source file(s) kept (not yet confirmed on R2).`);
}

async function main(): Promise<void> {
  try {
    bucketName();
  } catch (error) {
    fail(errorText(error));
  }
  if (preferLocal && preferRemote) fail('pass only one of --prefer-local and --prefer-remote.');

  const optimized = await optimizeMediaCache({ dryRun });
  if (reportOptimize(optimized, 'media:sync') > 0) {
    fail('some photos could not be converted. Nothing was transferred.');
  }
  // Outputs this run converts or re-encodes. A dry run writes none of them, so the
  // plan below counts them as pushes instead of reading the unconverted files.
  const pendingOutputs = new Set(
    optimized.filter(result => result.action === 'converted' || result.action === 'reencoded').map(result => result.output),
  );

  const { keys: referenced, catalogsRead } = catalogMediaKeys();
  if (catalogsRead === 0) fail('no catalog in scripts/. Run `npm run dynamic:pull -- --target dev` first.');

  const local = dryRun ? [...new Set([...localMediaKeys(), ...pendingOutputs])].sort() : localMediaKeys();
  const orphans = local.filter((key) => !referenced.has(key));
  if (orphans.length > 0 && !allowOrphan) {
    console.error('[media:sync] no catalog references these local files:');
    orphans.forEach((key) => console.error(`  ✗ ${key}`));
    fail('nothing was transferred. Add them to the catalog first, or pass --allow-orphan.');
  }

  const keys = [...new Set([...local, ...referenced])].sort();
  console.log(`[media:sync] r2-cache/ <-> ${bucketName()} (${keys.length} key(s))`);

  let entries: Entry[];
  try {
    entries = await plan(keys);
  } catch (error) {
    fail(`could not read R2: ${errorText(error)}. Nothing was transferred.`);
  }

  const resolve = (entry: Entry): MediaSyncAction => {
    if (dryRun && pendingOutputs.has(entry.key) && entry.action !== 'conflict') return 'push';
    if (entry.action !== 'conflict') return entry.action;
    if (preferLocal) return 'push';
    if (preferRemote) return 'pull';
    return 'conflict';
  };

  const missing = entries.filter((entry) => resolve(entry) === 'missing');
  const conflicts = entries.filter((entry) => resolve(entry) === 'conflict');
  const pushes = entries.filter((entry) => resolve(entry) === 'push');
  const pulls = entries.filter((entry) => resolve(entry) === 'pull');
  const inSync = entries.filter((entry) => resolve(entry) === 'in-sync');

  pushes.forEach((entry) => console.log(
    `  ↑ ${entry.key}${entry.remote ? ' (replaces R2 copy)' : ''}${dryRun && pendingOutputs.has(entry.key) ? ' (after conversion)' : ''}`,
  ));
  pulls.forEach((entry) => console.log(`  ↓ ${entry.key}${entry.local ? ' (replaces local copy)' : ''}`));
  conflicts.forEach((entry) => console.error(`  ! ${entry.key}: changed locally AND on R2`));
  missing.forEach((entry) => console.error(`  ✗ ${entry.key}: referenced by a catalog, missing locally and on R2`));

  console.log(
    `[media:sync] ${pushes.length} to push, ${pulls.length} to pull, ${inSync.length} in sync, ` +
      `${conflicts.length} conflict(s), ${missing.length} missing` + (dryRun ? ' (dry run)' : ''),
  );

  if (conflicts.length > 0) {
    fail('nothing was transferred. Resolve with --prefer-local or --prefer-remote, or fix the files by hand.');
  }

  const rejections = pushes
    .filter((entry) => !(dryRun && pendingOutputs.has(entry.key)))
    .map((entry) => {
      const location = safeCachePath(CACHE_DIR, entry.key);
      return { key: entry.key, reason: location ? uploadRejection(entry.key, readFileSync(location).byteLength) : 'escapes r2-cache/' };
    })
    .filter((entry): entry is { key: string; reason: string } => entry.reason !== null);
  if (rejections.length > 0) {
    rejections.forEach(({ key, reason }) => console.error(`  ✗ ${key}: ${reason}`));
    fail('nothing was transferred.');
  }

  if (dryRun) {
    if (missing.length > 0) fail('catalogs reference media that exists nowhere.');
    return;
  }

  // Record keys that already agree, so the next run can tell edits from remote changes.
  writeMediaBase(Object.fromEntries(inSync.map((entry) => [entry.key, entry.local])));
  const confirmed = new Set(inSync.map((entry) => entry.key));
  if (pushes.length === 0 && pulls.length === 0) {
    pruneSources(confirmed);
    if (missing.length > 0) fail('catalogs reference media that exists nowhere.');
    console.log('[media:sync] already in sync.');
    return;
  }

  if (pushes.length > 0 && !existsSync(path.join(REPO_ROOT, '.env.wrangler'))) {
    fail('.env.wrangler is missing. Copy .env.wrangler.example and fill in the token. Nothing was transferred.');
  }

  const dir = backupDir();
  const overwrittenRemote = pushes.filter((entry) => entry.remote !== null).map((entry) => entry.key);
  try {
    const saved = await backUpPublishedMedia(overwrittenRemote, path.join(dir, 'remote'));
    if (saved > 0) console.log(`[media:sync] ${saved} R2 copy(ies) backed up to ${path.relative(REPO_ROOT, dir)}/remote/`);
  } catch (error) {
    fail(`${errorText(error)}. Nothing was transferred.`);
  }

  for (const entry of pulls) {
    try {
      const md5 = await pull(entry, path.join(dir, 'local'));
      writeMediaBase({ [entry.key]: md5 });
      console.log(`  ✓ ↓ ${entry.key}`);
    } catch (error) {
      fail(`pull of ${entry.key} failed: ${errorText(error)}. Re-run to finish.`);
    }
  }

  const uploaded: string[] = [];
  for (const entry of pushes) {
    try {
      uploadMedia(entry.key);
      writeMediaBase({ [entry.key]: entry.local });
      uploaded.push(entry.key);
      confirmed.add(entry.key);
      console.log(`  ✓ ↑ ${entry.key}`);
    } catch (error) {
      await purgeCache(uploaded.map(keyToUrl));
      fail(`push of ${entry.key} failed: ${errorText(error)}. Re-run to finish.`);
    }
  }

  const purge = await purgeCache(uploaded.map(keyToUrl));
  if (!purge.ok && uploaded.length > 0) {
    console.warn(`[media:sync] could not purge the CDN cache: ${purge.reason}. Purge by hand:`);
    purge.manual.forEach((url) => console.warn(`    ${url}`));
  }

  console.log(`[media:sync] ${uploaded.length} pushed, ${pulls.length} pulled.`);
  pruneSources(confirmed);
  if (missing.length > 0) fail('catalogs reference media that exists nowhere.');
  if (uploaded.length > 0) {
    console.log('[media:sync] if the catalog changed too, publish it: npm run dynamic:push -- --target dev');
  }
}

await main();
