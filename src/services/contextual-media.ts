import type { Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { MS_72H, MS_MINUTE } from './constants.js';
import type { InternalGalleryImage } from './dynamic-data-service.js';
import { normalizeText } from './language-service.js';
import { getEntrySegment, getGalleryImages, getTypeKeywords } from './product-registry.js';
import { canSendImage, followupGalleryMediaId, galleryImageLastSentAt, GALLERY_MEDIA_ID_PREFIX, selectEligibleGalleryImages, selectGalleryImages, selectUnseenConversationGalleryImages } from './media-service.js';
import type { Skills } from './skill-loader.js';
import type { EntryMarker } from './entry-marker.js';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Distinct keywords of one type present in already-normalized text. Phrase
 * matched on word boundaries so `bici` does not match `bicicleta` twice.
 */
function countKeywordHits(normalizedText: string, keywords: string[]): number {
  let hits = 0;
  for (const rawKeyword of keywords) {
    const keyword = normalizeText(rawKeyword);
    if (!keyword) continue;
    if (new RegExp(`\\b${escapeRegex(keyword)}\\b`).test(normalizedText)) hits += 1;
  }
  return hits;
}

/**
 * Detects the gallery theme a reply talks about, using the feed's per-type
 * keyword vocabulary. Keywords are phrase-matched against the normalized reply
 * (accent/case-insensitive, `4x4` matches its normalized form). Returns the
 * type with the most distinct matched keywords. An ambiguous tie or no keyword
 * hit returns `null` rather than risking a wrong-theme image.
 */
export function detectMediaType(
  replyText: string,
  typeKeywords: Record<string, string[]>,
): string | null {
  const matches = detectMediaTypes(replyText, typeKeywords);
  if (matches.length === 0) return null;
  const scores = matches.map(type => [type, countKeywordHits(normalizeText(replyText), typeKeywords[type] ?? [])] as const);
  const maxScore = Math.max(...scores.map(([, score]) => score));
  const best = scores.filter(([, score]) => score === maxScore).map(([type]) => type);
  return best.length === 1 ? best[0] : null;
}

export function detectMediaTypes(
  replyText: string,
  typeKeywords: Record<string, string[]>,
): string[] {
  const normalized = normalizeText(replyText);
  if (!normalized) return [];

  const matches: string[] = [];
  for (const [type, keywords] of Object.entries(typeKeywords)) {
    const hits = countKeywordHits(normalized, keywords);
    if (hits > 0) matches.push(type);
  }
  return matches;
}

export function detectRequestedGalleryThemes(
  skills: Skills,
  message: string,
  experienceId: string | null | undefined,
  preferredSiteId?: string | null,
): string[] {
  const images = getGalleryImages(skills, experienceId);
  const siteIds = [...new Set(images.map(image => image.siteId ?? ''))]
    .filter(siteId => !preferredSiteId || siteId === preferredSiteId);
  const sitesByType = new Map<string, Set<string>>();
  for (const siteId of siteIds) {
    const keywords = siteId
      ? getTypeKeywords(skills, experienceId, siteId)
      : getTypeKeywords(skills, experienceId);
    for (const type of detectMediaTypes(message, keywords)) {
      if (!images.some(image => (image.siteId ?? '') === siteId && image.type === type)) continue;
      const sites = sitesByType.get(type) ?? new Set<string>();
      sites.add(siteId);
      sitesByType.set(type, sites);
    }
  }
  // `siteIds` is already narrowed to the preferred site when there is one, so a
  // type surviving here with more than one site is genuinely ambiguous: drop it
  // rather than cue a theme that resolveMediaThemes will refuse.
  return [...sitesByType.entries()]
    .filter(([, sites]) => sites.size === 1)
    .map(([type]) => type);
}

export interface ContextualImageSelection {
  /**
   * Exactly one image or none: it is delivered carrying the reply as its
   * caption, and a caption belongs to a single image.
   */
  image: InternalGalleryImage | null;
  /**
   * The detected theme, but only when this turn actually got that far: a turn
   * skipped by the cadence, volume or probability gate reports `null` even
   * though the reply did match a theme. Diagnostic only — not a "theme was
   * detected" signal.
   */
  type: string | null;
}

/**
 * Selects one gallery image to carry the reply as its caption. A configured entry
 * segment narrows reply-matched themes to its media categories; otherwise the
 * reply's detected theme is used. Cadence and volume are bounded via `media_sends`.
 */
export function selectContextualImage(
  skills: Skills,
  repos: Repositories,
  phone: string,
  replyText: string,
  experienceId?: string | null,
  preferredSiteId?: string | null,
  entryMarker?: EntryMarker | null,
): ContextualImageSelection {
  if (!env.CONTEXTUAL_IMAGES_ENABLED) return { image: null, type: null };

  // Cadence counts contextual (gallery) sends only. Counting every image would
  // couple this to the plan image, which normally fires on the price turn and
  // would then suppress contextual images for the rest of the conversation —
  // exactly the turns where they help most. The gap is minutes-scale so a chat
  // can carry several photos as topics change; the 72h cap is the real ceiling.
  const gapCutoff = new Date(Date.now() - env.CONTEXTUAL_IMAGES_MIN_GAP_MINUTES * MS_MINUTE).toISOString();
  if (repos.mediaSend.countRecentImagesWithPrefix(phone, gapCutoff, GALLERY_MEDIA_ID_PREFIX) > 0) {
    return { image: null, type: null };
  }

  // Hard ceiling on contextual images per customer per 72h. One image per send
  // means this can no longer be overshot within a single reply.
  const volumeCutoff = new Date(Date.now() - MS_72H).toISOString();
  const sentIn72h = repos.mediaSend.countRecentImagesWithPrefix(phone, volumeCutoff, GALLERY_MEDIA_ID_PREFIX);
  if (sentIn72h >= env.CONTEXTUAL_IMAGES_MAX_PER_72H) return { image: null, type: null };

  const experienceImages = getGalleryImages(skills, experienceId);
  const entrySegment = experienceId && entryMarker
    ? getEntrySegment(skills, experienceId, entryMarker.code, preferredSiteId)
    : null;
  const configuredTypes = entrySegment?.segment.contextualMediaTypes ?? [];

  if (entrySegment && configuredTypes.length > 0) {
    const { siteId } = entrySegment;
    const siteKeywords = getTypeKeywords(skills, experienceId, siteId);
    const allowedKeywords: Record<string, string[]> = Object.fromEntries(
      configuredTypes.map(type => [type, siteKeywords[type] ?? []]),
    );
    const type = detectMediaType(replyText, allowedKeywords);
    if (!type) return { image: null, type: null };

    const candidates = experienceImages.filter(image => {
      if (image.type !== type || (image.siteId ?? '') !== siteId) return false;
      const sentAt = galleryImageLastSentAt(repos, phone, image);
      return sentAt === null || sentAt < volumeCutoff;
    });
    if (candidates.length === 0) return { image: null, type: null };
    if (Math.random() >= env.CONTEXTUAL_IMAGES_PROBABILITY) return { image: null, type: null };
    return {
      image: selectUnseenConversationGalleryImages(repos, phone, candidates, 1)[0] ?? null,
      type,
    };
  }

  const siteIds = [...new Set(experienceImages.map(image => image.siteId ?? ''))];
  const siteMatches = siteIds.flatMap(siteId => {
    if (preferredSiteId && siteId !== preferredSiteId) return [];
    const keywords = siteId
      ? getTypeKeywords(skills, experienceId, siteId)
      : getTypeKeywords(skills, experienceId);
    const type = detectMediaType(replyText, keywords);
    if (!type) return [];
    return experienceImages.some(image => (image.siteId ?? '') === siteId && image.type === type)
      ? [{ siteId, type }]
      : [];
  });
  if (siteMatches.length !== 1) return { image: null, type: null };
  const [{ siteId, type }] = siteMatches;

  // Probability gate: a theme-matching reply only sends an image with this
  // probability, so cadence is not a predictable every-turn behavior.
  if (Math.random() >= env.CONTEXTUAL_IMAGES_PROBABILITY) return { image: null, type: null };

  const candidates = experienceImages.filter(image =>
    image.type === type && (image.siteId ?? '') === siteId);
  if (candidates.length === 0) return { image: null, type: null };

  // Shuffled, so the pick is random among the theme's images not already sent to
  // this customer in the last 72h — counting requested-gallery sends too, or the
  // automatic photo could repeat one the customer just asked for and received.
  return {
    image: selectUnseenConversationGalleryImages(repos, phone, candidates, 1)[0] ?? null,
    type,
  };
}

/**
 * Picks one gallery photo of an explicitly named theme, for an outbound that must
 * always carry an image (the follow-up consent ask) rather than one selected from
 * reply text.
 *
 * Differs from `selectContextualImage` on purpose: no keyword detection, no
 * probability roll and no cadence gate, because the caller sends at most one of
 * these per conversation cycle. The 72h dedup is a *preference*, not a veto — if
 * every photo of the theme was already seen, one is reused rather than degrading
 * the ask to plain text. Returns `null` when images are disabled, the theme is
 * empty/unknown, or the feed has no photo of that theme — never a wrong-theme
 * image.
 */
export function selectThemedImage(
  skills: Skills,
  repos: Repositories,
  phone: string,
  type: string,
  experienceId?: string | null,
  preferredSiteId?: string | null,
): InternalGalleryImage | null {
  if (!type) return null;
  if (!canSendImage(repos, phone)) return null;

  const typedCandidates = getGalleryImages(skills, experienceId).filter(image => image.type === type);
  const candidateSites = new Set(typedCandidates.map(image => image.siteId ?? ''));
  if (!preferredSiteId && candidateSites.size > 1) return null;
  const candidates = preferredSiteId
    ? typedCandidates.filter(image => (image.siteId ?? '') === preferredSiteId)
    : typedCandidates;
  if (candidates.length === 0) return null;

  const cutoff = new Date(Date.now() - MS_72H).toISOString();
  const unseenAcrossBoth = candidates.filter(image => {
    const conversationSentAt = galleryImageLastSentAt(repos, phone, image);
    return (conversationSentAt === null || conversationSentAt < cutoff)
      && !repos.mediaSend.hasRecentSameImage(phone, followupGalleryMediaId(image), cutoff);
  });
  const unseen = selectGalleryImages(unseenAcrossBoth)[0];
  if (unseen) return unseen;

  // Preserve follow-up rotation even when every candidate has appeared in the
  // conversation namespace. Namespace budgets remain separate; this is only a
  // selection preference.
  const unseenInFollowup = selectEligibleGalleryImages(
    repos,
    phone,
    candidates,
    1,
    followupGalleryMediaId,
  )[0];
  if (unseenInFollowup) return unseenInFollowup;

  // Pool exhausted. Reuse a RANDOM one rather than always the first, otherwise
  // every further send would show the same photo once the 72h window is full.
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}
