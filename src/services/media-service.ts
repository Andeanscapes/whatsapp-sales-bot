import type { Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import type { InternalGalleryImage, InternalPlanImage } from './dynamic-data-service.js';
import { MS_72H } from './constants.js';

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

export function hasGalleryNudge(repos: Repositories, phone: string): boolean {
  return repos.conversation.getByPhone(phone)?.gallery_nudged_at != null;
}

export function recordGalleryNudge(repos: Repositories, phone: string): void {
  repos.conversation.upsert(phone, { gallery_nudged_at: new Date().toISOString() });
}

export function selectGalleryImages(images: InternalGalleryImage[]): InternalGalleryImage[] {
  const limit = Math.max(0, Math.floor(env.MAX_GALLERY_IMAGES_PER_SEND));
  if (images.length <= limit) return images;

  const shuffled = [...images];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, limit);
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
): ResolvedPlanImage | undefined {
  if (!dynamicImages.length) return undefined;
  const picked = pickBest(dynamicImages, planId);
  if (!picked) return undefined;
  return { id: picked.id, url: picked.url, caption: picked.caption };
}
