import type Database from 'better-sqlite3';
import { env } from '../config/env.js';

export function canSendImage(db: Database.Database, phone: string): boolean {
  if (!env.SEND_IMAGES_ENABLED) return false;

  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const recent = db.prepare(
    'SELECT COUNT(*) as cnt FROM media_sends WHERE customer_phone = ? AND sent_at >= ?'
  ).get(phone, cutoff) as { cnt: number };

  return recent.cnt < env.MAX_IMAGES_PER_CUSTOMER_PER_72H;
}

export function recordImageSend(db: Database.Database, phone: string, mediaId: string): void {
  db.prepare(
    'INSERT INTO media_sends (customer_phone, media_id, sent_at) VALUES (?, ?, ?)'
  ).run(phone, mediaId, new Date().toISOString());
}
