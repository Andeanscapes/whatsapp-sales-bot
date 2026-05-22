import type Database from 'better-sqlite3';
import { env } from '../config/env.js';
import type { MediaSkill } from './skill-loader.js';

export function canSendImage(db: Database.Database, phone: string): boolean {
  if (!env.SEND_IMAGES_ENABLED) return false;

  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const recent = db.prepare(
    'SELECT COUNT(*) as cnt FROM media_sends WHERE customer_phone = ? AND sent_at >= ?'
  ).get(phone, cutoff) as { cnt: number };

  return recent.cnt < env.MAX_IMAGES_PER_CUSTOMER_PER_72H;
}

export function canSendPlanImage(db: Database.Database, phone: string, imageId: string): boolean {
  if (!env.SEND_IMAGES_ENABLED) return false;

  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const recentSameImage = db.prepare(
    'SELECT 1 FROM media_sends WHERE customer_phone = ? AND media_id = ? AND sent_at >= ? LIMIT 1'
  ).get(phone, imageId, cutoff);

  return !recentSameImage;
}

export function recordImageSend(db: Database.Database, phone: string, mediaId: string): void {
  db.prepare(
    'INSERT INTO media_sends (customer_phone, media_id, sent_at) VALUES (?, ?, ?)'
  ).run(phone, mediaId, new Date().toISOString());
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
