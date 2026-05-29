import type { Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import type { MediaSkill } from './skill-loader.js';
import { MS_72H } from './constants.js';

export function canSendImage(repos: Repositories, phone: string): boolean {
  if (!env.SEND_IMAGES_ENABLED) return false;

  const cutoff = new Date(Date.now() - MS_72H).toISOString();
  const recent = repos.mediaSend.countRecentImages(phone, cutoff);

  return recent < env.MAX_IMAGES_PER_CUSTOMER_PER_72H;
}

export function canSendPlanImage(repos: Repositories, phone: string, imageId: string): boolean {
  if (!env.SEND_IMAGES_ENABLED) return false;

  const cutoff = new Date(Date.now() - MS_72H).toISOString();
  return !repos.mediaSend.hasRecentSameImage(phone, imageId, cutoff);
}

export function recordImageSend(repos: Repositories, phone: string, mediaId: string): void {
  repos.mediaSend.recordSend(phone, mediaId);
}

export function selectImageForPlan(images: MediaSkill['images'], planId: string | null | undefined): MediaSkill['images'][number] | undefined {
  if (!images.length) return undefined;
  const valid = images.filter(i => i.value !== 'REPLACE_WITH_PUBLIC_IMAGE_URL');
  if (!valid.length) return undefined;
  if (planId) {
    const planImage = valid.find(i => i.planId === planId);
    if (planImage) return planImage;
  }
  return valid[0];
}
