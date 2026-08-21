import type { Repositories } from '../db/repositories/index.js';
import { logger } from '../config/logger.js';
import { getSkills } from './skill-loader.js';
import { getGalleryImages } from './product-registry.js';

export interface RecordOutboundMediaInput {
  phone: string;
  url: string;
  mediaId: string;
  /** Caption exactly as sent. Empty string is meaningful: photo shipped with no caption. */
  caption: string;
  /** True when this photo's caption is the bot reply text. */
  carriedReply: boolean;
  flow: string;
  turnInboundMessageId?: string;
  sequence?: number;
}

/**
 * Appends a delivered photo to the replay ledger.
 *
 * Never throws: this runs inside the customer delivery path, and a ledger write
 * must not be able to break a send that already reached the customer. Failures
 * are logged and the row is lost.
 */
export function recordOutboundMedia(repos: Repositories, input: RecordOutboundMediaInput): void {
  try {
    const theme = resolveTheme(input.url);
    repos.outboundMedia.record({
      customer_phone: input.phone,
      media_url: input.url,
      media_id: input.mediaId,
      caption: input.caption,
      carried_reply: input.carriedReply ? 1 : 0,
      flow: input.flow,
      theme_site_id: theme?.siteId,
      theme_type: theme?.type,
      turn_inbound_message_id: input.turnInboundMessageId,
      sequence: input.sequence,
      sent_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err, phone: input.phone, flow: input.flow }, '[MEDIA_LEDGER] failed to record outbound media');
  }
}

/**
 * url -> theme index, rebuilt whenever the gallery array identity changes.
 *
 * This runs on the customer delivery path, so it must not re-scan the whole
 * gallery per photo. Keyed on the array reference because the dynamic feed
 * replaces it wholesale on refresh, which is exactly when the index is stale.
 */
let themeIndexSource: unknown = null;
let themeIndex = new Map<string, { siteId?: string; type?: string }>();

/** Best-effort theme lookup by url. Plan/owner cards are not gallery photos and stay untyped. */
function resolveTheme(url: string): { siteId?: string; type?: string } | null {
  try {
    const gallery = getGalleryImages(getSkills());
    if (gallery !== themeIndexSource) {
      themeIndexSource = gallery;
      themeIndex = new Map(gallery.map(image => [image.url, { siteId: image.siteId, type: image.type }]));
    }
    return themeIndex.get(url) ?? null;
  } catch {
    return null;
  }
}

/**
 * One renderable step of a conversation replay, in chronological order.
 *
 * `outbound_photo` carries the caption the customer actually saw; when that
 * caption is the bot reply it replaces the separate text row so the replay never
 * shows the same reply twice.
 */
export interface ConversationReplayItem {
  kind: 'text' | 'inbound_media' | 'outbound_photo';
  at: string;
  role: 'user' | 'assistant';
  text: string;
  mediaUrl?: string;
  mediaId?: string;
  theme?: string;
  messageType?: string;
}

/**
 * Merge stored messages with the outbound media ledger into a single
 * chronological replay.
 *
 * Caption attribution is exact string equality, not a time heuristic: a ledger
 * row with `carried_reply = 1` whose caption equals an outbound text body means
 * that text shipped as that photo's caption (both derive from the same
 * `result.reply`). The photo takes over the turn and the text row is dropped.
 *
 * Rows older than the message window are ignored so the replay cannot show a
 * photo with no surrounding conversation.
 */
export function getConversationReplay(
  repos: Repositories,
  phone: string,
  limit: number = 20,
): ConversationReplayItem[] {
  const messages = repos.message.getRecentMessages(phone, limit);
  // Ledger rows come newest-first; work chronologically to match the messages.
  const media = repos.outboundMedia.listByPhone(phone, limit * 3).slice().reverse();

  const oldestMessageAt = messages.find(m => m.createdAt)?.createdAt;
  const inWindow = oldestMessageAt
    ? media.filter(m => m.sent_at >= oldestMessageAt)
    : media;

  const consumed = new Set<number>();
  const items: ConversationReplayItem[] = [];

  for (const message of messages) {
    if (message.role === 'assistant' && message.content) {
      const carrier = inWindow.find(
        row =>
          row.carried_reply === 1 &&
          row.caption === message.content &&
          row.id != null &&
          !consumed.has(row.id),
      );
      if (carrier?.id != null) {
        consumed.add(carrier.id);
        items.push({
          kind: 'outbound_photo',
          at: carrier.sent_at,
          role: 'assistant',
          text: carrier.caption ?? '',
          mediaUrl: carrier.media_url,
          mediaId: carrier.media_id,
          theme: carrier.theme_type,
        });
        continue;
      }
    }

    items.push({
      kind: message.mediaId ? 'inbound_media' : 'text',
      at: message.createdAt ?? '',
      role: message.role,
      text: message.content,
      mediaId: message.mediaId,
      messageType: message.messageType,
    });
  }

  // Captionless photos (extra gallery frames, owner/plan cards) were never
  // attached to a text row, so add them and restore chronological order.
  for (const row of inWindow) {
    if (row.id == null || consumed.has(row.id)) continue;
    items.push({
      kind: 'outbound_photo',
      at: row.sent_at,
      role: 'assistant',
      text: row.caption ?? '',
      mediaUrl: row.media_url,
      mediaId: row.media_id,
      theme: row.theme_type,
    });
  }

  // Stable sort: items with no timestamp keep their relative message order.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (!a.item.at || !b.item.at) return a.index - b.index;
      if (a.item.at === b.item.at) return a.index - b.index;
      return a.item.at < b.item.at ? -1 : 1;
    })
    .map(entry => entry.item);
}
