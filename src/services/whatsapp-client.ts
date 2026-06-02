import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const WHATSAPP_FETCH_TIMEOUT_MS = 10_000;

export async function sendText(to: string, text: string): Promise<void> {
  const url = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(WHATSAPP_FETCH_TIMEOUT_MS),
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text, preview_url: true },
    }),
  });
  if (!response.ok) {
    logger.warn({ status: response.status }, '[WHATSAPP] text send failed');
    throw new Error(`WhatsApp API error: HTTP ${response.status}`);
  }
}

export async function sendImageUrl(to: string, imageUrl: string, caption: string): Promise<void> {
  const url = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(WHATSAPP_FETCH_TIMEOUT_MS),
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: imageUrl, caption },
    }),
  });
  if (!response.ok) {
    logger.warn({ status: response.status }, '[WHATSAPP] image send failed');
    throw new Error(`WhatsApp API error: HTTP ${response.status}`);
  }
}
