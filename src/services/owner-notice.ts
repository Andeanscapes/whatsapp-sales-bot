import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { Repositories } from '../db/repositories/index.js';

/** Anything at or before the epoch makes the dedupe window "since forever". */
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

export interface NotifyOwnerOnceOptions {
  /**
   * `day` (default) allows one notice per customer per `alertType` per UTC day.
   * `ever` allows exactly one, forever — required for permanent conditions, where
   * a daily notice would page the operator every day until the end of time.
   */
  scope?: 'day' | 'ever';
}

/**
 * Operator notice capped at one per customer per `alertType` (see `scope`).
 * Recorded in owner_alerts only after a confirmed delivery, so an unconfigured
 * or failing Telegram never burns the slot (same contract as alert-service).
 * Fire-and-forget with a lazy import so callers never take a hard dependency on
 * the Telegram transport.
 *
 * The gate is read before the send and written after it, so two callers racing
 * inside the same delivery can both pass. That is deliberate — reversing it would
 * let a transport failure permanently consume a notice that never arrived — and
 * harmless here, where the cost of a rare duplicate is one extra message.
 */
export function notifyOwnerOnce(
  repos: Repositories,
  customerPhone: string,
  alertType: string,
  body: string,
  options: NotifyOwnerOnceOptions = {},
): void {
  const since = options.scope === 'ever' ? EPOCH_ISO : undefined;
  const alreadySent = since
    ? repos.ownerAlert.wasAlertedSince(customerPhone, alertType, since)
    : repos.ownerAlert.wasAlertedToday(customerPhone, alertType);
  if (alreadySent) return;
  const score = repos.conversation.getLeadScore(customerPhone);
  void (async () => {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
    try {
      const { sendTelegramMessage } = await import('./telegram-bot.js');
      await sendTelegramMessage(env.TELEGRAM_CHAT_ID, body);
      repos.ownerAlert.insert(customerPhone, 'telegram', score, alertType, body);
    } catch (err) {
      logger.warn({ err, customerPhone, alertType }, '[OWNER_NOTICE] delivery failed');
    }
  })();
}
