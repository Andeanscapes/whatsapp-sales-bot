/**
 * One-off, idempotent move from the flat legacy media layout to the per-site,
 * per-plan layout in `lib/media-layout.ts`.
 *
 *   npm run media:restructure -- --dry-run
 *   npm run media:restructure
 *
 * What it does, for dev, prod and the CI fixture:
 *   1. rewrites each mapped `url` in the catalog (owner photo, gallery items by
 *      their `type`, plan cards by tier). Captions, ids and order are untouched.
 *   2. verifies that, with every `url` blanked, the catalog is byte-for-byte the
 *      same as before. A mismatch aborts before anything is written.
 *   3. moves the matching local files in `r2-cache/` to their new keys, so
 *      `media:push` sees the new layout and not orphans.
 *
 * It does not upload and does not touch R2. Old objects stay on the CDN, so
 * conversations that reference old URLs keep working.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CACHE_DIR,
  CATALOG_TARGETS,
  CI_FIXTURE,
  REPO_ROOT,
  keyToUrl,
  urlToKey,
} from './lib/catalog-media.js';
import { safeCachePath } from './lib/media-r2.js';
import {
  LEGACY_OWNER_KEY,
  OWNER_KEY,
  galleryKey,
  legacyPlanCardTier,
  planCardKey,
} from './lib/media-layout.js';

const dryRun = process.argv.includes('--dry-run');

type Json = Record<string, unknown>;

/** Catalog ids become key segments; anything else (`..`, `/`) is left unmapped. */
const KEY_SEGMENT = /^[a-z0-9_-]+$/i;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  console.error(`[media:restructure] ${message}`);
  process.exit(1);
}

interface Rewrite {
  legacyKey: string;
  newKey: string;
}

/**
 * Returns a rewritten copy of `catalog` and the key moves it implies. Pure: nothing
 * is written here, so the caller can verify before touching disk.
 */
export function restructureCatalog(catalog: Json): { catalog: Json; rewrites: Rewrite[]; unmapped: string[] } {
  const next = structuredClone(catalog);
  const rewrites: Rewrite[] = [];
  const unmapped: string[] = [];

  const swap = (image: Json, newKey: string | null, legacyKey: string): void => {
    if (!newKey) {
      unmapped.push(legacyKey);
      return;
    }
    if (newKey === legacyKey) return;
    image.url = keyToUrl(newKey);
    rewrites.push({ legacyKey, newKey });
  };

  const media = isRecord(next.media) ? next.media : null;
  const ownerImage = media && isRecord(media.ownerImage) ? media.ownerImage : null;
  const ownerKey = ownerImage && typeof ownerImage.url === 'string' ? urlToKey(ownerImage.url) : null;
  if (ownerImage && ownerKey === LEGACY_OWNER_KEY) swap(ownerImage, OWNER_KEY, LEGACY_OWNER_KEY);

  const experiences = isRecord(next.experiences) ? next.experiences : {};
  for (const [experienceId, experience] of Object.entries(experiences)) {
    if (!isRecord(experience) || !isRecord(experience.sites)) continue;

    for (const [siteId, site] of Object.entries(experience.sites)) {
      if (!isRecord(site)) continue;

      const siteMedia = isRecord(site.media) ? site.media : null;
      const gallery = siteMedia && Array.isArray(siteMedia.gallery) ? siteMedia.gallery : [];
      for (const item of gallery) {
        if (!isRecord(item) || typeof item.url !== 'string') continue;
        const legacyKey = urlToKey(item.url);
        if (!legacyKey) continue;
        const type = typeof item.type === 'string' ? item.type : null;
        const safe = type !== null && [experienceId, siteId, type].every((segment) => KEY_SEGMENT.test(segment));
        swap(item, safe ? galleryKey(experienceId, siteId, type, legacyKey) : null, legacyKey);
      }

      if (!isRecord(site.plans)) continue;
      for (const plan of Object.values(site.plans)) {
        if (!isRecord(plan) || !isRecord(plan.media) || !Array.isArray(plan.media.planImages)) continue;
        for (const image of plan.media.planImages) {
          if (!isRecord(image) || typeof image.url !== 'string') continue;
          const legacyKey = urlToKey(image.url);
          if (!legacyKey) continue;
          const tier = legacyPlanCardTier(legacyKey, siteId);
          if (tier && KEY_SEGMENT.test(experienceId)) swap(image, planCardKey(experienceId, siteId, tier), legacyKey);
        }
      }
    }
  }

  return { catalog: next, rewrites, unmapped };
}

/** Catalog with every `url` blanked: the part a restructure must not change. */
function withoutUrls(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutUrls);
  if (isRecord(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, key === 'url' ? '' : withoutUrls(value)]),
    );
  }
  return node;
}

function assertOnlyUrlsChanged(before: Json, after: Json, file: string): void {
  if (JSON.stringify(withoutUrls(before)) !== JSON.stringify(withoutUrls(after))) {
    fail(`${file}: a non-url field would change. Nothing was written.`);
  }
}

function main(): void {
  const targets = [...Object.values(CATALOG_TARGETS).map((target) => target.file), CI_FIXTURE];
  const moves = new Map<string, string>();
  const plans: { file: string; text: string; json: Json; rewrites: number }[] = [];
  const unmapped = new Set<string>();

  for (const file of targets) {
    const location = path.join(REPO_ROOT, file);
    if (!existsSync(location)) {
      console.log(`[media:restructure] ${file}: not found, skipped`);
      continue;
    }

    const text = readFileSync(location, 'utf8');
    const json = JSON.parse(text) as Json;
    const { catalog, rewrites, unmapped: skipped } = restructureCatalog(json);
    assertOnlyUrlsChanged(json, catalog, file);

    skipped.forEach((key) => unmapped.add(key));
    rewrites.forEach(({ legacyKey, newKey }) => {
      const existing = moves.get(legacyKey);
      if (existing && existing !== newKey) fail(`${legacyKey} maps to two keys: ${existing} and ${newKey}`);
      moves.set(legacyKey, newKey);
    });

    console.log(`[media:restructure] ${file}: ${rewrites.length} url(s) to rewrite`);
    plans.push({ file, text, json: catalog, rewrites: rewrites.length });
  }

  console.log(`[media:restructure] ${moves.size} distinct object(s) to move in r2-cache/`);
  if (unmapped.size > 0) {
    console.warn('[media:restructure] left in place (no layout rule):');
    unmapped.forEach((key) => console.warn(`    ${key}`));
  }

  // Resolve every move before the first rename, so a bad key aborts with nothing moved.
  const resolved = [...moves].map(([legacyKey, newKey]) => {
    const from = safeCachePath(CACHE_DIR, legacyKey);
    const to = safeCachePath(CACHE_DIR, newKey);
    if (!from || !to) fail(`${legacyKey} -> ${newKey} escapes r2-cache/ or crosses a symlink. Nothing was moved.`);
    return { newKey, from, to };
  });

  const notLocal: string[] = [];
  for (const { newKey, from, to } of resolved) {
    if (existsSync(to)) continue;
    if (!existsSync(from)) {
      notLocal.push(newKey);
      continue;
    }
    if (dryRun) continue;
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
  }

  for (const { file, text, json, rewrites } of plans) {
    if (rewrites === 0) continue;
    if (dryRun) continue;
    const serialized = `${JSON.stringify(json, null, 2)}\n`;
    if (serialized === text) continue;
    writeFileSync(path.join(REPO_ROOT, file), serialized);
    console.log(`[media:restructure] wrote ${file}`);
  }

  if (notLocal.length > 0) {
    console.warn(
      `[media:restructure] ${notLocal.length} new key(s) have no local file. ` +
        'They will 404 until the object is staged in r2-cache/ and pushed:',
    );
    notLocal.forEach((key) => console.warn(`    ${key}`));
  }
  console.log(dryRun ? '[media:restructure] dry run, nothing written' : '[media:restructure] done');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
