import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucketName, collectMediaKeys, md5Of } from '../scripts/lib/catalog-media.js';
import { pullMediaFile } from '../scripts/lib/pull-media-file.js';
import { requireMatchingPublishedMedia } from '../scripts/lib/published-media.js';
import { savePulledCatalog } from '../scripts/lib/pulled-catalog.js';
import { localMediaKeys, readMediaBase, safeCachePath, writeMediaBase } from '../scripts/lib/media-r2.js';
import { syncDynamicFixture } from '../scripts/sync-dynamic-fixture.js';
import { dynamicDataSchema } from '../services/dynamic-data-schema.js';

const key = 'whatsapp_bot/media/emerald_mining_tour/chivor/gallery/mine/01.jpg';
const url = `https://cdn.andeanscapes.com/${key}`;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bot-media-sync-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function stage(bytes: Buffer): string {
  const location = path.join(dir, key);
  mkdirSync(path.dirname(location), { recursive: true });
  writeFileSync(location, bytes);
  return location;
}

function origin(bytes: Buffer, etag = md5Of(bytes)): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => {
    return new Response(bytes.toString(), {
      headers: {
        'content-length': String(bytes.length),
        etag,
      },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('media pull filesystem/network flow', () => {
  it('preserves local replacements of different and identical byte lengths', async () => {
    const location = stage(Buffer.from('real'));
    origin(Buffer.from('mock'));
    expect(await pullMediaFile(dir, key, false)).toBe('preserved');
    expect(readFileSync(location, 'utf8')).toBe('real');
    origin(Buffer.from('older published photo'));
    expect(await pullMediaFile(dir, key, false)).toBe('preserved');
    expect(readFileSync(location, 'utf8')).toBe('real');
  });

  it('backs up local bytes before explicit overwrite', async () => {
    const location = stage(Buffer.from('real'));
    origin(Buffer.from('mock'));
    expect(await pullMediaFile(dir, key, true)).toBe('downloaded');
    expect(readFileSync(location, 'utf8')).toBe('mock');
    const backupRoot = path.join(dir, '.previous');
    const [snapshot] = readdirSync(backupRoot);
    expect(readFileSync(path.join(backupRoot, snapshot, key), 'utf8')).toBe('real');
  });

  it('downloads absent local files and reuses identical content', async () => {
    origin(Buffer.from('published'));
    expect(await pullMediaFile(dir, key, false)).toBe('downloaded');
    expect(await pullMediaFile(dir, key, false)).toBe('cached');
  });
});

describe('production published-media verification', () => {
  it('rejects remote mocks even after local replacements pass placeholder checks', async () => {
    stage(Buffer.from('real'));
    origin(Buffer.from('mock'));
    await expect(requireMatchingPublishedMedia({ url }, dir)).rejects.toThrow('differs from local');
  });

  it('downloads and compares bytes when ETag is not an MD5', async () => {
    stage(Buffer.from('real'));
    origin(Buffer.from('mock'), 'multipart-2');
    await expect(requireMatchingPublishedMedia({ url }, dir)).rejects.toThrow('differs from local');
    const fetch = origin(Buffer.from('real'), 'multipart-2');
    await expect(requireMatchingPublishedMedia({ url }, dir)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('catalog write guards', () => {
  it('refuses fixture generation with an empty cache, leaving destination unchanged', () => {
    const destination = path.join(dir, 'fixture.json');
    writeFileSync(destination, 'previous fixture');
    const source = new URL('../../scripts/bot-dynamic.ci.json', import.meta.url);
    expect(() => syncDynamicFixture(source.pathname, destination, dir)).toThrow('could not be checked');
    expect(readFileSync(destination, 'utf8')).toBe('previous fixture');
  });

  it('refuses known cross-site placeholders without changing the fixture', () => {
    const catalog = dynamicDataSchema.parse(JSON.parse(readFileSync(
      new URL('../../scripts/bot-dynamic.ci.json', import.meta.url), 'utf8',
    )) as unknown);
    const sites = catalog.experiences.emerald_mining_tour.sites;
    const original = sites.chivor.media.gallery[0];
    sites.coscuez.media.gallery = [{ ...original, url: original.url.replace('/chivor/', '/coscuez/') }];
    sites.coscuez.media.types = sites.chivor.media.types;
    sites.coscuez.media.typeKeywords = sites.chivor.media.typeKeywords;
    for (const mediaKey of collectMediaKeys(catalog)) {
      const location = path.join(dir, mediaKey);
      mkdirSync(path.dirname(location), { recursive: true });
      writeFileSync(location, mediaKey.includes('/coscuez/gallery/') ? original.url : `https://cdn.andeanscapes.com/${mediaKey}`);
    }
    const source = path.join(dir, 'source.json');
    const destination = path.join(dir, 'fixture.json');
    writeFileSync(source, JSON.stringify(catalog));
    writeFileSync(destination, 'previous fixture');
    expect(() => syncDynamicFixture(source, destination, dir)).toThrow('placeholders');
    expect(readFileSync(destination, 'utf8')).toBe('previous fixture');
  });

  it('saves valid downloaded bytes as both editable catalog and sync base', () => {
    const bytes = readFileSync(new URL('../../scripts/bot-dynamic.ci.json', import.meta.url));
    const location = path.join(dir, 'catalog.json');
    const basePath = path.join(dir, '.base', 'catalog.json');
    savePulledCatalog(location, basePath, bytes);
    expect(readFileSync(location)).toEqual(bytes);
    expect(readFileSync(basePath)).toEqual(bytes);
  });

  it.each(['not-json', '{}'])('invalid downloaded catalog leaves local/base untouched: %s', (invalid) => {
    const location = path.join(dir, 'catalog.json');
    const basePath = path.join(dir, 'base.json');
    writeFileSync(location, 'local edits');
    writeFileSync(basePath, 'previous base');
    expect(() => savePulledCatalog(location, basePath, Buffer.from(invalid))).toThrow();
    expect(readFileSync(location, 'utf8')).toBe('local edits');
    expect(readFileSync(basePath, 'utf8')).toBe('previous base');
  });

  it('rejects a bucket override whose contents do not back the fixed CDN', () => {
    vi.stubEnv('R2_BUCKET', 'another-bucket');
    expect(() => bucketName()).toThrow('comparisons and backups');
  });
});

describe('media sync base manifest', () => {
  const hash = 'a'.repeat(32);

  it('starts empty, merges updates and removes keys mapped to null', () => {
    expect(readMediaBase(dir)).toEqual({});
    writeMediaBase({ [key]: hash, other: 'b'.repeat(32) }, dir);
    writeMediaBase({ other: null }, dir);
    expect(readMediaBase(dir)).toEqual({ [key]: hash });
  });

  it('refuses a corrupt manifest instead of guessing', () => {
    writeFileSync(path.join(dir, '.sync-base.json'), JSON.stringify({ [key]: 'not-a-hash' }));
    expect(() => readMediaBase(dir)).toThrow('corrupt');
  });

  it('is invisible to the mirror listing, as are backups', () => {
    stage(Buffer.from('photo'));
    writeMediaBase({ [key]: hash }, dir);
    mkdirSync(path.join(dir, '.previous', 'x', 'whatsapp_bot'), { recursive: true });
    writeFileSync(path.join(dir, '.previous', 'x', 'whatsapp_bot', 'old.jpg'), 'old');
    expect(localMediaKeys(dir)).toEqual([key]);
  });
});

describe('media cache symlinks', () => {
  it('never lists, resolves or pulls through a symlink', async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'bot-media-outside-'));
    try {
      writeFileSync(path.join(outside, 'secret.jpg'), 'secret');
      const linked = path.join(dir, key);
      mkdirSync(path.dirname(linked), { recursive: true });
      symlinkSync(path.join(outside, 'secret.jpg'), linked);
      symlinkSync(outside, path.join(path.dirname(linked), 'linked-dir'));
      const viaDir = `${path.posix.dirname(key)}/linked-dir/new.jpg`;

      expect(localMediaKeys(dir)).toEqual([]);
      expect(safeCachePath(dir, key)).toBeNull();
      expect(safeCachePath(dir, viaDir)).toBeNull();
      origin(Buffer.from('remote'));
      await expect(pullMediaFile(dir, viaDir, true)).rejects.toThrow('symlink');
      expect(readdirSync(outside)).toEqual(['secret.jpg']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
