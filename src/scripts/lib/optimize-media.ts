/**
 * Converts photos dropped into `r2-cache/whatsapp_bot/media/` into WhatsApp-ready
 * JPEGs at the same key. Ported in spirit from andean_v3 `optimize-media.ts`, but
 * the bot delivers JPEG, not WebP: WhatsApp image messages and template headers
 * accept JPEG/PNG only.
 *
 *   01.heic / 01.jpeg / 01.tiff / 01.webp  ->  01.jpg
 *   an existing 01.jpg that is too large   ->  re-encoded in place
 *
 * Every output is auto-rotated from EXIF, resized so the longest edge is at most
 * `DELIVERY_MAX_EDGE` (never upscaled), encoded as progressive mozjpeg, and
 * **stripped of all metadata**: iPhone photos carry GPS coordinates, and the CDN
 * is public.
 *
 * HEIC/HEIF: sharp's prebuilt libvips registers HEIF for AVIF only (no HEVC
 * decoder), so those are decoded to a temporary PNG with macOS `sips`, falling
 * back to `ffmpeg`. A JPEG at its target is left alone: re-encoding a lossy file
 * at the same size only compounds generation loss.
 *
 * A source is converted only when new or changed (`.optimize-base.json`); an
 * existing `.jpg` it replaces is backed up to `.previous/<ts>/local/` first.
 *
 * Sources are NOT deleted here. The caller deletes them only after the `.jpg`
 * is confirmed on R2 with the same bytes (`selectPrunableSources`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import {
  BOT_PREFIX,
  CACHE_DIR,
  DELIVERY_MAX_EDGE,
  DELIVERY_MAX_JPEG_BYTES,
  EXTERNAL_DECODE_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  deliveryKeyFor,
  isImageSource,
  md5Of,
} from './catalog-media.js';
import { safeCachePath } from './media-r2.js';

const JPEG_QUALITY = 82;

/**
 * `r2-cache/.optimize-base.json`: source key -> md5 of the source bytes last
 * converted. A source is converted only when it is new or its bytes changed, so a
 * lingering source never re-converts over a `.jpg` edited by hand afterwards, and
 * an unchanged HEIC is not decoded on every run. Content, not mtime: a photo
 * exported from Photos keeps its capture date and would look older than the mock
 * it replaces.
 */
const OPTIMIZE_BASE_FILE = '.optimize-base.json';
const optimizeBaseSchema = z.record(z.string(), z.string().regex(/^[0-9a-f]{32}$/));

function readOptimizeBase(cacheDir: string): Record<string, string> {
  const location = path.join(cacheDir, OPTIMIZE_BASE_FILE);
  if (!existsSync(location)) return {};
  const parsed = optimizeBaseSchema.safeParse(JSON.parse(readFileSync(location, 'utf8')) as unknown);
  if (!parsed.success) throw new Error(`${OPTIMIZE_BASE_FILE} is corrupt. Delete it; sources are then re-converted.`);
  return parsed.data;
}

/** Merge `updates` into the manifest; keys mapped to null are removed. */
export function writeOptimizeBase(updates: Record<string, string | null>, cacheDir = CACHE_DIR): void {
  const next = { ...readOptimizeBase(cacheDir) };
  for (const [key, md5] of Object.entries(updates)) {
    if (md5 === null) delete next[key];
    else next[key] = md5;
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, OPTIMIZE_BASE_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
}
const JPEG_QUALITY_FLOOR = 62;
const JPEG_QUALITY_STEP = 8;

export interface OptimizeResult {
  key: string;
  output: string;
  action: 'converted' | 'reencoded' | 'kept' | 'failed';
  detail: string;
}

/** Every regular file under `<cacheDir>/whatsapp_bot/`, including sources, as bucket-style keys. Symlinks are ignored. */
function allCacheKeys(cacheDir: string): string[] {
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
  return keys.sort();
}

export function listSourceKeys(cacheDir = CACHE_DIR): string[] {
  return allCacheKeys(cacheDir).filter(isImageSource);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

/** Decode HEIC/HEIF to a temporary PNG sharp can read. Throws with an actionable message. */
function decodeExternally(source: string, workDir: string): string {
  const target = path.join(workDir, `${path.basename(source)}.png`);
  const attempts: Array<[string, string[]]> = [
    ['sips', ['-s', 'format', 'png', source, '--out', target]],
    ['ffmpeg', ['-y', '-loglevel', 'error', '-i', source, target]],
  ];
  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, { stdio: 'pipe' });
      if (existsSync(target)) return target;
    } catch {
      // try the next decoder
    }
  }
  throw new Error(
    `${path.extname(source)} needs an external decoder (sharp has no HEVC). ` +
      'Install ffmpeg (brew install ffmpeg) or export the photo as JPEG.',
  );
}

async function encodeJpeg(input: string, quality: number): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: DELIVERY_MAX_EDGE, height: DELIVERY_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true, progressive: true })
    .toBuffer();
}

/** Encode under the 1 MB delivery target, stepping quality down to a visible-artifact floor. */
async function encodeWithinBudget(input: string): Promise<{ bytes: Buffer; quality: number }> {
  let quality = JPEG_QUALITY;
  let bytes = await encodeJpeg(input, quality);
  while (bytes.byteLength > DELIVERY_MAX_JPEG_BYTES && quality - JPEG_QUALITY_STEP >= JPEG_QUALITY_FLOOR) {
    quality -= JPEG_QUALITY_STEP;
    bytes = await encodeJpeg(input, quality);
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('still above the 5 MB WhatsApp limit after encoding');
  return { bytes, quality };
}

/** True when a delivered `.jpg` already meets the target and must not be re-encoded. */
async function jpegState(file: string): Promise<{ atTarget: boolean; carriesMetadata: boolean }> {
  const meta = await sharp(file).metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  // EXIF (GPS, device) or a rotation flag must always be rewritten: privacy and
  // correct orientation outrank the "only if smaller" size rule.
  const carriesMetadata = !!meta.exif || !!meta.xmp || !!meta.iptc || (meta.orientation ?? 1) !== 1;
  const atTarget = longest > 0 && longest <= DELIVERY_MAX_EDGE && !carriesMetadata
    && statSync(file).size <= DELIVERY_MAX_JPEG_BYTES;
  return { atTarget, carriesMetadata };
}

/** Copy an existing output aside before a source replaces it. */
function backUpOutput(cacheDir: string, output: string, outputPath: string): string {
  const destination = path.join(cacheDir, '.previous', new Date().toISOString().replace(/[:.]/g, '-'), 'local', output);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(outputPath));
  return path.relative(cacheDir, destination);
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

async function optimizeOne(
  cacheDir: string,
  key: string,
  dryRun: boolean,
  base: Readonly<Record<string, string>>,
): Promise<OptimizeResult> {
  const output = deliveryKeyFor(key);
  const sourcePath = safeCachePath(cacheDir, key);
  const outputPath = safeCachePath(cacheDir, output);
  if (!sourcePath || !outputPath) return { key, output, action: 'failed', detail: 'escapes r2-cache/ or is a symlink' };

  const isSource = isImageSource(key);
  const sourceMd5 = isSource ? md5Of(readFileSync(sourcePath)) : null;
  let carriesMetadata = false;
  if (isSource) {
    // Unchanged since its last conversion: the .jpg (possibly edited by hand since)
    // is authoritative. Re-converting would overwrite that edit.
    if (base[key] === sourceMd5 && existsSync(outputPath)) {
      return { key, output, action: 'kept', detail: 'source unchanged since its last conversion' };
    }
  } else {
    const state = await jpegState(sourcePath);
    if (state.atTarget) return { key, output, action: 'kept', detail: 'already at target' };
    carriesMetadata = state.carriesMetadata;
  }

  const before = statSync(sourcePath).size;
  const replacing = isSource && existsSync(outputPath);
  // A dry run of an existing clean .jpg still measures the re-encode, so the plan
  // is exact: one that would not shrink is "kept" here too, not listed as a push.
  if (dryRun && !(!isSource && !carriesMetadata)) {
    return {
      key,
      output,
      action: isSource ? 'converted' : 'reencoded',
      detail: `${kb(before)} -> (dry run)${replacing ? `, replaces existing ${path.basename(output)}` : ''}`,
    };
  }

  const workDir = mkdtempSync(path.join(tmpdir(), 'bot-media-'));
  try {
    const decodable = EXTERNAL_DECODE_EXTENSIONS.has(path.extname(key).toLowerCase())
      ? decodeExternally(sourcePath, workDir)
      : sourcePath;
    const { bytes, quality } = await encodeWithinBudget(decodable);
    // Re-encoding a clean .jpg that only slightly exceeds the edge can come out
    // larger; a generation loss that saves nothing is worse than the original.
    // Never when it carries metadata: stripping GPS is not optional.
    if (!isSource && !carriesMetadata && bytes.byteLength >= before) {
      return { key, output, action: 'kept', detail: 're-encode would not be smaller' };
    }
    if (dryRun) return { key, output, action: 'reencoded', detail: `${kb(before)} -> ${kb(bytes.byteLength)} (dry run)` };
    const backup = replacing ? backUpOutput(cacheDir, output, outputPath) : null;
    const meta = await sharp(bytes).metadata();
    // Stage next to the output (hidden name, same volume), then rename: an
    // interrupted run never leaves a truncated .jpg that sync would upload.
    const staged = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.tmp`);
    writeFileSync(staged, bytes);
    renameSync(staged, outputPath);
    if (isSource && sourceMd5) writeOptimizeBase({ [key]: sourceMd5 }, cacheDir);
    return {
      key,
      output,
      action: isSource ? 'converted' : 'reencoded',
      detail: `${kb(before)} -> ${kb(statSync(outputPath).size)}, ${meta.width}x${meta.height}, q${quality}, metadata stripped`
        + (backup ? `; previous ${path.basename(output)} backed up to ${backup}` : ''),
    };
  } catch (error) {
    return { key, output, action: 'failed', detail: errorText(error) };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Convert every source and re-encode every oversized `.jpg` in the mirror.
 * `.png` files (plan cards: text on flat colour) are left alone; they are only
 * size-checked at upload. One failure never stops the others.
 */
export async function optimizeMediaCache(options: { dryRun: boolean; cacheDir?: string }): Promise<OptimizeResult[]> {
  const cacheDir = options.cacheDir ?? CACHE_DIR;
  const keys = allCacheKeys(cacheDir);
  const base = readOptimizeBase(cacheDir);
  const results: OptimizeResult[] = [];
  // Sources first. A .jpg a source just wrote is fresh and skipped; any other .jpg
  // (including one whose unchanged source was kept) is still checked, so a
  // hand-edited .jpg carrying GPS is stripped too.
  for (const key of keys.filter(isImageSource)) results.push(await optimizeOne(cacheDir, key, options.dryRun, base));
  const written = new Set(results.filter(result => result.action === 'converted').map(result => result.output));
  for (const key of keys.filter(key => path.extname(key).toLowerCase() === '.jpg' && !written.has(key))) {
    results.push(await optimizeOne(cacheDir, key, options.dryRun, base));
  }
  return results;
}

/** Print the optimizer's results and return how many failed. */
export function reportOptimize(results: readonly OptimizeResult[], tag: string): number {
  const changed = results.filter(result => result.action === 'converted' || result.action === 'reencoded');
  const failed = results.filter(result => result.action === 'failed');
  for (const result of changed) {
    const arrow = result.key === result.output ? result.key : `${result.key} -> ${path.basename(result.output)}`;
    console.log(`  * ${arrow}: ${result.detail}`);
  }
  for (const result of failed) console.error(`  ✗ ${result.key}: ${result.detail}`);
  console.log(`[${tag}] optimize: ${changed.length} converted/re-encoded, ${results.length - changed.length - failed.length} already optimal, ${failed.length} failed`);
  return failed.length;
}
