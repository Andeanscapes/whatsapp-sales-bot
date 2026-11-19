import { normalizeText } from './language-service.js';
import type { InternalVideoLink } from './dynamic-data-service.js';

/**
 * Request-only video links (owner 2026-11-18): the WhatsApp line cannot attach large
 * videos, so a video request is answered with approved Instagram links as text. The
 * catalog owns the links and what each shows; the model writes the reply around them.
 */

export type VideoLinkCategory = 'culture' | 'plan';
export interface SelectedVideoLink extends InternalVideoLink {
  category: VideoLinkCategory;
}

const VIDEO_NOUN = String.raw`(?:videos?|reels?|clips?)`;
// A request frame before the noun: "mándame un video", "¿tienen videos?", "send me a reel".
// "vi el video" / "I saw your video" are how ad leads open, never a request.
const VIDEO_REQUEST = new RegExp(String.raw`\b(?:mand|envi|pas[ae]|compart|tien|hay|muestr|ensen|ver\b|send|share|have|show|see\b|watch\b|link|enlace)\w*\b[^.?!\n]{0,40}\b${VIDEO_NOUN}\b`);
const VIDEO_SEEN = new RegExp(String.raw`\b(?:vi|ya vi|acabo de ver|estaba viendo|saw|watched|seen)\b[^.?!\n]{0,25}\b${VIDEO_NOUN}\b`);

export function isVideoRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  const norm = normalizeText(text);
  return VIDEO_REQUEST.test(norm) && !VIDEO_SEEN.test(norm);
}

/** True when the text names a video noun at all (keeps it out of the photo matcher). */
export function mentionsVideo(text: string): boolean {
  return new RegExp(String.raw`\b${VIDEO_NOUN}\b`).test(normalizeText(text));
}

const INSTAGRAM_MEDIA_IN_TEXT = /https?:\/\/(?:www\.)?instagram\.com\/(?:reels?|p)\/[A-Za-z0-9_-]+\/?/gi;

/** The permalink's shortcode: `/reel/`, `/reels/`, `/p/` and a trailing slash all compare alike. */
export function videoLinkId(url: string): string {
  return /instagram\.com\/(?:reels?|p)\/([A-Za-z0-9_-]+)/i.exec(url)?.[1] ?? url;
}

export function findInstagramMediaUrls(text: string): string[] {
  return [...text.matchAll(INSTAGRAM_MEDIA_IN_TEXT)].map(match => match[0]);
}

/**
 * One link per category (culture, then plan), at most two, never the same URL twice.
 * An unseen link wins over one already sent in this chat; the pick among equals is random.
 */
export function selectVideoLinks(
  pools: { culture: InternalVideoLink[]; plan: InternalVideoLink[] },
  alreadySent: (url: string) => boolean,
  random: () => number = Math.random,
): SelectedVideoLink[] {
  const chosen: SelectedVideoLink[] = [];
  for (const category of ['culture', 'plan'] as const) {
    const pool = pools[category].filter(link => !chosen.some(picked => videoLinkId(picked.url) === videoLinkId(link.url)));
    if (pool.length === 0) continue;
    const unseen = pool.filter(link => !alreadySent(link.url));
    const candidates = unseen.length > 0 ? unseen : pool;
    const pick = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
    chosen.push({ ...pick, category });
  }
  return chosen;
}

/** Instagram post/reel links in a reply that were neither selected this turn nor sent before. */
export function unapprovedVideoUrls(reply: string, allowed: string[], alreadySent: (url: string) => boolean): string[] {
  const allowedKeys = new Set(allowed.map(videoLinkId));
  return findInstagramMediaUrls(reply).filter(url => !allowedKeys.has(videoLinkId(url)) && !alreadySent(url));
}
