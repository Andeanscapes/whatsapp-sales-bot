import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { keyToUrl, md5Of } from './catalog-media.js';
import { downloadFromOrigin, readOriginLength } from './cdn.js';
import { safeCachePath } from './media-r2.js';

export type PullOutcome = 'downloaded' | 'cached' | 'local-only' | 'preserved' | 'missing' | 'failed';

/** Existing files are editable sources. Only explicit overwrite may replace them. */
export async function pullMediaFile(cacheDir: string, key: string, overwrite: boolean): Promise<PullOutcome> {
  const location = safeCachePath(cacheDir, key);
  if (!location) throw new Error(`Media key escapes cache or is a symlink: ${key}`);
  const local = existsSync(location) ? readFileSync(location) : null;
  const remote = await readOriginLength(keyToUrl(key));
  if (remote.status === 'absent') return local ? 'local-only' : 'missing';
  if (remote.status === 'unavailable') throw new Error(`${key}: ${remote.reason}`);

  if (local && remote.md5 === md5Of(local)) return 'cached';
  if (local && !overwrite) return 'preserved';

  const downloaded = await downloadFromOrigin(keyToUrl(key));
  if (!downloaded.ok) throw new Error(`${key}: ${downloaded.reason}`);
  if (downloaded.body.length !== remote.length || (remote.md5 && md5Of(downloaded.body) !== remote.md5)) {
    throw new Error(`${key}: downloaded content does not match origin metadata`);
  }
  if (local?.equals(downloaded.body)) return 'cached';

  if (local) {
    const backup = path.join(cacheDir, '.previous', new Date().toISOString().replace(/[:.]/g, '-'), key);
    mkdirSync(path.dirname(backup), { recursive: true });
    writeFileSync(backup, local, { flag: 'wx' });
  }
  mkdirSync(path.dirname(location), { recursive: true });
  writeFileSync(location, downloaded.body);
  return 'downloaded';
}
