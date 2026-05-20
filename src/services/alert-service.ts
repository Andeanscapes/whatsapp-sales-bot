import type Database from 'better-sqlite3';
import { env } from '../config/env.js';
import { getSkills } from './skill-loader.js';

const ALERT_FETCH_TIMEOUT_MS = 10_000;

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

async function sendTelegram(text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(ALERT_FETCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
  if (!response.ok) throw new Error(`Telegram alert failed: ${response.status}`);
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

function wasOwnerAlertedToday(db: Database.Database, customerPhone: string, alertType: string): boolean {
  const todayStart = new Date().toISOString().split('T')[0];
  const row = db.prepare(
    "SELECT 1 FROM owner_alerts WHERE customer_phone = ? AND alert_type = ? AND sent_at >= ?"
  ).get(customerPhone, alertType, todayStart);
  return !!row;
}

export async function sendAlert(request: AlertRequest, db: Database.Database): Promise<void> {
  const alertType = request.score >= env.URGENT_LEAD_THRESHOLD ? 'urgent' : 'hot';
  if (wasOwnerAlertedToday(db, request.customerPhone, alertType)) return;

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

  if (env.ALERT_CHANNEL === 'telegram' && env.TELEGRAM_BOT_TOKEN) {
    await sendTelegram(body);
  } else if (env.ALERT_CHANNEL === 'whatsapp') {
    await sendWhatsAppAlert(body);
  } else {
    console.log('[ALERT]', body);
  }

  db.prepare(
    'INSERT INTO owner_alerts (customer_phone, channel, score, alert_type, sent_at, body) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(request.customerPhone, env.ALERT_CHANNEL, request.score, alertType, new Date().toISOString(), body);
}
