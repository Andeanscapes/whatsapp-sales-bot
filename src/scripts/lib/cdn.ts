/**
 * Reading and invalidating `cdn.andeanscapes.com`. Ported from andean_v3
 * `scripts/lib/cdn.ts`; kept as a copy because the two repos do not share code.
 *
 * The CDN caches HEAD and GET under separate keys, so a size read can disagree
 * with the bytes a visitor gets. Anything deciding whether to upload must read
 * from **origin**: a cache-busting query string forces the request to R2.
 */

import { Buffer } from 'node:buffer';

const RANGE_BYTES = 1024;
/** Twice the 5 MB WhatsApp upload limit; nothing legitimate on the CDN is larger. */
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

export interface LocalFingerprint {
  size: number;
  md5: string;
}

export type CdnRead =
  | { status: 'found'; length: number; md5?: string }
  | { status: 'absent' }
  | { status: 'unavailable'; reason: string };

/** The MD5 an ETag carries, or undefined for multipart ETags (`<hash>-<parts>`). */
function md5FromEtag(etag: string | null): string | undefined {
  const value = etag?.replace(/^W\//, '').replace(/"/g, '').trim().toLowerCase();
  return value && /^[0-9a-f]{32}$/.test(value) ? value : undefined;
}

function withOriginBypass(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}__origin=${Date.now()}`;
}

/** Length (and MD5 when the ETag carries one) of the object at `url`, read from origin. */
export async function readOriginLength(url: string): Promise<CdnRead> {
  try {
    // redirect: 'error' keeps every read on the pinned CDN host.
    const response = await fetch(withOriginBypass(url), {
      headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
      redirect: 'error',
    });

    if (response.status === 404) return { status: 'absent' };

    if (response.status === 206) {
      const total = Number(response.headers.get('content-range')?.split('/')[1]);
      if (!Number.isFinite(total)) {
        return { status: 'unavailable', reason: 'range response carried no total length' };
      }
      return { status: 'found', length: total, md5: md5FromEtag(response.headers.get('etag')) };
    }

    if (response.status === 200) {
      const length = Number(response.headers.get('content-length') ?? Number.NaN);
      if (!Number.isFinite(length)) {
        return { status: 'unavailable', reason: 'response carried no content-length' };
      }
      return { status: 'found', length, md5: md5FromEtag(response.headers.get('etag')) };
    }

    return { status: 'unavailable', reason: `HTTP ${response.status} ${response.statusText}` };
  } catch (error) {
    return { status: 'unavailable', reason: errorText(error) };
  }
}

/** True when the remote read holds exactly the local bytes. */
export function sameContent(
  remote: { length: number; md5?: string },
  local: LocalFingerprint,
): boolean {
  return remote.md5 ? remote.md5 === local.md5.toLowerCase() : remote.length === local.size;
}

/** Whole object from origin, so a stale edge copy is never written to disk. */
export async function downloadFromOrigin(
  url: string,
): Promise<{ ok: true; body: Buffer } | { ok: false; reason: string }> {
  try {
    const response = await fetch(withOriginBypass(url), { redirect: 'error' });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status} ${response.statusText}` };
    if (Number(response.headers.get('content-length') ?? 0) > MAX_DOWNLOAD_BYTES) {
      return { ok: false, reason: `larger than ${MAX_DOWNLOAD_BYTES} bytes` };
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > MAX_DOWNLOAD_BYTES) return { ok: false, reason: `larger than ${MAX_DOWNLOAD_BYTES} bytes` };
    return { ok: true, body };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

export type PurgeResult =
  | { ok: true; count: number }
  | { ok: false; reason: string; manual: string[] };

/**
 * Invalidate edge copies of `urls`. Best effort: the deploy token often lacks
 * Cache Purge, and that must not turn a successful upload into a failure.
 * Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID`.
 */
export async function purgeCache(urls: readonly string[]): Promise<PurgeResult> {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();

  if (!token || !zoneId) {
    return {
      ok: false,
      reason: 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID must be set in .env.wrangler',
      manual: Array.from(urls),
    };
  }

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: Array.from(urls) }),
    });
    const body = (await response.json()) as { success?: boolean; errors?: { message?: string }[] };

    if (response.ok && body.success) return { ok: true, count: urls.length };

    return {
      ok: false,
      reason: body.errors?.[0]?.message ?? `HTTP ${response.status}`,
      manual: Array.from(urls),
    };
  } catch (error) {
    return { ok: false, reason: errorText(error), manual: Array.from(urls) };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
