/**
 * Shared I/O for the media commands (`media:pull`, `media:push`, `media:sync`):
 * local mirror listing, catalog references, R2 upload, remote hashing, backups
 * and the sync base manifest.
 *
 * The base manifest (`r2-cache/.sync-base.json`) records, per key, the md5 that
 * local and R2 last agreed on. `media:sync` uses it to tell a local edit from a
 * remote change, the same way `dynamic:*` uses `scripts/.dynamic-base/`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BOT_PREFIX,
  CACHE_DIR,
  CATALOG_TARGETS,
  CI_FIXTURE,
  REPO_ROOT,
  bucketName,
  cachePathFor,
  collectMediaKeys,
  contentTypeFor,
  isImageSource,
  keyToUrl,
  md5Of,
} from './catalog-media.js';
import { downloadFromOrigin, readOriginLength } from './cdn.js';

const BASE_FILE = '.sync-base.json';
const baseSchema = z.record(z.string(), z.string().regex(/^[0-9a-f]{32}$/));

export type MediaBase = Record<string, string>;

/**
 * Cache path for `key`, or null when it escapes `cacheDir` or any component below
 * `cacheDir` is a symlink. A link in the cache could otherwise publish a file from
 * anywhere on disk to the public CDN, or make a pull write outside the cache.
 */
export function safeCachePath(cacheDir: string, key: string): string | null {
  const location = cachePathFor(cacheDir, key);
  if (!location) return null;
  const root = path.resolve(cacheDir);
  for (let current = location; current !== root; current = path.dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
  }
  return location;
}

/** Delivery files under `<cacheDir>/whatsapp_bot/`, as bucket keys. Hidden entries, symlinks and sources are ignored. */
export function localMediaKeys(cacheDir = CACHE_DIR): string[] {
  const keys: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) keys.push(path.relative(cacheDir, absolute).split(path.sep).join('/'));
    }
  };
  const root = path.join(cacheDir, BOT_PREFIX);
  if (existsSync(root)) walk(root);
  // Sources (.heic, .jpeg…) are inputs to the optimizer, never uploaded or compared.
  return keys.filter(key => !isImageSource(key)).sort();
}

/** Keys referenced by the dev, prod and CI catalogs present on disk, plus how many were read. */
export function catalogMediaKeys(): { keys: Set<string>; catalogsRead: number } {
  const keys = new Set<string>();
  let catalogsRead = 0;
  for (const file of [...Object.values(CATALOG_TARGETS).map((target) => target.file), CI_FIXTURE]) {
    const location = path.join(REPO_ROOT, file);
    if (!existsSync(location)) continue;
    catalogsRead += 1;
    collectMediaKeys(JSON.parse(readFileSync(location, 'utf8')) as unknown).forEach((key) => keys.add(key));
  }
  return { keys, catalogsRead };
}

/** Upload one cached file. `--remote` is required: without it wrangler writes to a local Miniflare bucket. */
export function uploadMedia(key: string, cacheDir = CACHE_DIR): void {
  const file = safeCachePath(cacheDir, key);
  if (!file) throw new Error(`Media key escapes the cache or is a symlink: ${key}`);
  // Never resolve a missing binary from the registry: this runs with R2 credentials loaded.
  execFileSync(
    'npx',
    [
      '--no-install', 'dotenv', '-e', '.env.wrangler', '--',
      'wrangler', 'r2', 'object', 'put', `${bucketName()}/${key}`,
      '--file', file,
      '--content-type', contentTypeFor(key) ?? 'application/octet-stream',
      '--remote',
    ],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
}

/**
 * md5 of the object R2 holds for `key`, or null when absent. Uses the ETag when
 * it is a content hash; otherwise downloads and hashes. Unreadable throws.
 */
export async function remoteMediaMd5(key: string): Promise<string | null> {
  const remote = await readOriginLength(keyToUrl(key));
  if (remote.status === 'absent') return null;
  if (remote.status === 'unavailable') throw new Error(`${key}: ${remote.reason}`);
  if (remote.md5) return remote.md5;

  const download = await downloadFromOrigin(keyToUrl(key));
  if (!download.ok) throw new Error(`${key}: ${download.reason}`);
  return md5Of(download.body);
}

/** A fresh `<cacheDir>/.previous/<timestamp>/` directory name. */
export function backupDir(cacheDir = CACHE_DIR): string {
  return path.join(cacheDir, '.previous', new Date().toISOString().replace(/[:.]/g, '-'));
}

/** Download each published object into `<dir>/<key>`. Absent objects are skipped. Any failure throws. */
export async function backUpPublishedMedia(keys: readonly string[], dir: string): Promise<number> {
  let saved = 0;
  for (const key of keys) {
    const probe = await readOriginLength(keyToUrl(key));
    if (probe.status === 'absent') continue;
    if (probe.status === 'unavailable') throw new Error(`could not back up ${key}: ${probe.reason}`);

    const download = await downloadFromOrigin(keyToUrl(key));
    if (!download.ok) throw new Error(`could not back up ${key}: ${download.reason}`);

    const destination = path.join(dir, key);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, download.body);
    saved += 1;
  }
  return saved;
}

export function readMediaBase(cacheDir = CACHE_DIR): MediaBase {
  const location = path.join(cacheDir, BASE_FILE);
  if (!existsSync(location)) return {};
  const parsed = baseSchema.safeParse(JSON.parse(readFileSync(location, 'utf8')) as unknown);
  if (!parsed.success) throw new Error(`${BASE_FILE} is corrupt. Delete it; the next sync treats differences as conflicts.`);
  return parsed.data;
}

/** Merge `updates` into the manifest. Keys mapped to null are removed. */
export function writeMediaBase(updates: Record<string, string | null>, cacheDir = CACHE_DIR): void {
  const next: MediaBase = { ...readMediaBase(cacheDir) };
  for (const [key, md5] of Object.entries(updates)) {
    if (md5 === null) delete next[key];
    else next[key] = md5;
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, BASE_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** md5 of the cached file for `key`, or null when it does not exist. */
export function localMediaMd5(key: string, cacheDir = CACHE_DIR): string | null {
  const location = safeCachePath(cacheDir, key);
  if (!location) throw new Error(`Media key escapes the cache or is a symlink: ${key}`);
  return existsSync(location) ? md5Of(readFileSync(location)) : null;
}
