import type { Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { getSkills } from './skill-loader.js';
import { logger } from '../config/logger.js';
import { sendTelegramMessage } from './telegram-bot.js';

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

export async function sendAlert(request: AlertRequest, repos: Repositories): Promise<void> {
  const alertType = request.intent === 'reservation_handoff' || request.intent === 'reservation_intent'
    ? request.intent
    : request.score >= env.URGENT_LEAD_THRESHOLD ? 'urgent' : 'hot';
  if (wasOwnerAlertedToday(repos, request.customerPhone, alertType)) {
    logger.info({ customerPhone: request.customerPhone, alertType }, '[ALERT] skipped duplicate owner alert');
    return;
  }

  const skills = getSkills();
  const template = skills.salesStrategy.ownerAlertTemplate;

  const body = template
    .replace('{{score}}', String(request.score))
    .replaceAll('{{customerPhone}}', request.customerPhone)
    .replace('{{name}}', request.name ?? 'unknown')
    .replace('{{intent}}', request.intent)
    .replace('{{date}}', request.date ?? 'unknown')
    .replace('{{people}}', request.people ?? 'unknown')
    .replace('{{transportNeed}}', request.transport ?? 'unknown')
    .replace('{{lastMessage}}', request.message);

  if (env.ALERT_CHANNEL === 'telegram') {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      if (!startupWarned) {
        logger.warn('[ALERT] ALERT_CHANNEL=telegram but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is empty — alerts will be logged, not sent to Telegram');
        startupWarned = true;
      }
      logger.info({ body }, '[ALERT] log channel (telegram misconfigured)');
    } else {
      await sendTelegramMessage(env.TELEGRAM_CHAT_ID, body);
    }
  } else if (env.ALERT_CHANNEL === 'whatsapp') {
    await sendWhatsAppAlert(body);
  } else {
    logger.info({ body }, '[ALERT] log channel');
  }

  repos.ownerAlert.insert(request.customerPhone, env.ALERT_CHANNEL, request.score, alertType, body);
}
