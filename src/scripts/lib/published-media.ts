import { readFileSync } from 'node:fs';
import { CACHE_DIR, cachePathFor, collectMediaKeys, keyToUrl, md5Of } from './catalog-media.js';
import { downloadFromOrigin, readOriginLength } from './cdn.js';

/** Production must reference the exact bytes checked locally, never older placeholders. */
export async function requireMatchingPublishedMedia(catalog: unknown, cacheDir = CACHE_DIR): Promise<void> {
  for (const key of collectMediaKeys(catalog)) {
    const location = cachePathFor(cacheDir, key);
    if (!location) throw new Error(`Invalid media key: ${key}`);
    const localHash = md5Of(readFileSync(location));
    const remote = await readOriginLength(keyToUrl(key));
    if (remote.status !== 'found') throw new Error(`Cannot verify published media: ${key}`);
    if (remote.md5) {
      if (remote.md5 === localHash) continue;
    } else {
      const downloaded = await downloadFromOrigin(keyToUrl(key));
      if (downloaded.ok && md5Of(downloaded.body) === localHash) continue;
    }
    throw new Error(`Published media differs from local: ${key}. Run npm run media:push first.`);
  }
}
