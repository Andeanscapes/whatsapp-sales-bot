import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { Repositories } from '../db/repositories/index.js';
import { getAllCommands, getCommand, registerCommand, type CommandContext } from '../commands/index.js';
import { reportHandler } from '../commands/report.command.js';
import { leadsHandler } from '../commands/leads.command.js';
import { recentHandler } from '../commands/recent.command.js';
import { customerHandler } from '../commands/customer.command.js';
import { sendHandler } from '../commands/send.command.js';
import { leadHandler } from '../commands/lead.command.js';
import { chatHandler } from '../commands/chat.command.js';
import { endHandler } from '../commands/end.command.js';
import { phasesHandler } from '../commands/phases.command.js';
import { blockHandler } from '../commands/block.command.js';
import { bookingHandler } from '../commands/booking.command.js';
import { pauseHandler } from '../commands/pause.command.js';
import { resumeHandler } from '../commands/resume.command.js';
import { statusHandler } from '../commands/status.command.js';
import { statsHandler } from '../commands/stats.command.js';
import { isAllowedTelegramChat } from './lead-routing.js';
import { sendBridgeReply, sendBridgeMedia } from './bridge-service.js';
import { bridgeMessages } from './bridge-messages.js';
 import { MAX_MEDIA_BYTES, MAX_VIDEO_BYTES, MAX_AUDIO_BYTES } from './whatsapp-client.js';

const ALERT_FETCH_TIMEOUT_MS = 10_000;
/** Binary media transfers (photo download/upload) need more headroom than quick API calls. */
const MEDIA_FETCH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;

function telegramApiUrl(path: string): string {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}${path}`;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  mime_type?: string;
  duration?: number;
  file_size?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
    video?: TelegramVideo;
    voice?: TelegramVoice;
  };
}

export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  parseMode?: string,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const body: Record<string, unknown> = { chat_id: String(chatId), text };
  if (parseMode) body.parse_mode = parseMode;

  const response = await fetch(telegramApiUrl('/sendMessage'), {
    method: 'POST',
    signal: AbortSignal.timeout(ALERT_FETCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed: ${response.status} ${errBody}`);
  }
}

export async function sendTelegramPhoto(
  chatId: number | string,
  photo: Buffer,
  mimeType: string,
  caption?: string,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('photo', new Blob([new Uint8Array(photo)], { type: mimeType }), 'photo');

  const response = await fetch(telegramApiUrl('/sendPhoto'), {
    method: 'POST',
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    body: form,
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Telegram sendPhoto failed: ${response.status} ${errBody}`);
  }
}

export interface DownloadedTelegramFile {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Downloads a Telegram file by file_id. Telegram requires two steps: getFile to
 * resolve the storage path, then fetch the binary from the file API. The bot
 * token is only used server-side here; the resolved URL is never forwarded.
 */
export async function downloadTelegramFile(fileId: string, maxBytes: number = MAX_MEDIA_BYTES): Promise<DownloadedTelegramFile> {
  const metaRes = await fetch(telegramApiUrl(`/getFile?file_id=${encodeURIComponent(fileId)}`), {
    signal: AbortSignal.timeout(ALERT_FETCH_TIMEOUT_MS),
  });
  if (!metaRes.ok) {
    throw new Error(`Telegram getFile failed: ${metaRes.status}`);
  }
  const meta = (await metaRes.json()) as { ok: boolean; result?: { file_path?: string; file_size?: number } };
  const filePath = meta.result?.file_path;
  if (!meta.ok || !filePath) throw new Error('Telegram getFile missing file_path');
  if (meta.result?.file_size && meta.result.file_size > maxBytes) {
    throw new Error(`Telegram file exceeds ${maxBytes} bytes (declared ${meta.result.file_size})`);
  }

  const binRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`, {
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
  });
  if (!binRes.ok) {
    throw new Error(`Telegram file download failed: ${binRes.status}`);
  }
  const buffer = Buffer.from(await binRes.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Telegram file exceeds ${maxBytes} bytes (actual ${buffer.byteLength})`);
  }
  const mimeType = binRes.headers.get('content-type') ?? 'image/jpeg';
  return { buffer, mimeType };
}

export async function sendTelegramVoice(
  chatId: number | string,
  voice: Buffer,
  mimeType: string,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('voice', new Blob([new Uint8Array(voice)], { type: mimeType }), 'voice');

  const response = await fetch(telegramApiUrl('/sendVoice'), {
    method: 'POST',
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    body: form,
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Telegram sendVoice failed: ${response.status} ${errBody}`);
  }
}

function parseCommand(text: string): { command: string; args: string[] } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(@[a-zA-Z0-9_]+)?(?:\s+(.*))?$/s);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const rest = match[3] ?? '';
  const args = rest.length > 0 ? rest.split(/\s+/) : [];

  return { command, args };
}

export async function processUpdate(update: TelegramUpdate, repos: Repositories): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const hasPhoto = !!msg.photo && msg.photo.length > 0;
  const hasVideo = !!msg.video;
  const hasVoice = !!msg.voice;
  if (!msg.text && !hasPhoto && !hasVideo && !hasVoice) return;

  const chatIdStr = String(msg.chat.id);
  if (!isAllowedTelegramChat(chatIdStr)) {
    logger.warn({ chatId: chatIdStr, username: msg.from.username }, '[TELEGRAM_BOT] ignored message from unregistered chat');
    return;
  }

  // A photo, video, or voice note (no command) relays the agent's media to the bridged customer.
  if (hasPhoto || hasVideo || hasVoice) {
    const session = repos.bridgeSession.getByAgentChat(chatIdStr);
    if (!session) {
      await sendTelegramMessage(msg.chat.id, bridgeMessages.imageNoActiveChat);
      return;
    }

    let fileId: string;
    let maxBytes: number;
    let mimeType: string;
    if (hasVoice) {
      fileId = msg.voice!.file_id;
      maxBytes = MAX_AUDIO_BYTES;
      mimeType = msg.voice!.mime_type ?? 'audio/ogg';
    } else if (hasVideo) {
      fileId = msg.video!.file_id;
      maxBytes = MAX_VIDEO_BYTES;
      mimeType = msg.video!.mime_type ?? 'video/mp4';
    } else {
      fileId = msg.photo![msg.photo!.length - 1].file_id;
      maxBytes = MAX_MEDIA_BYTES;
      mimeType = ''; // defer to download content-type
    }
    try {
      const file = await downloadTelegramFile(fileId, maxBytes);
      const resolvedMime = mimeType || file.mimeType;
      const result = await sendBridgeMedia(repos, session.customerPhone, file.buffer, resolvedMime, msg.caption);
      if (result.ok) repos.bridgeSession.touch(chatIdStr);
      await sendTelegramMessage(msg.chat.id, result.message);
    } catch (err) {
      logger.error({ err, chatId: chatIdStr }, '[TELEGRAM_BOT] bridge media relay failed');
      await sendTelegramMessage(msg.chat.id, bridgeMessages.sendFailed(err instanceof Error ? err.message : String(err)));
    }
    return;
  }

  const text = msg.text ?? '';
  const parsed = parseCommand(text);
  if (!parsed) {
    const session = repos.bridgeSession.getByAgentChat(chatIdStr);
    if (!session) return;

    const result = await sendBridgeReply(repos, session.customerPhone, text);
    if (result.ok) repos.bridgeSession.touch(chatIdStr);
    await sendTelegramMessage(msg.chat.id, result.message);
    return;
  }

  const cmd = getCommand(parsed.command);
  if (!cmd) {
    await sendTelegramMessage(msg.chat.id, 'Comando no reconocido. Usa /help para ver la lista.');
    return;
  }

  const ctx: CommandContext = {
    repos,
    args: parsed.args,
    chatId: msg.chat.id,
  };

  try {
    const reply = await cmd.handler(ctx);
    await sendTelegramMessage(msg.chat.id, reply, 'Markdown');
  } catch (err) {
    logger.error({ err, command: parsed.command }, '[TELEGRAM_BOT] command handler failed');
    await sendTelegramMessage(msg.chat.id, 'Error procesando el comando.');
  }
}

export function registerCommands(): void {
  registerCommand({
    name: 'report',
    description: 'Reporte diario de estadisticas',
    usage: '',
    handler: reportHandler,
  });

  registerCommand({
    name: 'leads',
    description: 'Top hot leads',
    usage: '[n]',
    handler: leadsHandler,
  });

  registerCommand({
    name: 'recent',
    description: 'Actividad reciente',
    usage: '[n]',
    handler: recentHandler,
  });

  registerCommand({
    name: 'customer',
    description: 'Perfil completo de cliente',
    usage: '<telefono>',
    handler: customerHandler,
  });

  registerCommand({
    name: 'send',
    description: 'Enviar WhatsApp a cliente',
    usage: '<telefono> <mensaje>',
    handler: sendHandler,
  });

  registerCommand({
    name: 'lead',
    description: 'Historial limpio de lead',
    usage: '<telefono>',
    handler: leadHandler,
  });

  registerCommand({
    name: 'chat',
    description: 'Abrir bridge con lead asignado',
    usage: '<telefono>',
    handler: chatHandler,
  });

  registerCommand({
    name: 'end',
    description: 'Cerrar bridge activo',
    usage: '',
    handler: endHandler,
  });

  registerCommand({
    name: 'phases',
    description: 'Pipeline por fase de ventas',
    usage: '',
    handler: phasesHandler,
  });

  registerCommand({
    name: 'block',
    description: 'Bloquear numero (opt-out)',
    usage: '<telefono>',
    handler: blockHandler,
  });

  registerCommand({
    name: 'booking',
    description: 'Confirmar reserva (pago recibido) de un lead',
    usage: '<telefono>',
    handler: bookingHandler,
  });

  registerCommand({
    name: 'pause',
    description: 'Pausar respuestas del bot a clientes',
    usage: '',
    handler: pauseHandler,
  });

  registerCommand({
    name: 'resume',
    description: 'Reactivar respuestas del bot',
    usage: '',
    handler: resumeHandler,
  });

  registerCommand({
    name: 'status',
    description: 'Estado del bot, estadisticas y leads por linea',
    usage: '',
    handler: statusHandler,
  });

  registerCommand({
    name: 'stats',
    description: 'Estadisticas comparativas por periodo (hoy, ayer, semana, todo)',
    usage: '<hoy|ayer|semana|todo>',
    handler: statsHandler,
  });

  registerCommand({
    name: 'help',
    description: 'Lista de comandos disponibles',
    usage: '',
    handler: async () => {
      const commands = getAllCommands();
      const lines = ['*Comandos disponibles:*', ''];
      for (const c of commands) {
        const label = c.usage ? `/${c.name} ${c.usage}` : `/${c.name}`;
        lines.push(`${label} — ${c.description}`);
      }
      return lines.join('\n');
    },
  });
}

export async function startTelegramBot(repos: Repositories): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    logger.info('[TELEGRAM_BOT] skipping — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    return;
  }

  registerCommands();

  let lastUpdateId = 0;

  try {
    const url = telegramApiUrl(`/getUpdates?offset=-1&limit=1&timeout=5`);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const data = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
      if (data.ok && data.result.length > 0) {
        lastUpdateId = data.result[0].update_id;
      }
    }
  } catch {
    // ignore — will start from 0
  }

  logger.info({ chatId: env.TELEGRAM_CHAT_ID }, '[TELEGRAM_BOT] polling started');

  // A batch (e.g. a phone album → many photo updates) can take longer to process
  // than POLL_INTERVAL_MS. Without this guard, the next tick re-fetches the same
  // updates (offset only advances after each finishes) → duplicate sends + 400s.
  let isPolling = false;

  const interval = setInterval(async () => {
    if (isPolling) return;
    isPolling = true;
    try {
      const url = telegramApiUrl(`/getUpdates?offset=${lastUpdateId + 1}&timeout=5`);
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return;

      const data = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
      if (!data.ok || !Array.isArray(data.result)) return;

      for (const update of data.result) {
        // Acknowledge (advance offset) BEFORE processing so a slow batch is never
        // re-fetched, even if processing throws mid-way.
        lastUpdateId = update.update_id;
        try {
          await processUpdate(update, repos);
        } catch (err) {
          logger.error({ err, updateId: update.update_id }, '[TELEGRAM_BOT] update processing failed');
        }
      }
    } catch (err) {
      logger.error({ err }, '[TELEGRAM_BOT] poll error');
    } finally {
      isPolling = false;
    }
  }, POLL_INTERVAL_MS);

  process.on('SIGTERM', () => clearInterval(interval));
  process.on('SIGINT', () => clearInterval(interval));
}
