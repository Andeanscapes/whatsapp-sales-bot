import { describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  cachePathFor,
  classifyCatalogSync,
  classifyMedia,
  classifyMediaSync,
  collectMediaKeys,
  decideCatalogPull,
  decideCatalogPush,
  findCrossSiteDuplicates,
  fingerprintOf,
  keyToUrl,
  uploadRejection,
  urlToKey,
} from '../scripts/lib/catalog-media.js';

const CDN = 'https://cdn.andeanscapes.com/whatsapp_bot';

describe('urlToKey / keyToUrl', () => {
  it('maps a CDN URL under whatsapp_bot/ to its bucket key and back', () => {
    const key = 'whatsapp_bot/media/emerald_mining_tour/chivor/gallery/mine/01.jpg';
    expect(urlToKey(`${CDN}/media/emerald_mining_tour/chivor/gallery/mine/01.jpg`)).toBe(key);
    expect(keyToUrl(key)).toBe(`${CDN}/media/emerald_mining_tour/chivor/gallery/mine/01.jpg`);
  });

  it('rejects other hosts, plain http, and paths outside whatsapp_bot/', () => {
    expect(urlToKey('https://example.com/whatsapp_bot/a.jpg')).toBeNull();
    expect(urlToKey(`http://cdn.andeanscapes.com/whatsapp_bot/a.jpg`)).toBeNull();
    expect(urlToKey('https://cdn.andeanscapes.com/services/experience-x.json')).toBeNull();
  });
});

describe('collectMediaKeys', () => {
  it('collects every CDN media URL at any depth and ignores other strings', () => {
    const catalog = {
      media: { ownerImage: { url: `${CDN}/media/brand/owner.jpg` } },
      experiences: {
        exp: {
          sites: {
            chivor: {
              media: { gallery: [{ url: `${CDN}/media/x/chivor/gallery/mine/01.jpg` }] },
              plans: { core: { media: { planImages: [{ url: `${CDN}/media/x/chivor/plans/core/card.png` }] } } },
            },
          },
        },
      },
      note: 'see https://example.com/other.jpg',
      count: 3,
    };

    expect([...collectMediaKeys(catalog)].sort()).toEqual([
      'whatsapp_bot/media/brand/owner.jpg',
      'whatsapp_bot/media/x/chivor/gallery/mine/01.jpg',
      'whatsapp_bot/media/x/chivor/plans/core/card.png',
    ]);
  });
});

describe('cachePathFor', () => {
  it('resolves keys inside the cache directory', () => {
    expect(cachePathFor('/repo/r2-cache', 'whatsapp_bot/a.jpg')).toBe('/repo/r2-cache/whatsapp_bot/a.jpg');
  });

  it('refuses keys that escape the cache directory', () => {
    expect(cachePathFor('/repo/r2-cache', '../secrets.env')).toBeNull();
    expect(cachePathFor('/repo/r2-cache', 'whatsapp_bot/../../x')).toBeNull();
  });
});

describe('uploadRejection', () => {
  it('accepts jpg, jpeg and png up to the WhatsApp limit', () => {
    expect(uploadRejection('whatsapp_bot/a.jpg', 1000)).toBeNull();
    expect(uploadRejection('whatsapp_bot/a.JPEG', 1000)).toBeNull();
    expect(uploadRejection('whatsapp_bot/a.png', MAX_UPLOAD_BYTES)).toBeNull();
  });

  it('rejects other extensions and oversized files', () => {
    expect(uploadRejection('whatsapp_bot/a.webp', 1000)).toMatch(/extension/);
    expect(uploadRejection('whatsapp_bot/a.jpg', MAX_UPLOAD_BYTES + 1)).toMatch(/5 MB/);
  });
});

describe('classifyMedia', () => {
  const bytes = Buffer.from('image-bytes');
  const local = fingerprintOf(bytes);

  it('reports new, current, changed and unreachable', () => {
    expect(classifyMedia(local, { status: 'absent' })).toBe('new');
    expect(classifyMedia(local, { status: 'unavailable', reason: 'timeout' })).toBe('unreachable');
    expect(classifyMedia(local, { status: 'found', length: bytes.byteLength, md5: local.md5 })).toBe('current');
    expect(classifyMedia(local, { status: 'found', length: bytes.byteLength, md5: 'f'.repeat(32) })).toBe('changed');
  });

  it('falls back to length when the ETag is not a content hash', () => {
    expect(classifyMedia(local, { status: 'found', length: bytes.byteLength })).toBe('current');
    expect(classifyMedia(local, { status: 'found', length: 1 })).toBe('changed');
  });
});

describe('classifyCatalogSync', () => {
  const base = Buffer.from('{"v":1}');
  const edited = Buffer.from('{"v":2}');
  const moved = Buffer.from('{"v":3}');

  it('is in sync when local equals live', () => {
    expect(classifyCatalogSync({ local: base, live: base, base })).toBe('in-sync');
  });

  it('pushes when only local changed and pulls when only live changed', () => {
    expect(classifyCatalogSync({ local: edited, live: base, base })).toBe('push');
    expect(classifyCatalogSync({ local: base, live: moved, base })).toBe('pull');
  });

  it('is a conflict when both changed', () => {
    expect(classifyCatalogSync({ local: edited, live: moved, base })).toBe('conflict');
  });

  it('is a conflict without a base snapshot unless the two match', () => {
    expect(classifyCatalogSync({ local: edited, live: base, base: null })).toBe('conflict');
    expect(classifyCatalogSync({ local: base, live: base, base: null })).toBe('in-sync');
  });

  it('creates when not published, pulls when there is no local copy', () => {
    expect(classifyCatalogSync({ local: edited, live: null, base: null })).toBe('create');
    expect(classifyCatalogSync({ local: null, live: base, base: null })).toBe('pull');
    expect(classifyCatalogSync({ local: null, live: null, base: null })).toBe('missing-live');
  });
});

describe('decideCatalogPush', () => {
  const base = { target: 'dev' as const, baseMissing: false, confirmed: false, dryRun: false };

  it('uploads local edits and new catalogs', () => {
    expect(decideCatalogPush({ ...base, action: 'push' })).toEqual({ kind: 'write' });
    expect(decideCatalogPush({ ...base, action: 'create' })).toEqual({ kind: 'write' });
  });

  it('records the base on an in-sync run so the next edit is a push', () => {
    expect(decideCatalogPush({ ...base, action: 'in-sync' })).toEqual({ kind: 'noop', recordBase: true });
  });

  it('refuses a live change and a conflict', () => {
    expect(decideCatalogPush({ ...base, action: 'pull' }).kind).toBe('fail');
    expect(decideCatalogPush({ ...base, action: 'conflict' })).toMatchObject({ kind: 'fail', reason: expect.stringMatching(/live changed/) });
  });

  it('names the missing sync record when there is no base', () => {
    expect(decideCatalogPush({ ...base, action: 'conflict', baseMissing: true }))
      .toMatchObject({ kind: 'fail', reason: expect.stringMatching(/no sync record/) });
  });

  it('requires --confirm for prod, except on a dry run', () => {
    expect(decideCatalogPush({ ...base, target: 'prod', action: 'push' }))
      .toMatchObject({ kind: 'fail', reason: expect.stringMatching(/--confirm/) });
    expect(decideCatalogPush({ ...base, target: 'prod', action: 'push', confirmed: true })).toEqual({ kind: 'write' });
    expect(decideCatalogPush({ ...base, target: 'prod', action: 'push', dryRun: true })).toEqual({ kind: 'write' });
  });
});

describe('decideCatalogPull', () => {
  it('overwrites only when live moved and local is unedited', () => {
    expect(decideCatalogPull('pull')).toEqual({ kind: 'write' });
    expect(decideCatalogPull('in-sync')).toEqual({ kind: 'noop', recordBase: true });
    expect(decideCatalogPull('push').kind).toBe('fail');
    expect(decideCatalogPull('conflict').kind).toBe('fail');
    expect(decideCatalogPull('missing-live').kind).toBe('fail');
  });
});

describe('findCrossSiteDuplicates', () => {
  const chivor = 'whatsapp_bot/media/emerald_mining_tour/chivor/gallery/mine/01.jpg';
  const coscuez = 'whatsapp_bot/media/emerald_mining_tour/coscuez/gallery/mine/01.jpg';

  it('flags a site photo byte-identical to another site\'s', () => {
    expect(findCrossSiteDuplicates([
      { key: coscuez, md5: 'a' },
      { key: chivor, md5: 'a' },
    ])).toEqual([{ key: coscuez, duplicateOf: chivor }]);
  });

  it('allows the same bytes twice inside one site, and different bytes across sites', () => {
    expect(findCrossSiteDuplicates([
      { key: chivor, md5: 'a' },
      { key: 'whatsapp_bot/media/emerald_mining_tour/chivor/plans/core/card.png', md5: 'a' },
      { key: coscuez, md5: 'b' },
    ])).toEqual([]);
  });

  it('ignores brand media and legacy keys', () => {
    expect(findCrossSiteDuplicates([
      { key: 'whatsapp_bot/media/brand/owner.jpg', md5: 'a' },
      { key: 'whatsapp_bot/emerald_mining_chivor/exp/exp_01.jpg', md5: 'a' },
      { key: chivor, md5: 'a' },
    ])).toEqual([]);
  });
});

describe('classifyMediaSync', () => {
  it('is in sync when both sides hold the same bytes, base or not', () => {
    expect(classifyMediaSync({ local: 'a', remote: 'a', base: null })).toBe('in-sync');
    expect(classifyMediaSync({ local: 'a', remote: 'a', base: 'z' })).toBe('in-sync');
  });

  it('pushes a local edit and pulls a remote change', () => {
    expect(classifyMediaSync({ local: 'b', remote: 'a', base: 'a' })).toBe('push');
    expect(classifyMediaSync({ local: 'a', remote: 'b', base: 'a' })).toBe('pull');
  });

  it('pushes what R2 lacks and pulls what the mirror lacks', () => {
    expect(classifyMediaSync({ local: 'a', remote: null, base: null })).toBe('push');
    expect(classifyMediaSync({ local: null, remote: 'a', base: 'a' })).toBe('pull');
  });

  it('is a conflict when both changed, or when they differ with no base', () => {
    expect(classifyMediaSync({ local: 'b', remote: 'c', base: 'a' })).toBe('conflict');
    expect(classifyMediaSync({ local: 'b', remote: 'c', base: null })).toBe('conflict');
  });

  it('reports a key that exists nowhere', () => {
    expect(classifyMediaSync({ local: null, remote: null, base: 'a' })).toBe('missing');
  });
});
