import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DELIVERY_MAX_EDGE,
  DELIVERY_MAX_JPEG_BYTES,
  deliveryKeyFor,
  isDeliveryKey,
  isImageSource,
  selectPrunableSources,
} from '../scripts/lib/catalog-media.js';
import { localMediaKeys } from '../scripts/lib/media-r2.js';
import { listSourceKeys, optimizeMediaCache } from '../scripts/lib/optimize-media.js';

const DIR = 'whatsapp_bot/media/emerald_mining_tour/coscuez/gallery/mine';
let cache: string;

beforeEach(() => {
  cache = mkdtempSync(path.join(os.tmpdir(), 'bot-optimize-'));
  mkdirSync(path.join(cache, DIR), { recursive: true });
});

afterEach(() => {
  rmSync(cache, { recursive: true, force: true });
});

/** A noisy photo-like image, so JPEG sizes are realistic. */
async function photo(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761) % 251;
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .withExif({ IFD0: { Copyright: 'gps-and-owner-data' } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe('source and delivery keys', () => {
  it('maps every source to a .jpg at the same key', () => {
    expect(deliveryKeyFor(`${DIR}/01.heic`)).toBe(`${DIR}/01.jpg`);
    expect(deliveryKeyFor(`${DIR}/01.HEIF`)).toBe(`${DIR}/01.jpg`);
    expect(deliveryKeyFor(`${DIR}/01.jpeg`)).toBe(`${DIR}/01.jpg`);
    expect(deliveryKeyFor(`${DIR}/01.jpg`)).toBe(`${DIR}/01.jpg`);
    expect(deliveryKeyFor(`${DIR}/card.png`)).toBe(`${DIR}/card.png`);
  });

  it('never treats a source as a delivery file', () => {
    expect(isImageSource(`${DIR}/01.heic`)).toBe(true);
    expect(isDeliveryKey(`${DIR}/01.heic`)).toBe(false);
    expect(isDeliveryKey(`${DIR}/01.jpeg`)).toBe(false);
    expect(isDeliveryKey(`${DIR}/01.jpg`)).toBe(true);
    expect(isDeliveryKey(`${DIR}/card.png`)).toBe(true);
  });

  it('prunes a source only when its .jpg is confirmed and it is the only source', () => {
    const confirmed = new Set([`${DIR}/01.jpg`, `${DIR}/02.jpg`]);
    expect(selectPrunableSources([`${DIR}/01.heic`, `${DIR}/03.heic`], confirmed)).toEqual([`${DIR}/01.heic`]);
    expect(selectPrunableSources([`${DIR}/02.heic`, `${DIR}/02.tiff`], confirmed)).toEqual([]);
  });
});

describe('optimizeMediaCache', () => {
  it('re-encodes an oversized .jpg in place: mobile size, no metadata', async () => {
    const file = path.join(cache, DIR, '01.jpg');
    writeFileSync(file, await photo(3000, 4000));

    const [result] = await optimizeMediaCache({ dryRun: false, cacheDir: cache });

    expect(result.action).toBe('reencoded');
    const meta = await sharp(file).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(DELIVERY_MAX_EDGE);
    expect(meta.exif).toBeUndefined();
    expect(statSync(file).size).toBeLessThanOrEqual(DELIVERY_MAX_JPEG_BYTES);
  });

  it('leaves a .jpg already at target untouched, and never upscales', async () => {
    const file = path.join(cache, DIR, '02.jpg');
    writeFileSync(file, await sharp(await photo(800, 600)).jpeg({ quality: 80 }).toBuffer());
    const before = statSync(file).mtimeMs;

    const [result] = await optimizeMediaCache({ dryRun: false, cacheDir: cache });

    expect(result.action).toBe('kept');
    expect(statSync(file).mtimeMs).toBe(before);
  });

  // Privacy outranks size: a .jpg carrying EXIF (iPhone GPS) is always rewritten.
  it('strips metadata even when re-encoding would not make the .jpg smaller', async () => {
    const file = path.join(cache, DIR, '09.jpg');
    const raw = await sharp(await photo(1700, 1200)).withExif({ IFD0: { Make: 'Apple', Model: 'iPhone 15' } })
      .jpeg({ quality: 30 }).toBuffer();
    writeFileSync(file, raw);

    const [result] = await optimizeMediaCache({ dryRun: false, cacheDir: cache });

    expect(result.action).toBe('reencoded');
    expect((await sharp(file).metadata()).exif).toBeUndefined();
  });

  it('keeps an existing .jpg when re-encoding would not make it smaller', async () => {
    const file = path.join(cache, DIR, '08.jpg');
    // Just over the edge and already tightly compressed: a re-encode cannot win.
    writeFileSync(file, await sharp(await photo(1700, 1200)).jpeg({ quality: 30 }).toBuffer());
    const before = statSync(file).size;

    const [result] = await optimizeMediaCache({ dryRun: false, cacheDir: cache });

    expect(result.action).toBe('kept');
    expect(statSync(file).size).toBe(before);
  });

  it('dry run reports a clean .jpg that would not shrink as kept, matching the real run', async () => {
    const file = path.join(cache, DIR, '12.jpg');
    writeFileSync(file, await sharp(await photo(1700, 1200)).jpeg({ quality: 30 }).toBuffer());

    const [dry] = await optimizeMediaCache({ dryRun: true, cacheDir: cache });

    expect(dry.action).toBe('kept');
  });

  it('converts a .jpeg source to .jpg, keeps the source, and lists only the .jpg for sync', async () => {
    writeFileSync(path.join(cache, DIR, '03.jpeg'), await photo(2000, 1500));

    const [result] = await optimizeMediaCache({ dryRun: false, cacheDir: cache });

    expect(result).toMatchObject({ action: 'converted', output: `${DIR}/03.jpg` });
    expect(existsSync(path.join(cache, DIR, '03.jpeg'))).toBe(true);
    expect(localMediaKeys(cache)).toEqual([`${DIR}/03.jpg`]);
    expect(listSourceKeys(cache)).toEqual([`${DIR}/03.jpeg`]);
  });

  // A lingering source must not overwrite a .jpg edited by hand after conversion.
  it('does not re-convert an unchanged source over a hand-edited .jpg', async () => {
    writeFileSync(path.join(cache, DIR, '10.jpeg'), await photo(2000, 1500));
    await optimizeMediaCache({ dryRun: false, cacheDir: cache });
    const edited = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#f00' } }).jpeg().toBuffer();
    writeFileSync(path.join(cache, DIR, '10.jpg'), edited);

    const [result] = await optimizeMediaCache({ dryRun: false, cacheDir: cache });

    expect(result.action).toBe('kept');
    expect(readFileSync(path.join(cache, DIR, '10.jpg')).equals(edited)).toBe(true);
  });

  // A new or changed source wins (e.g. the real Coscuez photo replacing the mock),
  // but the .jpg it replaces is backed up first.
  it('converts a new source over an existing .jpg and backs the old one up', async () => {
    const mock = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#00f' } }).jpeg().toBuffer();
    writeFileSync(path.join(cache, DIR, '11.jpg'), mock);
    writeFileSync(path.join(cache, DIR, '11.jpeg'), await photo(2000, 1500));

    const [result] = await optimizeMediaCache({ dryRun: false, cacheDir: cache });

    expect(result).toMatchObject({ key: `${DIR}/11.jpeg`, action: 'converted' });
    expect(readFileSync(path.join(cache, DIR, '11.jpg')).equals(mock)).toBe(false);
    const backups = readdirSync(path.join(cache, '.previous'), { recursive: true }) as string[];
    expect(backups.some(entry => entry.endsWith('11.jpg'))).toBe(true);
  });

  it('dry run writes nothing', async () => {
    writeFileSync(path.join(cache, DIR, '04.jpeg'), await photo(2000, 1500));

    const [result] = await optimizeMediaCache({ dryRun: true, cacheDir: cache });

    expect(result.action).toBe('converted');
    expect(existsSync(path.join(cache, DIR, '04.jpg'))).toBe(false);
  });

  it('reports an undecodable source as failed without stopping the others', async () => {
    writeFileSync(path.join(cache, DIR, '05.heic'), 'not an image');
    writeFileSync(path.join(cache, DIR, '06.jpeg'), await photo(2000, 1500));

    const results = await optimizeMediaCache({ dryRun: false, cacheDir: cache });

    expect(results.find(result => result.key.endsWith('05.heic'))?.action).toBe('failed');
    expect(results.find(result => result.key.endsWith('06.jpeg'))?.action).toBe('converted');
  });

  // HEIC from an iPhone: sharp cannot decode it, so this exercises the sips path.
  it.runIf(process.platform === 'darwin')('converts a real .heic through sips', async () => {
    const jpeg = path.join(cache, 'seed.jpg');
    writeFileSync(jpeg, await photo(2400, 3200));
    const heic = path.join(cache, DIR, '07.heic');
    execFileSync('sips', ['-s', 'format', 'heic', jpeg, '--out', heic], { stdio: 'pipe' });
    rmSync(jpeg);

    const [result] = await optimizeMediaCache({ dryRun: false, cacheDir: cache });

    expect(result).toMatchObject({ action: 'converted', output: `${DIR}/07.jpg` });
    const meta = await sharp(path.join(cache, DIR, '07.jpg')).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(DELIVERY_MAX_EDGE);
  });
});
