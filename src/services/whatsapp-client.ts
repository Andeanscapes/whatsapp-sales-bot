import { env } from '../config/env.js';

const WHATSAPP_FETCH_TIMEOUT_MS = 10_000;

interface WhatsAppApiError {
  status: number;
  body: string;
}

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
      text: { body: text },
    }),
  });
  if (!response.ok) {
    const error: WhatsAppApiError = { status: response.status, body: await response.text() };
    throw new Error(`WhatsApp API error: ${error.status} ${error.body}`);
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
    const error: WhatsAppApiError = { status: response.status, body: await response.text() };
    throw new Error(`WhatsApp image API error: ${error.status} ${error.body}`);
  }
}
