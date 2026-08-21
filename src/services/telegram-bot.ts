import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { logSystemError } from './error-logger.js';
import type { Repositories } from '../db/repositories/index.js';
import { getAllCommands, getCommand, registerCommand, type CommandContext, type OutputBlock } from '../commands/index.js';
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
import { paymentHandler } from '../commands/payment.command.js';
import { pauseHandler } from '../commands/pause.command.js';
import { resumeHandler } from '../commands/resume.command.js';
import { statusHandler } from '../commands/status.command.js';
import { statsHandler } from '../commands/stats.command.js';
import { deleteHandler } from '../commands/delete.command.js';
import { daysummaryHandler } from '../commands/daysummary.command.js';
import { metaLeadsHandler } from '../commands/meta-leads.command.js';
import { versionHandler } from '../commands/version.command.js';
import { retryflowHandler } from '../commands/retryflow.command.js';
import { returnbotHandler } from '../commands/returnbot.command.js';
import { stopbotHandler } from '../commands/stopbot.command.js';
import { stopallHandler } from '../commands/stopall.command.js';
import { followupGrantHandler } from '../commands/followup-grant.command.js';
import { followupRevokeHandler } from '../commands/followup-revoke.command.js';
import { followupStatusHandler } from '../commands/followup-status.command.js';
import { followupDigestHandler } from '../commands/followup-digest.command.js';
import { isAllowedTelegramChat, isBridgeTelegramChat, isOwnerChat } from './lead-routing.js';
import { sendBridgeReply, sendBridgeMedia } from './bridge-service.js';
import { bridgeMessages } from './bridge-messages.js';
import { sendTelegramDocument } from './telegram-document.js';
import { isCdnMediaUrl } from './dynamic-data-schema.js';
import { MAX_MEDIA_BYTES, MAX_VIDEO_BYTES, MAX_AUDIO_BYTES } from './whatsapp-client.js';

const ALERT_FETCH_TIMEOUT_MS = 10_000;
/** Binary media transfers (photo download/upload) need more headroom than quick API calls. */
const MEDIA_FETCH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;

function telegramApiUrl(path: string): string {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}${path}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Telegram 429. Carries the advertised delay so the caller can retry the same send. */
export class TelegramRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Telegram rate limited: retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'TelegramRateLimitError';
  }
}

const DEFAULT_RETRY_AFTER_MS = 5_000;

/**
 * Telegram reports the backoff in the JSON body (`parameters.retry_after`,
 * seconds); the `Retry-After` header is frequently absent, so the body is the
 * primary source and the header only a fallback.
 */
function parseRetryAfterMs(rawBody: string, response: Response): number {
  try {
    const parsed = JSON.parse(rawBody) as { parameters?: { retry_after?: number } };
    const seconds = parsed.parameters?.retry_after;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  } catch {
    // Non-JSON body — fall through to the header.
  }
  const header = Number(response.headers.get('Retry-After'));
  return Number.isFinite(header) && header > 0 ? header * 1000 : DEFAULT_RETRY_AFTER_MS;
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

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
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
    document?: TelegramDocument;
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

  logger.info({ chatId, textLen: text.length }, '[TELEGRAM] sending message');
  const response = await fetch(telegramApiUrl('/sendMessage'), {
    method: 'POST',
    signal: AbortSignal.timeout(ALERT_FETCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // 429 is retryable and must be distinguishable: a dropped text block means the
    // command silently answers nothing. Subclasses Error, so existing callers that
    // catch broadly are unaffected.
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(await response.text(), response);
      logger.warn({ chatId, retryAfterMs, status: response.status }, '[TELEGRAM] sendMessage rate limited');
      throw new TelegramRateLimitError(retryAfterMs);
    }
    logger.error({ chatId, status: response.status }, '[TELEGRAM] sendMessage failed');
    throw new Error(`Telegram sendMessage failed: ${response.status}`);
  }
  logger.info({ chatId }, '[TELEGRAM] message sent ok');
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

  logger.info({ chatId, mimeType, size: photo.byteLength, hasCaption: !!caption }, '[TELEGRAM] sending photo');
  const response = await fetch(telegramApiUrl('/sendPhoto'), {
    method: 'POST',
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    body: form,
  });
  if (!response.ok) {
    logger.error({ chatId, status: response.status }, '[TELEGRAM] sendPhoto failed');
    throw new Error(`Telegram sendPhoto failed: ${response.status}`);
  }
  logger.info({ chatId }, '[TELEGRAM] photo sent ok');
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
  logger.info({ fileId: fileId.slice(0, 40), maxBytes }, '[TELEGRAM] downloading file');
  const metaRes = await fetch(telegramApiUrl(`/getFile?file_id=${encodeURIComponent(fileId)}`), {
    signal: AbortSignal.timeout(ALERT_FETCH_TIMEOUT_MS),
  });
  if (!metaRes.ok) {
    logger.error({ status: metaRes.status }, '[TELEGRAM] getFile failed');
    throw new Error(`Telegram getFile failed: ${metaRes.status}`);
  }
  const meta = (await metaRes.json()) as { ok: boolean; result?: { file_path?: string; file_size?: number } };
  const filePath = meta.result?.file_path;
  if (!meta.ok || !filePath) {
    logger.error({ fileId: fileId.slice(0, 40), ok: meta.ok }, '[TELEGRAM] getFile missing file_path');
    throw new Error('Telegram getFile missing file_path');
  }
  if (meta.result?.file_size && meta.result.file_size > maxBytes) {
    logger.warn({ declared: meta.result.file_size, maxBytes }, '[TELEGRAM] file size exceeds limit');
    throw new Error(`Telegram file exceeds WhatsApp media limit ${maxBytes} bytes (declared ${meta.result.file_size})`);
  }

  const binRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`, {
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
  });
  if (!binRes.ok) {
    logger.error({ status: binRes.status, filePath: filePath.slice(0, 40) }, '[TELEGRAM] file download failed');
    throw new Error(`Telegram file download failed: ${binRes.status}`);
  }
  const buffer = Buffer.from(await binRes.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    logger.warn({ actual: buffer.byteLength, maxBytes }, '[TELEGRAM] file size exceeds limit');
    throw new Error(`Telegram file exceeds WhatsApp media limit ${maxBytes} bytes (actual ${buffer.byteLength})`);
  }
  const mimeType = binRes.headers.get('content-type') ?? 'image/jpeg';
  logger.info({ mimeType, size: buffer.byteLength }, '[TELEGRAM] file downloaded ok');
  return { buffer, mimeType };
}

export async function sendTelegramPhotoUrl(
  chatId: number | string,
  url: string,
  caption?: string,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const body: Record<string, unknown> = {
    chat_id: String(chatId),
    photo: url,
  };
  if (caption) body.caption = caption;

  logger.info({ chatId, url: url.slice(0, 80) }, '[TELEGRAM] sending photo from url');
  const response = await fetch(telegramApiUrl('/sendPhoto'), {
    method: 'POST',
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(text, response);
      logger.warn({ chatId, retryAfterMs, status: response.status }, '[TELEGRAM] sendPhotoUrl rate limited');
      throw new TelegramRateLimitError(retryAfterMs);
    }
    // Body is Telegram's own error description; it never contains the bot token.
    logger.error({ chatId, status: response.status, body: text.slice(0, 200) }, '[TELEGRAM] sendPhotoUrl failed');
    throw new Error(`Telegram sendPhotoUrl failed: ${response.status}`);
  }
  logger.info({ chatId }, '[TELEGRAM] photo from url sent ok');
}

/** Telegram accepts 2–10 items in one album. */
export const MAX_MEDIA_GROUP_ITEMS = 10;

/**
 * Sends 2–10 remote photos as a single album — one API request instead of one
 * per photo. A gallery burst therefore arrives at once instead of trickling in,
 * and it mirrors how the customer received it on WhatsApp.
 *
 * Per-item captions are preserved, so the reply-carrying frame still shows the
 * bot's text under the right photo. Callers must pass at most ONE captioned item
 * (`planSendUnits` enforces it): Telegram renders a group caption only when a
 * single item has one, and silently shows nothing when several do.
 */
export async function sendTelegramMediaGroup(
  chatId: number | string,
  items: { url: string; caption?: string }[],
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  if (items.length === 0) return;
  if (items.length === 1) return sendTelegramPhotoUrl(chatId, items[0].url, items[0].caption);
  if (items.length > MAX_MEDIA_GROUP_ITEMS) {
    throw new Error(`Telegram media group exceeds ${MAX_MEDIA_GROUP_ITEMS} items (${items.length})`);
  }

  const media = items.map(item => ({
    type: 'photo',
    media: item.url,
    ...(item.caption ? { caption: item.caption } : {}),
  }));

  logger.info({ chatId, count: items.length }, '[TELEGRAM] sending media group');
  const response = await fetch(telegramApiUrl('/sendMediaGroup'), {
    method: 'POST',
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), media }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(text, response);
      logger.warn({ chatId, retryAfterMs }, '[TELEGRAM] sendMediaGroup rate limited');
      throw new TelegramRateLimitError(retryAfterMs);
    }
    logger.error({ chatId, status: response.status, body: text.slice(0, 200) }, '[TELEGRAM] sendMediaGroup failed');
    throw new Error(`Telegram sendMediaGroup failed: ${response.status}`);
  }
  logger.info({ chatId, count: items.length }, '[TELEGRAM] media group sent ok');
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

  logger.info({ chatId, mimeType, size: voice.byteLength }, '[TELEGRAM] sending voice');
  const response = await fetch(telegramApiUrl('/sendVoice'), {
    method: 'POST',
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    body: form,
  });
  if (!response.ok) {
    logger.error({ chatId, status: response.status }, '[TELEGRAM] sendVoice failed');
    throw new Error(`Telegram sendVoice failed: ${response.status}`);
  }
  logger.info({ chatId }, '[TELEGRAM] voice sent ok');
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

/** Hard ceiling on messages one command may produce, so a replay cannot flood a chat. */
const MAX_COMMAND_BLOCKS = 40;
/**
 * Small courtesy gap between sends — NOT a rate-limit workaround.
 *
 * Telegram's "one message per second" guidance targets groups (hard limit 20/min);
 * private chats tolerate bursts. Sequential awaits already serialise the sends,
 * and a real throttle surfaces as 429, which is retried with the delay Telegram
 * itself advertises. A fixed 1.2s gap here made a 20-turn replay take ~25s, which
 * is why it is deliberately near-zero.
 */
const BLOCK_SPACING_MS = 60;
const MAX_BLOCK_ATTEMPTS = 3;

/**
 * A single Telegram API call: one block, or a run of consecutive remote photos
 * collapsed into one album.
 */
type SendUnit =
  | { kind: 'block'; block: OutputBlock }
  | { kind: 'album'; items: { url: string; caption?: string }[] };

/**
 * Groups consecutive `photoUrl` blocks into albums so a gallery burst costs one
 * request instead of N. Buffers are left alone: uploading them in an album needs
 * multipart `attach://` handling, and inbound photos arrive one at a time anyway.
 *
 * A captioned photo CLOSES the run, so an album never carries more than one
 * caption. Telegram shows a group caption only when exactly one item has one;
 * with two or more it shows none, and a replay of two consecutive photo turns
 * (each carrying its reply as the caption) hid both bot texts entirely.
 */
function planSendUnits(blocks: OutputBlock[]): SendUnit[] {
  const units: SendUnit[] = [];
  let run: { url: string; caption?: string }[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    // A lone photo is cheaper and renders larger as a normal sendPhoto.
    units.push(run.length === 1
      ? { kind: 'block', block: { kind: 'photoUrl', url: run[0].url, caption: run[0].caption } }
      : { kind: 'album', items: run });
    run = [];
  };

  for (const block of blocks) {
    if (block.kind === 'photoUrl') {
      run.push({ url: block.url, caption: block.caption });
      // The caption-carrying photo is the last of its turn, so the gallery it
      // belongs to still ships as a single album.
      if (block.caption || run.length === MAX_MEDIA_GROUP_ITEMS) flush();
      continue;
    }
    flush();
    units.push({ kind: 'block', block });
  }
  flush();
  return units;
}

/** Telegram accepts up to 10 MB for an uploaded photo. */
const MAX_UPLOAD_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Downloads a catalog photo so it can be uploaded to Telegram directly.
 *
 * Telegram's own URL fetcher refuses some perfectly valid CDN objects (it caches
 * negative results, throttles itself, and is picky about certain edges), which
 * used to degrade a real photo into a bare link. Fetching server-side and
 * uploading the bytes sidesteps that entirely.
 *
 * Host is pinned to the catalog CDN — this must never become a general fetcher
 * for arbitrary urls.
 */
async function fetchCatalogPhoto(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!isCdnMediaUrl(url)) throw new Error('Refusing to fetch a non-catalog media url');

  const response = await fetch(url, { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Catalog photo fetch failed: ${response.status}`);

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_PHOTO_BYTES) {
    throw new Error(`Catalog photo exceeds ${MAX_UPLOAD_PHOTO_BYTES} bytes (declared ${declared})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_UPLOAD_PHOTO_BYTES) {
    throw new Error(`Catalog photo exceeds ${MAX_UPLOAD_PHOTO_BYTES} bytes (actual ${buffer.byteLength})`);
  }
  return { buffer, mimeType: response.headers.get('content-type') ?? 'image/jpeg' };
}

/**
 * Delivers one photo, escalating only through strategies that have NOT been tried
 * for this photo yet. Returns false when the operator ended up without an image.
 *
 * `tryUrlFirst` exists to keep the url attempt exactly once per photo. A single
 * `photoUrl` block has already been attempted by url in the main loop, so
 * repeating it here would not only waste a call: `sendTelegramPhotoUrl` can fail
 * on a 30s timeout for a send Telegram actually accepted, and re-sending would
 * post the same photo twice. An album item is different — the batch call never
 * attempted the items individually, so the url is still worth one try.
 */
async function deliverPhotoResiliently(
  chatId: number,
  url: string,
  caption: string | undefined,
  options: { tryUrlFirst: boolean },
): Promise<boolean> {
  if (options.tryUrlFirst) {
    try {
      await sendTelegramPhotoUrl(chatId, url, caption);
      return true;
    } catch (urlErr) {
      if (urlErr instanceof TelegramRateLimitError) throw urlErr;
      logger.warn({ chatId, url: url.slice(0, 80), err: urlErr }, '[TELEGRAM] url photo refused — retrying as upload');
    }
  }

  try {
    const photo = await fetchCatalogPhoto(url);
    await sendTelegramPhoto(chatId, photo.buffer, photo.mimeType, caption);
    logger.info({ chatId, url: url.slice(0, 80) }, '[TELEGRAM] photo delivered as upload');
    return true;
  } catch (uploadErr) {
    if (uploadErr instanceof TelegramRateLimitError) throw uploadErr;
    logger.warn({ chatId, url: url.slice(0, 80), err: uploadErr }, '[TELEGRAM] photo upload also failed — degrading to link');
    return false;
  }
}

function describeBlockFallback(block: OutputBlock): string | null {
  if (block.kind === 'photoUrl') {
    return block.caption
      ? `📷 ${block.caption}\n${block.url}`
      : `📷 ${block.url}`;
  }
  if (block.kind === 'photoBuffer') {
    return block.caption ? `📷 ${block.caption}` : '📷 (imagen no disponible)';
  }
  return null;
}

async function sendOneBlock(chatId: number, block: OutputBlock): Promise<void> {
  switch (block.kind) {
    case 'text':
      return sendTelegramMessage(chatId, block.text, block.parseMode);
    case 'photoUrl':
      return sendTelegramPhotoUrl(chatId, block.url, block.caption);
    case 'photoBuffer':
      return sendTelegramPhoto(chatId, block.buffer, block.mimeType, block.caption);
    case 'document':
      // Returns a boolean rather than throwing; surface a failure so the block
      // retry/fallback path behaves like every other kind.
      if (!await sendTelegramDocument(chatId, block.buffer, block.filename, block.caption ?? '')) {
        throw new Error('Telegram sendDocument reported failure');
      }
      return;
  }
}

async function sendOneUnit(chatId: number, unit: SendUnit): Promise<void> {
  return unit.kind === 'album'
    ? sendTelegramMediaGroup(chatId, unit.items)
    : sendOneBlock(chatId, unit.block);
}

/**
 * Renders command output in order, one API call at a time.
 *
 * Ordering is the reason this stays sequential: firing concurrently would let
 * Telegram deliver a replay out of chronological order, which defeats the point.
 * Consecutive photos are collapsed into albums so the common case is a handful of
 * calls, not one per message.
 *
 * A 429 retries the SAME unit after the delay Telegram advertises — advancing
 * instead would silently drop it, and for the trailing text block that means the
 * command answers nothing. An album that still fails degrades to individual
 * photos, then to text lines carrying the urls; a failed text block is logged.
 */
async function renderCommandBlocks(chatId: number, blocks: OutputBlock[]): Promise<void> {
  const units = planSendUnits(blocks);

  for (const [index, unit] of units.entries()) {
    if (index > 0) await sleep(BLOCK_SPACING_MS);

    let delivered = false;
    for (let attempt = 1; attempt <= MAX_BLOCK_ATTEMPTS; attempt += 1) {
      try {
        await sendOneUnit(chatId, unit);
        delivered = true;
        break;
      } catch (err) {
        const retryAfterMs = err instanceof TelegramRateLimitError ? err.retryAfterMs : null;
        if (retryAfterMs != null && attempt < MAX_BLOCK_ATTEMPTS) {
          logger.warn({ chatId, retryAfterMs, unit: unit.kind }, '[TELEGRAM] rate limited — retrying same unit');
          await sleep(retryAfterMs);
          continue;
        }
        logger.warn({ err, chatId, unit: unit.kind }, '[TELEGRAM] unit render failed');
        break;
      }
    }
    if (delivered) continue;

    // An album can fail because of a single bad url, so recover photo by photo:
    // Telegram-fetch, then byte upload, then a link as the last resort.
    const photos: { url: string; caption?: string }[] = unit.kind === 'album'
      ? unit.items
      : unit.block.kind === 'photoUrl'
        ? [{ url: unit.block.url, caption: unit.block.caption }]
        : [];

    if (photos.length > 0) {
      // Album items were only ever attempted as a batch, so a per-item url try is
      // still new. A single photo already had its url attempt above.
      const tryUrlFirst = unit.kind === 'album';
      for (const photo of photos) {
        let recovered = false;
        try {
          recovered = await deliverPhotoResiliently(chatId, photo.url, photo.caption, { tryUrlFirst });
        } catch (retryErr) {
          logger.warn({ err: retryErr, chatId }, '[TELEGRAM] photo recovery aborted');
        }
        if (recovered) continue;
        const link = describeBlockFallback({ kind: 'photoUrl', url: photo.url, caption: photo.caption });
        if (!link) continue;
        try {
          await sendTelegramMessage(chatId, link);
        } catch (fallbackErr) {
          logger.warn({ err: fallbackErr, chatId }, '[TELEGRAM] block fallback also failed');
        }
      }
      continue;
    }

    if (unit.kind === 'album') continue;
    const fallback = describeBlockFallback(unit.block);
    if (!fallback) continue;
    try {
      await sendTelegramMessage(chatId, fallback);
    } catch (fallbackErr) {
      logger.warn({ err: fallbackErr, chatId }, '[TELEGRAM] block fallback also failed');
    }
  }
}

export async function processUpdate(update: TelegramUpdate, repos: Repositories): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const hasPhoto = !!msg.photo && msg.photo.length > 0;
  const hasVideo = !!msg.video;
  const hasVoice = !!msg.voice;
  const hasVideoDocument = !!msg.document?.mime_type?.startsWith('video/');
  if (!msg.text && !hasPhoto && !hasVideo && !hasVoice && !hasVideoDocument) return;

  const chatIdStr = String(msg.chat.id);
  if (!isAllowedTelegramChat(chatIdStr)) {
    logger.warn({ chatId: chatIdStr, username: msg.from.username }, '[TELEGRAM_BOT] ignored message from unregistered chat');
    return;
  }

  // A photo, video, video document, or voice note (no command) relays the agent's media to the bridged customer.
  if (hasPhoto || hasVideo || hasVoice || hasVideoDocument) {
    if (!isBridgeTelegramChat(chatIdStr)) return;
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
    } else if (hasVideoDocument) {
      fileId = msg.document!.file_id;
      maxBytes = MAX_VIDEO_BYTES;
      mimeType = msg.document!.mime_type ?? 'video/mp4';
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
      logSystemError('bridge_relay', 'error', err, { chatId: chatIdStr, agentChatId: msg.from?.id });
      logger.error({ err, chatId: chatIdStr }, '[TELEGRAM_BOT] bridge media relay failed');
      await sendTelegramMessage(msg.chat.id, bridgeMessages.sendFailed(err instanceof Error ? err.message : String(err)));
    }
    return;
  }

  const text = msg.text ?? '';
  const parsed = parseCommand(text);
  if (!parsed) {
    // Guard: a `text` starting with `/` that failed to parse should never reach
    // the customer. If a future command char is not recognized, reject it rather
    // than relaying the literal text (which might contain a lead's phone number
    // when the operator mistyped a command while a bridge was open).
    if (text.startsWith('/')) {
      await sendTelegramMessage(msg.chat.id, 'Comando no reconocido. Usa /help para ver la lista.');
      return;
    }
    if (!isBridgeTelegramChat(chatIdStr)) return;
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

  if (cmd.ownerOnly && (msg.chat.type !== 'private' || !isOwnerChat(String(msg.from.id)))) {
    await sendTelegramMessage(msg.chat.id, bridgeMessages.ownerOnlyCommand);
    return;
  }

  const blocks: OutputBlock[] = [];
  let droppedBlocks = 0;

  const ctx: CommandContext = {
    repos,
    args: parsed.args,
    chatId: msg.chat.id,
    emit: (block: OutputBlock) => {
      if (blocks.length >= MAX_COMMAND_BLOCKS) {
        droppedBlocks += 1;
        return;
      }
      blocks.push(block);
    },
  };

  try {
    const reply = await cmd.handler(ctx);
    // The handler's own text is always last: for a bridge command it is the
    // call-to-action, and it must land after any replay it emitted.
    if (reply) blocks.push({ kind: 'text', text: reply, parseMode: 'Markdown' });
    if (droppedBlocks > 0) {
      logger.warn(
        { chatId: msg.chat.id, command: parsed.command, droppedBlocks, cap: MAX_COMMAND_BLOCKS },
        '[TELEGRAM] command output truncated at block cap',
      );
    }
    await renderCommandBlocks(msg.chat.id, blocks);
  } catch (err) {
    logSystemError('telegram_command', 'error', err, { command: parsed.command, chatId: String(msg.chat.id) });
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
    description: 'Perfil de cliente + replay con fotos',
    usage: '<telefono> [turnos]',
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
    description: 'Replay del lead con fotos reales',
    usage: '<telefono> [turnos]',
    handler: leadHandler,
  });

  registerCommand({
    name: 'chat',
    description: 'Abrir bridge con lead asignado (incluye replay)',
    usage: '<telefono> [turnos]',
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
    ownerOnly: true,
    handler: blockHandler,
  });

  registerCommand({
    name: 'delete',
    description: 'Eliminar datos de un cliente para pruebas',
    usage: '<telefono>',
    ownerOnly: true,
    handler: deleteHandler,
  });

  registerCommand({
    name: 'booking',
    description: 'Confirmar reserva (pago recibido) de un lead',
    usage: '<telefono>',
    handler: bookingHandler,
  });

  registerCommand({
    name: 'payment',
    description: 'Crear y enviar enlace Mercado Pago despues de validar disponibilidad',
    usage: '<telefono> confirm',
    ownerOnly: true,
    handler: paymentHandler,
  });

  registerCommand({
    name: 'followupgrant',
    description: 'Aprobar follow-up template para cliente',
    usage: '<telefono>',
    ownerOnly: true,
    handler: followupGrantHandler,
  });

  registerCommand({
    name: 'followuprevoke',
    description: 'Revocar follow-up template para cliente',
    usage: '<telefono>',
    ownerOnly: true,
    handler: followupRevokeHandler,
  });

  registerCommand({
    name: 'followupstatus',
    description: 'Diagnostico de follow-up de un lead',
    usage: '<telefono>',
    ownerOnly: true,
    handler: followupStatusHandler,
  });

  registerCommand({
    name: 'followupdigest',
    description: 'Follow-ups programados y enviados de un dia',
    usage: '[hoy|ayer]',
    ownerOnly: true,
    handler: followupDigestHandler,
  });

  registerCommand({
    name: 'pause',
    description: 'Pausar respuestas del bot a clientes',
    usage: '',
    ownerOnly: true,
    handler: pauseHandler,
  });

  registerCommand({
    name: 'resume',
    description: 'Reactivar respuestas del bot',
    usage: '',
    ownerOnly: true,
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
    name: 'version',
    description: 'Version desplegada de la app',
    usage: '',
    handler: versionHandler,
  });

  registerCommand({
    name: 'retryflow',
    description: 'Reenviar ultimo mensaje del lead al flujo bot',
    usage: '<telefono>',
    ownerOnly: true,
    handler: retryflowHandler,
  });

  registerCommand({
    name: 'returnbot',
    description: 'Devolver lead al modo bot (cierra bridge/handoff)',
    usage: '<telefono>',
    ownerOnly: true,
    handler: returnbotHandler,
  });

  registerCommand({
    name: 'stopbot',
    description: 'Silenciar bot para un cliente (solo responde humano)',
    usage: '<telefono>',
    ownerOnly: true,
    handler: stopbotHandler,
  });

  registerCommand({
    name: 'stopall',
    description: 'Silenciar bot para un cliente (alias de /stopbot)',
    usage: '<telefono>',
    ownerOnly: true,
    handler: stopallHandler,
  });

  registerCommand({
    name: 'summary',
    description: 'Resumen de conversaciones (texto + JSON)',
    usage: '<hoy|ayer|week|month|todo>',
    ownerOnly: true,
    handler: daysummaryHandler,
  });

  registerCommand({
    name: 'daysummary',
    description: 'Alias de /summary',
    usage: '<hoy|ayer|week|month|todo>',
    ownerOnly: true,
    handler: daysummaryHandler,
  });

  registerCommand({
    name: 'metaleads',
    description: 'Exportar leads sin reserva para Meta (CSV)',
    usage: '',
    ownerOnly: true,
    handler: metaLeadsHandler,
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

export async function startTelegramBot(repos: Repositories): Promise<ReturnType<typeof setInterval> | undefined> {
  if (!env.TELEGRAM_POLLING_ENABLED) {
    logger.info('[TELEGRAM_BOT] polling disabled');
    return undefined;
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    logger.info('[TELEGRAM_BOT] skipping — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    return undefined;
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
          logSystemError('telegram_update', 'error', err, { updateId: update.update_id });
          logger.error({ err, updateId: update.update_id }, '[TELEGRAM_BOT] update processing failed');
        }
      }
    } catch (err) {
      logSystemError('telegram_poll', 'warning', err, { lastUpdateId });
      logger.error({ err }, '[TELEGRAM_BOT] poll error');
    } finally {
      isPolling = false;
    }
  }, POLL_INTERVAL_MS);

  return interval;
}
