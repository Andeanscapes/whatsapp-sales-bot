/**
 * Pure helpers for the bot's media and catalog sync. No I/O here, so every rule
 * (URL -> bucket key, containment, upload eligibility, sync classification, push
 * and pull decisions, cross-site duplicate detection) is unit-tested in
 * `src/tests/catalog-media.test.ts`.
 *
 * Bucket layout: every object lives under `whatsapp_bot/` and is served from the
 * same path on `CDN_MEDIA_HOST`, so URL, bucket key and local cache path are one
 * string with a different prefix.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDN_MEDIA_HOST, isCdnMediaUrl } from '../../services/dynamic-data-schema.js';
import type { CdnRead, LocalFingerprint } from './cdn.js';
import { sameContent } from './cdn.js';

export const BOT_PREFIX = 'whatsapp_bot/';
export const CDN_ORIGIN = `https://${CDN_MEDIA_HOST}`;

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const CACHE_DIR = path.join(REPO_ROOT, 'r2-cache');
export const BASE_DIR = path.join(REPO_ROOT, 'scripts', '.dynamic-base');
export const PREVIOUS_DIR = path.join(REPO_ROOT, 'scripts', '.dynamic-previous');

/** Catalog files that publish to the CDN. `file` is local, `key` is the bucket key. */
export const CATALOG_TARGETS = {
  dev: { file: 'scripts/bot-dynamic-dev.json', key: `${BOT_PREFIX}bot-dynamic-dev.json` },
  prod: { file: 'scripts/bot-dynamic.json', key: `${BOT_PREFIX}bot-dynamic.json` },
} as const;

export type CatalogTarget = keyof typeof CATALOG_TARGETS;

/** Committed CI fixture. Read for media references only, never published. */
export const CI_FIXTURE = 'scripts/bot-dynamic.ci.json';

/** The configured bucket must be the one backing our fixed CDN read target. */
export function bucketName(): string {
  const bucket = process.env.R2_BUCKET?.trim() || 'andean-app-dev';
  if (bucket !== 'andean-app-dev') {
    throw new Error('R2_BUCKET must be andean-app-dev: CDN comparisons and backups use that bucket only.');
  }
  return bucket;
}

export function isCatalogTarget(value: string): value is CatalogTarget {
  return Object.hasOwn(CATALOG_TARGETS, value);
}

/** WhatsApp limits image messages and template headers to 5 MB. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

/** Bucket keys (`whatsapp_bot/...`) of every media URL found anywhere in a catalog. */
export function collectMediaKeys(catalog: unknown): Set<string> {
  const keys = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      const key = urlToKey(node);
      if (key) keys.add(key);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === 'object') {
      Object.values(node).forEach(visit);
    }
  };
  visit(catalog);
  return keys;
}

/** `https://cdn.../whatsapp_bot/a.jpg` -> `whatsapp_bot/a.jpg`. Null for anything else. */
export function urlToKey(url: string): string | null {
  if (!isCdnMediaUrl(url)) return null;
  const key = new URL(url).pathname.replace(/^\/+/, '');
  if (!key.startsWith(BOT_PREFIX) || key.includes('..')) return null;
  return key;
}

export function keyToUrl(key: string): string {
  return `${CDN_ORIGIN}/${key}`;
}

/**
 * Absolute cache path for a bucket key, or null when it would escape `cacheDir`.
 * Resolved before the containment check so `..` segments cannot slip through.
 */
export function cachePathFor(cacheDir: string, key: string): string | null {
  const root = path.resolve(cacheDir);
  const resolved = path.resolve(root, key);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

export function contentTypeFor(key: string): string | null {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? null;
}

/** Why a local file cannot be uploaded, or null when it can. */
export function uploadRejection(key: string, size: number): string | null {
  if (!contentTypeFor(key)) return 'extension is not jpg, jpeg or png';
  if (size > MAX_UPLOAD_BYTES) return `${size} bytes exceeds the 5 MB WhatsApp limit`;
  return null;
}

export function md5Of(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('hex');
}

export function fingerprintOf(bytes: Buffer): LocalFingerprint {
  return { size: bytes.byteLength, md5: md5Of(bytes) };
}

export type MediaVerdict = 'new' | 'current' | 'changed' | 'unreachable';

/** Compare one local file with what origin holds for its key. */
export function classifyMedia(local: LocalFingerprint, remote: CdnRead): MediaVerdict {
  if (remote.status === 'absent') return 'new';
  if (remote.status === 'unavailable') return 'unreachable';
  return sameContent(remote, local) ? 'current' : 'changed';
}

export type CatalogSyncAction =
  | 'in-sync'
  | 'push'
  | 'pull'
  | 'create'
  | 'conflict'
  | 'missing-live';

/**
 * Three-way classification of a catalog file.
 *
 * `base` is the live bytes the local copy was last synced from. Without it no
 * edit can be told apart from a live change, so a difference is a conflict and
 * only `--force` proceeds.
 */
export function classifyCatalogSync(input: {
  local: Buffer | null;
  live: Buffer | null;
  base: Buffer | null;
}): CatalogSyncAction {
  const { local, live, base } = input;
  if (local === null && live === null) return 'missing-live';
  if (local === null) return 'pull';
  if (live === null) return 'create';
  if (local.equals(live)) return 'in-sync';
  if (base === null) return 'conflict';

  const localEdited = !local.equals(base);
  const liveMoved = !live.equals(base);
  if (localEdited && liveMoved) return 'conflict';
  if (localEdited) return 'push';
  return liveMoved ? 'pull' : 'in-sync';
}

export type SyncDecision =
  | { kind: 'noop'; recordBase: boolean }
  | { kind: 'fail'; reason: string }
  | { kind: 'write' };

/**
 * What `dynamic:push` does for a classified catalog. `write` means upload.
 * An in-sync run records the base so a later edit classifies as a push, not a conflict.
 */
export function decideCatalogPush(input: {
  action: CatalogSyncAction;
  target: CatalogTarget;
  baseMissing: boolean;
  confirmed: boolean;
  dryRun: boolean;
}): SyncDecision {
  const { action, target, baseMissing, confirmed, dryRun } = input;
  const pullHint = `run \`npm run dynamic:pull -- --target ${target}\``;

  switch (action) {
    case 'in-sync':
      return { kind: 'noop', recordBase: true };
    case 'missing-live':
      return { kind: 'fail', reason: 'nothing to push.' };
    case 'conflict':
      return baseMissing
        ? { kind: 'fail', reason: `no sync record for ${target}. ${pullHint} on an unedited copy, or pass --force.` }
        : { kind: 'fail', reason: `live changed since your last sync. ${pullHint} and re-apply your edits, or pass --force.` };
    case 'pull':
      return { kind: 'fail', reason: `live changed since your last sync. ${pullHint}.` };
    case 'push':
    case 'create':
      if (target === 'prod' && !confirmed && !dryRun) {
        return { kind: 'fail', reason: 'prod push needs --confirm.' };
      }
      return { kind: 'write' };
  }
}

/** What `dynamic:pull` does for a classified catalog. `write` means overwrite the local file. */
export function decideCatalogPull(action: CatalogSyncAction): SyncDecision {
  switch (action) {
    case 'in-sync':
      return { kind: 'noop', recordBase: true };
    case 'missing-live':
    case 'create':
      return { kind: 'fail', reason: 'not published in the bucket.' };
    case 'push':
    case 'conflict':
      return { kind: 'fail', reason: 'refusing to overwrite local edits. Push them, or pass --force to discard them.' };
    case 'pull':
      return { kind: 'write' };
  }
}

/** `whatsapp_bot/media/<experience>/<site>/...` -> `<experience>/<site>`. Null outside that layout. */
export function siteScopeOf(key: string): string | null {
  const match = /^whatsapp_bot\/media\/([^/]+)\/([^/]+)\//.exec(key);
  return match && match[1] !== 'brand' ? `${match[1]}/${match[2]}` : null;
}

/**
 * Site-scoped keys whose bytes are identical to a key of ANOTHER site. That is a
 * placeholder (e.g. Chivor photos standing in for Coscuez), never real catalog
 * content, so it must not reach the committed fixture or prod.
 */
export function findCrossSiteDuplicates(
  entries: ReadonlyArray<{ key: string; md5: string }>,
): Array<{ key: string; duplicateOf: string }> {
  const firstByHash = new Map<string, { key: string; scope: string }>();
  const duplicates: Array<{ key: string; duplicateOf: string }> = [];

  for (const { key, md5 } of [...entries].sort((a, b) => a.key.localeCompare(b.key))) {
    const scope = siteScopeOf(key);
    if (!scope) continue;
    const first = firstByHash.get(md5);
    if (!first) {
      firstByHash.set(md5, { key, scope });
    } else if (first.scope !== scope) {
      duplicates.push({ key, duplicateOf: first.key });
    }
  }
  return duplicates;
}

export type MediaSyncAction = 'in-sync' | 'push' | 'pull' | 'conflict' | 'missing';

/**
 * Two-way classification of one media key by content hash. `base` is the md5
 * local and R2 last agreed on. Without a base, two different copies are a
 * conflict: neither side can be shown to be the newer one.
 *
 * A key missing locally is pulled (R2 deletions are not supported, so a local
 * delete restores the file); a key missing on R2 is pushed.
 */
export function classifyMediaSync(input: {
  local: string | null;
  remote: string | null;
  base: string | null;
}): MediaSyncAction {
  const { local, remote, base } = input;
  if (local === null && remote === null) return 'missing';
  if (local === remote) return 'in-sync';
  if (local === null) return 'pull';
  if (remote === null) return 'push';
  if (base === null) return 'conflict';

  const localEdited = local !== base;
  const remoteMoved = remote !== base;
  if (localEdited && remoteMoved) return 'conflict';
  return localEdited ? 'push' : 'pull';
}

/**
 * Formats dropped into `r2-cache/` that are converted to a WhatsApp-ready `.jpg`
 * at the same key. HEIC/HEIF come straight from iPhones; `.jpeg` is normalized
 * to `.jpg` so a photo has exactly one delivery key.
 */
export const IMAGE_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.heic', '.heif', '.jpeg', '.tif', '.tiff', '.webp']);

/** Sources sharp's prebuilt libvips cannot decode (no HEVC): decoded by `sips`/`ffmpeg` first. */
export const EXTERNAL_DECODE_EXTENSIONS: ReadonlySet<string> = new Set(['.heic', '.heif']);

/** Longest edge of a delivered gallery photo. WhatsApp downsizes larger images anyway. */
export const DELIVERY_MAX_EDGE = 1600;

/** A delivered `.jpg` above this is re-encoded even when within `DELIVERY_MAX_EDGE`. */
export const DELIVERY_MAX_JPEG_BYTES = 1024 * 1024;

export function isImageSource(key: string): boolean {
  return IMAGE_SOURCE_EXTENSIONS.has(path.extname(key).toLowerCase());
}

/** `a/01.heic` -> `a/01.jpg`. A delivery key is returned unchanged. */
export function deliveryKeyFor(key: string): string {
  const extension = path.extname(key);
  return isImageSource(key) ? `${key.slice(0, key.length - extension.length)}.jpg` : key;
}

/** Only delivery files are ever uploaded or compared with R2; sources stay local. */
export function isDeliveryKey(key: string): boolean {
  return contentTypeFor(key) !== null && !isImageSource(key);
}

/**
 * Sources whose `.jpg` is confirmed on R2 with these exact bytes and may be deleted.
 * A delivery key with two sources (`01.heic` + `01.tiff`) is ambiguous: both are
 * kept, because the published bytes came from only one of them.
 */
export function selectPrunableSources(
  sourceKeys: readonly string[],
  publishedDeliveryKeys: ReadonlySet<string>,
): string[] {
  const count = new Map<string, number>();
  for (const key of sourceKeys) count.set(deliveryKeyFor(key), (count.get(deliveryKeyFor(key)) ?? 0) + 1);
  return sourceKeys.filter(key => count.get(deliveryKeyFor(key)) === 1 && publishedDeliveryKeys.has(deliveryKeyFor(key)));
}
