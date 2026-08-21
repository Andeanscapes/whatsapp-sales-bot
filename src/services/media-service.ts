import type { Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import type { InternalGalleryImage, InternalPlanImage } from './dynamic-data-service.js';
import { MS_72H } from './constants.js';
import type { ResolvedMediaTheme } from './media-marker.js';

export interface ResolvedPlanImage {
  id: string;
  url: string;
  caption: string;
}

export function canSendImage(repos: Repositories, phone: string): boolean {
  void repos;
  void phone;
  if (!env.SEND_IMAGES_ENABLED) return false;
  return true;
}

export function canSendPlanImage(repos: Repositories, phone: string, imageId: string): boolean {
  if (!env.SEND_IMAGES_ENABLED) return false;

  const cutoff = new Date(Date.now() - MS_72H).toISOString();
  return !repos.mediaSend.hasRecentSameImage(phone, imageId, cutoff);
}

export function recordImageSend(repos: Repositories, phone: string, mediaId: string): void {
  repos.mediaSend.recordSend(phone, mediaId);
}

export function reserveImageSend(repos: Repositories, phone: string, mediaId: string): number | null {
  if (!env.SEND_IMAGES_ENABLED) return null;
  const cutoff = new Date(Date.now() - MS_72H).toISOString();
  return repos.mediaSend.claimSend(phone, mediaId, cutoff);
}

/**
 * Namespace for per-inbound claims, so repeat requests never consume rotation
 * state. Exported because any freshness lookup for a gallery photo must count
 * this namespace too — a canonical-only lookup reports requested sends as never
 * sent and re-serves the same photos forever.
 */
export const REQUESTED_GALLERY_MEDIA_ID_PREFIX = 'requested_gallery_';
const LLM_GALLERY_SHOWN_MEDIA_ID = 'llm_gallery_shown';
const ALL_TIME_CUTOFF = new Date(0).toISOString();

export function hasShownLlmGallery(repos: Repositories, phone: string): boolean {
  return repos.mediaSend.hasRecentSameImage(phone, LLM_GALLERY_SHOWN_MEDIA_ID, ALL_TIME_CUTOFF);
}

export function markLlmGalleryShown(repos: Repositories, phone: string): void {
  repos.mediaSend.claimSend(phone, LLM_GALLERY_SHOWN_MEDIA_ID, ALL_TIME_CUTOFF);
}

/**
 * Explicit customer requests may reuse a photo after the unseen pool is
 * exhausted. The claim key is scoped to the inbound message id, so one photo
 * cannot ship twice while a single inbound is being processed, and a later
 * request is free to ask for the same category again.
 *
 * This is NOT the duplicate-webhook guard: a replay picks different photos and
 * therefore different keys. Meta retries are dropped by `repos.dedupe` in the
 * route before the engine runs.
 */
export function reserveRequestedGalleryImageSend(
  repos: Repositories,
  phone: string,
  mediaId: string,
  messageId = 'legacy-request',
): number | null {
  if (!env.SEND_IMAGES_ENABLED) return null;
  return repos.mediaSend.claimSend(
    phone,
    `${REQUESTED_GALLERY_MEDIA_ID_PREFIX}${messageId}_${mediaId}`,
    new Date(0).toISOString(),
  );
}

export function releaseImageReservation(repos: Repositories, reservationId: number): void {
  repos.mediaSend.releaseClaim(reservationId);
}

/**
 * Configured images-per-send cap. Never more than 5 gallery images in one turn:
 * WhatsApp penalizes media floods.
 */
export function galleryImageLimit(): number {
  return Math.max(0, Math.floor(Math.min(env.MAX_GALLERY_IMAGES_PER_SEND, 5)));
}

export function remainingGalleryImageBudget(repos: Repositories, phone: string): number {
  const now = Date.now();
  const hour = new Date(now - 60 * 60 * 1000).toISOString();
  const day = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const count = (cutoff: string) =>
    repos.mediaSend.countRecentImagesWithPrefix(phone, cutoff, GALLERY_MEDIA_ID_PREFIX)
    + repos.mediaSend.countRecentImagesWithPrefix(phone, cutoff, REQUESTED_GALLERY_MEDIA_ID_PREFIX);
  const hourly = count(hour);
  const daily = count(day);
  return Math.max(0, Math.min(
    env.MAX_GALLERY_IMAGES_PER_CUSTOMER_PER_HOUR - hourly,
    env.MAX_GALLERY_IMAGES_PER_CUSTOMER_PER_DAY - daily,
  ));
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function selectGalleryImages(images: InternalGalleryImage[]): InternalGalleryImage[] {
  const limit = galleryImageLimit();
  if (images.length <= limit) return images;
  return shuffled(images).slice(0, limit);
}

/** Prefix marking a `media_sends` row as a gallery image (vs. a plan/owner image). */
export const GALLERY_MEDIA_ID_PREFIX = 'gallery_';

export function galleryMediaId(image: Pick<InternalGalleryImage, 'url'>): string {
  return `${GALLERY_MEDIA_ID_PREFIX}${new URL(image.url).pathname}`;
}

/**
 * Same namespace as `galleryMediaId`, tolerant of a malformed feed URL: callers
 * holding only a URL string skip the send instead of throwing mid-delivery.
 */
export function galleryMediaIdFromUrl(url: string): string | null {
  try {
    return galleryMediaId({ url });
  } catch {
    return null;
  }
}

/**
 * Separate namespace for gallery photos spent by follow-up outbound (consent ask,
 * template headers).
 *
 * Deliberately NOT `gallery_`: `selectContextualImage` meters its cadence and its
 * 72h ceiling by counting that prefix, so reusing it would let follow-up sends eat
 * the in-conversation photo budget — the exact coupling the cadence comment warns
 * about. Rotation still works because selection and recording share this prefix.
 */
export const FOLLOWUP_GALLERY_MEDIA_ID_PREFIX = 'followup_gallery_';

export function followupGalleryMediaId(image: Pick<InternalGalleryImage, 'url'>): string {
  return `${FOLLOWUP_GALLERY_MEDIA_ID_PREFIX}${new URL(image.url).pathname}`;
}

/**
 * Single-namespace eligibility. **In-conversation callers must not use this** —
 * a requested send is stored under `requested_gallery_<inbound>_…`, so checking
 * only the canonical id reports it as never sent and re-serves the same photo.
 * Use `selectUnseenConversationGalleryImages` instead. This stays for follow-up
 * outbound, which meters its own namespace on purpose.
 */
export function selectEligibleGalleryImages(
  repos: Repositories,
  phone: string,
  images: InternalGalleryImage[],
  limit = 3,
  /** Which namespace to check for "already sent". Callers metering a separate
   *  budget (follow-up outbound) must pass their own id builder. */
  mediaId: (image: Pick<InternalGalleryImage, 'url'>) => string = galleryMediaId,
): InternalGalleryImage[] {
  if (!env.SEND_IMAGES_ENABLED) return [];
  const cutoff = new Date(Date.now() - MS_72H).toISOString();
  const eligible = images.filter(image => !repos.mediaSend.hasRecentSameImage(phone, mediaId(image), cutoff));
  return selectGalleryImages(eligible)
    .slice(0, limit);
}

/**
 * The one freshness rule for photos sent inside a conversation: a photo counts as
 * seen whether it shipped through the canonical `gallery_` id or a per-inbound
 * `requested_gallery_` claim. Every in-conversation selection path must go through
 * this, otherwise repeated requests re-serve the same photos.
 */
export function selectUnseenConversationGalleryImages(
  repos: Repositories,
  phone: string,
  images: InternalGalleryImage[],
  limit = 3,
): InternalGalleryImage[] {
  if (!env.SEND_IMAGES_ENABLED) return [];
  const cutoff = new Date(Date.now() - MS_72H).toISOString();
  const unseen = images.filter(image => {
    const sentAt = galleryImageLastSentAt(repos, phone, image);
    return sentAt === null || sentAt < cutoff;
  });
  return selectGalleryImages(unseen).slice(0, limit);
}

/**
 * Selects gallery images balanced across the requested categories, capped by
 * `MAX_GALLERY_IMAGES_PER_SEND`. Takes one image per category per round from
 * each category's unseen (last 72h) pool, so a photo-rich category cannot
 * crowd out the others. Explicit requests then top up from previously seen
 * photos of the same requested categories; a wrong-category photo is never used.
 *
 * Selection is not permission. This function may return an already-seen photo,
 * but delivery still has to pass, in order: the per-customer volume ceiling
 * (`canSendImage`) and then `reserveRequestedGalleryImageSend`. Those two decide
 * what actually ships, so a repeat offered here can still be refused — which is
 * why the webhook logs the all-claims-refused case instead of failing silently.
 */
export function selectBalancedByCategory(
  repos: Repositories,
  phone: string,
  allImages: InternalGalleryImage[],
  requestedThemes: ResolvedMediaTheme[],
  limit = galleryImageLimit(),
): InternalGalleryImage[] {
  if (!env.SEND_IMAGES_ENABLED || requestedThemes.length === 0 || limit <= 0) return [];

  const cutoff = new Date(Date.now() - MS_72H).toISOString();
  const themes = [...new Map(
    requestedThemes.map(theme => [`${theme.siteId}\0${theme.type}`, theme]),
  ).values()];
  const matchesTheme = (image: InternalGalleryImage, theme: ResolvedMediaTheme) =>
    image.type === theme.type && (image.siteId ?? '') === theme.siteId;
  // Resolved once per call: this used to run two queries per image, and the sort
  // comparator re-ran them O(n log n) times for a photo-rich category.
  const lastSentByUrl = new Map<string, string | null>(
    allImages.map(image => [image.url, galleryImageLastSentAt(repos, phone, image)]),
  );
  const lastSent = (image: InternalGalleryImage) => lastSentByUrl.get(image.url) ?? null;
  const unseenPools = themes
    .map(theme => shuffled(allImages.filter(image => matchesTheme(image, theme)
      && (lastSent(image) === null || lastSent(image)! < cutoff))))
    .filter(pool => pool.length > 0);

  const selected: InternalGalleryImage[] = [];
  appendRoundRobin(unseenPools, selected, limit);

  if (selected.length < limit) {
    const selectedUrls = new Set(selected.map(image => image.url));
    const repeatPools = themes
      .map(theme => allImages
        .filter(image => matchesTheme(image, theme) && !selectedUrls.has(image.url))
        .sort((a, b) => (lastSent(a) ?? '').localeCompare(lastSent(b) ?? '')))
      .filter(pool => pool.length > 0);
    appendRoundRobin(repeatPools, selected, limit);
  }

  return selected;
}

function appendRoundRobin(
  pools: InternalGalleryImage[][],
  selected: InternalGalleryImage[],
  limit: number,
): void {
  const deepest = Math.max(0, ...pools.map(pool => pool.length));
  for (let round = 0; round < deepest && selected.length < limit; round++) {
    for (const pool of pools) {
      if (selected.length >= limit) break;
      const image = pool[round];
      if (image) selected.push(image);
    }
  }
}

/**
 * Last time this photo reached the customer through ANY in-conversation path:
 * the canonical `gallery_` id or a per-inbound `requested_gallery_<id>_` claim.
 * Without the second one, a repeated request keeps re-serving the same photos —
 * every requested send is stored under a fresh key, so canonical-only lookups
 * report them as never sent. Follow-up outbound is deliberately NOT counted: its
 * separate namespace exists so it cannot consume the conversation budget.
 */
export function galleryImageLastSentAt(
  repos: Repositories,
  phone: string,
  image: Pick<InternalGalleryImage, 'url'>,
): string | null {
  return repos.mediaSend.getLastSentAtForImage(
    phone,
    galleryMediaId(image),
    REQUESTED_GALLERY_MEDIA_ID_PREFIX,
  );
}

function pickBest<T extends { planId?: string; url: string; caption: string }>(images: T[], planId: string | null | undefined): T | undefined {
  if (!images.length) return undefined;
  if (planId) {
    const match = images.find(i => i.planId === planId);
    if (match) return match;
  }
  return images[0];
}

export function selectPlanImage(
  dynamicImages: InternalPlanImage[],
  planId: string | null | undefined,
  experienceId: string,
): ResolvedPlanImage | undefined {
  const experienceImages = dynamicImages.filter(image => image.experienceId === experienceId);
  if (!experienceImages.length) return undefined;
  const picked = pickBest(experienceImages, planId);
  if (!picked) return undefined;
  return { id: picked.id, url: picked.url, caption: picked.caption };
}
