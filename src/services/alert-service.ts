import type { Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { getSkills } from './skill-loader.js';
import { logger } from '../config/logger.js';
import { sendTelegramMessage } from './telegram-bot.js';
import { assignLine, isReferralLine } from './lead-routing.js';
import { bridgeMessages } from './bridge-messages.js';
import { RESERVATION_ALERT_COOLDOWN_MS } from './constants.js';

const ALERT_FETCH_TIMEOUT_MS = 10_000;

let startupWarned = false;

export interface AlertRequest {
  customerPhone: string;
  score: number;
  intent: string;
  message: string;
  name?: string;
  date?: string;
  people?: string;
  transport?: string;
}

async function sendWhatsAppAlert(body: string): Promise<void> {
  const url = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(ALERT_FETCH_TIMEOUT_MS),
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: env.OWNER_PERSONAL_WHATSAPP_NUMBER,
      type: 'text',
      text: { body },
    }),
  });
  if (!response.ok) throw new Error(`WhatsApp owner alert failed: ${response.status}`);
}

function wasOwnerAlertedToday(repos: Repositories, customerPhone: string, alertType: string): boolean {
  return repos.ownerAlert.wasAlertedToday(customerPhone, alertType);
}

function leadTemperatureEmoji(score: number): string {
  if (score >= 60) return '🔥';
  if (score >= 30) return '🌡️';
  return '🧊';
}

export async function sendAlert(request: AlertRequest, repos: Repositories): Promise<void> {
  const alertType = request.intent === 'reservation_handoff' || request.intent === 'reservation_intent' || request.intent === 'unsafe_reservation_blocked' || request.intent === 'policy_violation_blocked' || request.intent === 'system_error' || request.intent === 'dynamic_pricing_unavailable'
    ? request.intent
    : request.score >= env.URGENT_LEAD_THRESHOLD ? 'urgent' : 'hot';
  const repeatableReservationAlert = alertType === 'reservation_handoff' || alertType === 'reservation_intent';
  if (repeatableReservationAlert) {
    const sinceIso = new Date(Date.now() - RESERVATION_ALERT_COOLDOWN_MS).toISOString();
    if (repos.ownerAlert.wasAlertedSince(request.customerPhone, alertType, sinceIso)) {
      logger.info({ customerPhone: request.customerPhone, alertType }, '[ALERT] skipped reservation alert within cooldown');
      return;
    }
  } else if (wasOwnerAlertedToday(repos, request.customerPhone, alertType)) {
    logger.info({ customerPhone: request.customerPhone, alertType }, '[ALERT] skipped duplicate owner alert');
    return;
  }

  const skills = getSkills();
  const template = skills.salesStrategy.ownerAlertTemplate;
  // Sticky, deterministic assignment. Resolving it here locks the owning line as
  // soon as the first alert fires (not only at reservation handoff), so every
  // alert routes to the line that owns the lead. assignLine is idempotent.
  const assignedLine = assignLine(repos, request.customerPhone);

  let body = template
    .replace('{{leadEmoji}}', leadTemperatureEmoji(request.score))
    .replace('{{score}}', String(request.score))
    .replaceAll('{{customerPhone}}', request.customerPhone)
    .replace('{{name}}', request.name ?? 'unknown')
    .replace('{{intent}}', request.intent)
    .replace('{{date}}', request.date ?? 'unknown')
    .replace('{{people}}', request.people ?? 'unknown')
    .replace('{{transportNeed}}', request.transport ?? 'unknown')
    .replace('{{lastMessage}}', request.message);

  let delivered = false;

  if (assignedLine) {
    body = `${body}\n\n${bridgeMessages.alertFooter({
      label: assignedLine.label,
      agentName: assignedLine.agentName,
      type: assignedLine.type,
      bridge: assignedLine.type === 'bridge',
      displayNumber: isReferralLine(assignedLine) ? assignedLine.displayNumber : undefined,
    })}`;
    try {
      await sendTelegramMessage(assignedLine.telegramChatId, body);
      delivered = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ chatId: assignedLine.telegramChatId, reason }, '[ALERT] agent Telegram delivery failed — chat may not have /started the bot');
      // Fallback to the owner chat so a hot lead is never silently lost. A
      // successful fallback still counts as delivered (alert gets recorded).
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && env.TELEGRAM_CHAT_ID !== assignedLine.telegramChatId) {
        try {
          await sendTelegramMessage(env.TELEGRAM_CHAT_ID, bridgeMessages.fallbackAlert(body));
          delivered = true;
        } catch {
          logger.warn({ chatId: env.TELEGRAM_CHAT_ID }, '[ALERT] fallback owner notification also failed');
        }
      }
    }
  } else if (env.ALERT_CHANNEL === 'telegram') {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      if (!startupWarned) {
        logger.warn('[ALERT] ALERT_CHANNEL=telegram but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is empty — alerts will be logged, not sent to Telegram');
        startupWarned = true;
      }
      logger.info({ body }, '[ALERT] log channel (telegram misconfigured)');
      delivered = true;
    } else {
      try {
        await sendTelegramMessage(env.TELEGRAM_CHAT_ID, body);
        delivered = true;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn({ chatId: env.TELEGRAM_CHAT_ID, reason }, '[ALERT] owner Telegram delivery failed');
      }
    }
  } else if (env.ALERT_CHANNEL === 'whatsapp') {
    try {
      await sendWhatsAppAlert(body);
      delivered = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ reason }, '[ALERT] owner WhatsApp delivery failed');
    }
  } else {
    logger.info({ body }, '[ALERT] log channel');
    delivered = true;
  }

  if (delivered) {
    repos.ownerAlert.insert(request.customerPhone, env.ALERT_CHANNEL, request.score, alertType, body);
  }
}
