import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const MEDIA_FETCH_TIMEOUT_MS = 30_000;

function telegramApiUrl(path: string): string {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}${path}`;
}

export async function sendTelegramDocument(
  chatId: number | string,
  buffer: Buffer,
  filename: string,
  mimeType: string,
  caption?: string,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

  logger.info({ chatId, filename, size: buffer.byteLength, mimeType }, '[TELEGRAM] sending document');
  const response = await fetch(telegramApiUrl('/sendDocument'), {
    method: 'POST',
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    body: form,
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    logger.error({ chatId, status: response.status, body: errBody.slice(0, 300) }, '[TELEGRAM] sendDocument failed');
    throw new Error(`Telegram sendDocument failed: ${response.status} ${errBody}`);
  }
  logger.info({ chatId }, '[TELEGRAM] document sent ok');
}
