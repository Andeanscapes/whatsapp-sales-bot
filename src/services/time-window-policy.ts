import type { Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';

export interface TimeWindowResult {
  isLimited: boolean;
  reason?: string;
}

export function checkTimeWindow(repos: Repositories, phone: string): TimeWindowResult {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const hourCount = repos.message.countOutboundSince(phone, oneHourAgo);
  if (hourCount >= env.MAX_BOT_MESSAGES_PER_CUSTOMER_PER_HOUR) {
    return { isLimited: true, reason: 'hourly_limit' };
  }

  const dayCount = repos.message.countOutboundSince(phone, oneDayAgo);
  if (dayCount >= env.MAX_BOT_MESSAGES_PER_CUSTOMER_PER_DAY) {
    return { isLimited: true, reason: 'daily_limit' };
  }

  return { isLimited: false };
}
