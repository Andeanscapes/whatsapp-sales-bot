import { sendTelegramMessage } from './telegram-bot.js';
import { getRoutingConfig } from './lead-routing.js';
import { logger } from '../config/logger.js';

/**
 * Sends an operator message to every configured sales line's Telegram chat.
 * De-duplicates shared chat IDs and isolates per-line failures so one
 * unreachable line never blocks notifications to the others. No-op when
 * routing is not configured (single-line mode).
 */
export async function broadcastToAllLines(message: string): Promise<void> {
  const config = getRoutingConfig();
  if (!config) return;

  const chatIds = new Set(config.salesLines.map(line => line.telegramChatId));
  for (const chatId of chatIds) {
    try {
      await sendTelegramMessage(chatId, message);
    } catch (err) {
      logger.warn({ err, chatId }, '[BROADCAST] failed to notify line');
    }
  }
}
