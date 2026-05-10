import type Database from 'better-sqlite3';
import { env } from '../config/env.js';

export interface TimeWindowResult {
  isLimited: boolean;
  reason?: string;
}

export function checkTimeWindow(db: Database.Database, phone: string): TimeWindowResult {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const hourCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM messages WHERE customer_phone = ? AND direction = 'outbound' AND created_at >= ?"
  ).get(phone, oneHourAgo) as { cnt: number };

  if (hourCount.cnt >= env.MAX_BOT_MESSAGES_PER_CUSTOMER_PER_HOUR) {
    return { isLimited: true, reason: 'hourly_limit' };
  }

  const dayCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM messages WHERE customer_phone = ? AND direction = 'outbound' AND created_at >= ?"
  ).get(phone, oneDayAgo) as { cnt: number };

  if (dayCount.cnt >= env.MAX_BOT_MESSAGES_PER_CUSTOMER_PER_DAY) {
    return { isLimited: true, reason: 'daily_limit' };
  }

  return { isLimited: false };
}
