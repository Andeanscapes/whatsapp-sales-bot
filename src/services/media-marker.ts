/**
 * Media request markers — LLM-emitted signals for photo sends.
 *
 * The model ends a reply with `[[FOTOS:theme]]` on its own line. The engine
 * resolves the theme (feed type id or keyword synonym), strips the marker, and
 * delivers gallery photos without the marker reaching the customer.
 *
 * `parseMediaMarker` is deliberately pure — it reports marker placement via
 * `atEnd` instead of logging, so the caller logs with the customer phone.
 */

import { logger } from '../config/logger.js';
import type { Skills } from './skill-loader.js';
import { getGalleryImages, getTypeKeywords } from './product-registry.js';

export const MEDIA_REQUEST_MARKER_PREFIX = '[[FOTOS:';

export interface ParsedMediaMarker {
  /** Stripped reply text (minus the marker line). */
  text: string;
  /** Raw payload from the marker (e.g., 'hacienda,mina'). Lowercase, no accents. */
  requestedThemes: string[];
  /**
   * True when the last marker sits at the very end of the reply, as the prompt
   * requires. False means the model buried it mid-text: every occurrence is
   * still stripped (nothing internal may reach the customer), but the caller
   * logs it, because silently splicing a sentence is how copy gets mangled.
   */
  atEnd: boolean;
}

export interface ResolvedMediaTheme {
  siteId: string;
  type: string;
}

/**
 * Extracts `[[FOTOS:theme]]` markers from a reply. Accepts comma-separated
 * themes, case/accent-insensitive. Returns the stripped text even when the
 * payload is junk; never edits or repairs anything else.
 *
 * Returns `null` if no marker is present (normal path for non-photo replies).
 */
export function parseMediaMarker(reply: string): ParsedMediaMarker | null {
  const matches = [...reply.matchAll(/\[\[FOTOS:([^\]\r\n]*)\]\]/gi)];
  if (matches.length === 0) return null;

  const requestedThemes: string[] = [];
  for (const match of matches) {
    requestedThemes.push(...(match[1] ?? '').split(',').map(normalize).filter(Boolean));
  }

  const last = matches[matches.length - 1];
  const tail = reply.slice((last.index ?? 0) + last[0].length);
  const text = matches
    .reduce((acc, match) => acc.replace(match[0], ''), reply)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    text,
    requestedThemes: [...new Set(requestedThemes)],
    atEnd: tail.trim().length === 0,
  };
}

export function containsMediaMarkerSyntax(text: string): boolean {
  return /\[\[\s*FOTOS\b/i.test(text);
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Resolves theme names/keywords to site-scoped gallery categories. Accepts both:
 * - Feed type ids (e.g., `'mine'`, `'hotel'`)
 * - Feed `typeKeywords` synonyms (e.g., `'hacienda'` → `'hotel'`)
 *
 * Resolution is **site-scoped**: a synonym only resolves against the vocabulary
 * of a site that actually holds photos of that type. Merging vocabularies across
 * sites would let one site's wording pull another site's photos.
 *
 * A preferred plan site wins. Without one, a theme present at multiple sites is
 * ambiguous and is dropped rather than selecting the first site by declaration
 * order. Never invents fallback categories.
 */
export function resolveMediaThemes(
  skills: Skills,
  requestedThemes: string[],
  experienceId?: string | null,
  preferredSiteId?: string | null,
): ResolvedMediaTheme[] {
  const galleryPhotos = getGalleryImages(skills, experienceId);

  if (galleryPhotos.length === 0) {
    logger.warn({ themes: requestedThemes }, '[MEDIA] no gallery photos in media');
    return [];
  }

  // siteId '' covers an unscoped feed, where getTypeKeywords() merges by design.
  const typesBySite = new Map<string, Set<string>>();
  for (const photo of galleryPhotos) {
    if (!photo.type) continue;
    const siteId = photo.siteId ?? '';
    const types = typesBySite.get(siteId) ?? new Set<string>();
    types.add(photo.type);
    typesBySite.set(siteId, types);
  }

  const resolved: ResolvedMediaTheme[] = [];
  for (const theme of requestedThemes) {
    const normalizedTheme = normalize(theme);
    const matches: ResolvedMediaTheme[] = [];

    for (const [siteId, typesWithPhotos] of typesBySite) {
      // Feed type id wins over synonyms — it is what the prompt advertises.
      if (typesWithPhotos.has(normalizedTheme)) {
        matches.push({ siteId, type: normalizedTheme });
        continue;
      }
      const keywordMap = siteId
        ? getTypeKeywords(skills, experienceId, siteId)
        : getTypeKeywords(skills, experienceId);
      const hit = Object.entries(keywordMap).find(([type, keywords]) =>
        typesWithPhotos.has(type) && keywords.some(keyword => normalize(keyword) === normalizedTheme));
      if (hit) matches.push({ siteId, type: hit[0] });
    }

    const match = preferredSiteId
      ? matches.find(candidate => candidate.siteId === preferredSiteId)
      : matches.length === 1 ? matches[0] : undefined;
    if (match) resolved.push(match);
    else logger.warn(
      { theme, preferredSiteId, matchingSites: matches.map(candidate => candidate.siteId) },
      matches.length > 1
        ? '[MEDIA] theme is ambiguous across sites'
        : '[MEDIA] theme not found or no photos for type',
    );
  }

  return [...new Map(resolved.map(theme => [`${theme.siteId}\0${theme.type}`, theme])).values()];
}
