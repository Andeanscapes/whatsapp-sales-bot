/**
 * Placeholder-media guard. A catalog that ships one site's photo as another
 * site's (the Coscuez mocks copied from Chivor) must stay in the dev catalog:
 * `sync:fixture` and the prod push call this and refuse on any duplicate.
 *
 * Reads the local `r2-cache/` mirror. A referenced key with no local file
 * cannot be checked and is reported as unverified.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  CACHE_DIR,
  cachePathFor,
  collectMediaKeys,
  findCrossSiteDuplicates,
  md5Of,
  siteScopeOf,
} from './catalog-media.js';

export interface CrossSiteCheck {
  duplicates: Array<{ key: string; duplicateOf: string }>;
  unverified: string[];
}

export function checkCrossSiteDuplicates(catalog: unknown, cacheDir = CACHE_DIR): CrossSiteCheck {
  const entries: Array<{ key: string; md5: string }> = [];
  const unverified: string[] = [];

  for (const key of collectMediaKeys(catalog)) {
    if (!siteScopeOf(key)) continue;
    const location = cachePathFor(cacheDir, key);
    if (!location || !existsSync(location)) {
      unverified.push(key);
      continue;
    }
    entries.push({ key, md5: md5Of(readFileSync(location)) });
  }

  return { duplicates: findCrossSiteDuplicates(entries), unverified: unverified.sort() };
}

/** Human-readable failure lines, or null when the catalog is clean. */
export function describeCrossSiteDuplicates(check: CrossSiteCheck): string | null {
  if (check.duplicates.length === 0) return null;
  return [
    'these site photos are byte-identical to another site\'s (placeholders):',
    ...check.duplicates.map(({ key, duplicateOf }) => `    ${key} == ${duplicateOf}`),
    'Replace them with real photos first. Placeholders stay in the dev catalog only.',
  ].join('\n');
}
