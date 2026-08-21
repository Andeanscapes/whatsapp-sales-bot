import { logger } from '../config/logger.js';
import { downloadMedia } from '../services/whatsapp-client.js';
import { getConversationReplay, type ConversationReplayItem } from '../services/conversation-media.js';
import type { CommandContext, OutputBlock } from './index.js';

/** Telegram hard-fails a text message over 4096 chars. */
const MAX_TEXT_CHARS = 4000;
/**
 * Telegram's own caption limit. Deliberately NOT WhatsApp's
 * `MAX_IMAGE_CAPTION_CHARS`: the two happen to match today, but borrowing the
 * WhatsApp constant would silently truncate Telegram output if that one changed.
 */
const MAX_TELEGRAM_CAPTION_CHARS = 1024;

const CUSTOMER_PREFIX = '👤';
const BOT_PREFIX = '🤖';

export interface TranscriptStats {
  messages: number;
  photos: number;
  /** Outbound image rows with no ledger entry — pre-ledger history. */
  unresolvedPhotos: number;
}

/** Telegram captions are capped; the transcript must degrade, never fail the send. */
function fitCaption(text: string): string {
  return text.length > MAX_TELEGRAM_CAPTION_CHARS
    ? `${text.slice(0, MAX_TELEGRAM_CAPTION_CHARS - 1)}…`
    : text;
}

function chunkText(text: string): string[] {
  if (text.length <= MAX_TEXT_CHARS) return [text];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += MAX_TEXT_CHARS) {
    chunks.push(text.slice(start, start + MAX_TEXT_CHARS));
  }
  return chunks;
}

/**
 * Turns one replay item into Telegram blocks.
 *
 * Text is emitted WITHOUT a parse mode on purpose: customer messages are
 * arbitrary input and any Markdown escaping bug would either corrupt the
 * transcript or make Telegram reject the whole message.
 */
async function blocksForItem(item: ConversationReplayItem): Promise<OutputBlock[]> {
  const prefix = item.role === 'user' ? CUSTOMER_PREFIX : BOT_PREFIX;

  if (item.kind === 'outbound_photo' && item.mediaUrl) {
    const caption = item.text ? fitCaption(`${prefix} ${item.text}`) : undefined;
    return [{ kind: 'photoUrl', url: item.mediaUrl, caption }];
  }

  if (item.kind === 'inbound_media' && item.mediaId) {
    try {
      // Inbound photos live behind the Graph API and need the bearer token, so
      // they must be downloaded here rather than handed to Telegram as a url.
      const media = await downloadMedia(item.mediaId);
      const caption = item.text ? fitCaption(`${prefix} ${item.text}`) : `${prefix} 📷`;
      return [{ kind: 'photoBuffer', buffer: media.buffer, mimeType: media.mimeType, caption }];
    } catch (err) {
      // WhatsApp expires media ids (~30 days), so this is expected on old threads.
      logger.info({ err, mediaId: item.mediaId.slice(0, 24) }, '[TRANSCRIPT] inbound media unavailable');
      const detail = item.text ? ` ${item.text}` : '';
      return [{ kind: 'text', text: `${prefix} 📷 (foto del cliente no disponible)${detail}` }];
    }
  }

  if (item.kind === 'inbound_media') {
    const detail = item.text ? ` ${item.text}` : '';
    return [{ kind: 'text', text: `${prefix} 📷 (archivo sin referencia)${detail}` }];
  }

  // A stored media row with no ledger entry: the url is genuinely unknown (the
  // turn predates the media ledger). Show the bare glyph — the position in the
  // transcript is the useful signal, and prose here is just noise.
  if (item.messageType === 'image' || item.messageType === 'video' || item.messageType === 'audio') {
    const glyph = item.messageType === 'image' ? '📷' : item.messageType === 'video' ? '🎥' : '🎤';
    const detail = item.text ? ` ${item.text}` : '';
    return [{ kind: 'text', text: `${prefix} ${glyph}${detail}` }];
  }

  if (!item.text) return [];
  return chunkText(`${prefix} ${item.text}`).map(text => ({ kind: 'text', text }) as OutputBlock);
}

/**
 * Emits a faithful replay of the conversation: bot photos with the caption the
 * customer actually saw, customer photos re-downloaded, everything else as text
 * in chronological order.
 *
 * Emission goes through `ctx.emit`, so the dispatcher owns pacing, 429 retries
 * and the flood cap. Returns counts for the command footer.
 */
export async function emitTranscript(
  ctx: CommandContext,
  phone: string,
  limit: number,
): Promise<TranscriptStats> {
  const items = getConversationReplay(ctx.repos, phone, limit);
  const stats: TranscriptStats = { messages: 0, photos: 0, unresolvedPhotos: 0 };

  for (const item of items) {
    const blocks = await blocksForItem(item);
    for (const block of blocks) {
      ctx.emit?.(block);
      if (block.kind === 'photoUrl' || block.kind === 'photoBuffer') stats.photos += 1;
      else stats.messages += 1;
    }
    if (blocks.length === 0) continue;
    const isUnresolved = item.kind !== 'outbound_photo'
      && item.kind !== 'inbound_media'
      && item.messageType === 'image';
    if (isUnresolved) stats.unresolvedPhotos += 1;
  }

  return stats;
}

export function formatTranscriptFooter(stats: TranscriptStats, limit: number): string {
  const parts = [`${stats.messages} mensajes`, `${stats.photos} fotos`];
  // Media whose url was never recorded still counts, so the totals add up and an
  // operator can tell a thread apart from one where photos simply failed to send.
  if (stats.unresolvedPhotos > 0) parts.push(`${stats.unresolvedPhotos} 📷 sin url`);
  return `🧾 Replay: ${parts.join(' · ')} (ultimos ${limit} turnos)`;
}

/** Shared arg parsing so every replay command accepts the same optional turn count. */
export function parseTurnLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
