/**
 * Bucket layout for bot media. Pure functions; the restructure script uses them to
 * rewrite catalog URLs, and the tests pin the rules.
 *
 *   whatsapp_bot/media/brand/owner.jpg
 *   whatsapp_bot/media/<experienceId>/<siteId>/gallery/<type>/<NN>.jpg
 *   whatsapp_bot/media/<experienceId>/<siteId>/plans/<tier>/card.png
 */

import path from 'node:path';
import { BOT_PREFIX } from './catalog-media.js';

export const OWNER_KEY = `${BOT_PREFIX}media/brand/owner.jpg`;

/** Pre-restructure owner photo key. */
export const LEGACY_OWNER_KEY = `${BOT_PREFIX}emerald_mining_chivor/heinneryalexandra.jpg`;

/** Pre-restructure plan card: `details/<tier>_2d1n_<site>[_1].png`. */
const LEGACY_PLAN_CARD = /^whatsapp_bot\/details\/(core|prime)_2d1n_([a-z]+)(?:_1)?\.png$/;

/** Gallery file name, `exp_07.jpg` -> `07.jpg`. Other names keep their basename. */
function galleryFileName(legacyKey: string): string {
  const base = path.posix.basename(legacyKey);
  const match = /^exp_(\d+)\.(jpe?g|png)$/i.exec(base);
  return match ? `${match[1].padStart(2, '0')}.${match[2].toLowerCase()}` : base;
}

export function galleryKey(
  experienceId: string,
  siteId: string,
  type: string,
  legacyKey: string,
): string {
  return `${BOT_PREFIX}media/${experienceId}/${siteId}/gallery/${type}/${galleryFileName(legacyKey)}`;
}

export function planCardKey(experienceId: string, siteId: string, tier: string): string {
  return `${BOT_PREFIX}media/${experienceId}/${siteId}/plans/${tier}/card.png`;
}

/**
 * The tier a legacy plan card belongs to, when its file name names the same site
 * as the catalog site. Null for anything else, so unknown cards stay where they are.
 */
export function legacyPlanCardTier(legacyKey: string, siteId: string): string | null {
  const match = LEGACY_PLAN_CARD.exec(legacyKey);
  if (!match || match[2] !== siteId) return null;
  return match[1];
}
