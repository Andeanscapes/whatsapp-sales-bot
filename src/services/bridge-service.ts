import type { Repositories } from '../db/repositories/index.js';
import { sendText, uploadMedia, sendImageId, sendVideoId, sendAudioId } from './whatsapp-client.js';
import { isWithinServiceWindow } from './time-window-policy.js';
import { bridgeMessages } from './bridge-messages.js';
import { logger } from '../config/logger.js';

export interface BridgeSendResult {
  ok: boolean;
  message: string;
}

/**
 * A bridge session is abandoned if the agent stops interacting with it. We reap
 * it so a forgotten `/end` never permanently silences the bot for the customer.
 */
const BRIDGE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Resolves whether a customer currently has a live agent bridge. A session is
 * live only when it exists AND is within its TTL. Stale sessions are reaped
 * (closed + conversation mode reverted to `bot`) so the bot resumes replying.
 * Returns true only when the bot must stay silent and forward to the agent.
 */
export function isBridgeActive(repos: Repositories, customerPhone: string, now: Date = new Date()): boolean {
  if (repos.conversation.getMode(customerPhone) !== 'bridge_active') return false;

  const session = repos.bridgeSession.getByCustomer(customerPhone);
  if (!session) {
    repos.conversation.setMode(customerPhone, 'bot');
    return false;
  }

  const age = now.getTime() - new Date(session.lastActivityAt).getTime();
  if (age >= BRIDGE_SESSION_TTL_MS) {
    repos.bridgeSession.close(session.agentChatId);
    repos.conversation.setMode(customerPhone, 'bot');
    return false;
  }

  return true;
}

/**
 * Sends an agent's free-form text to a customer through the WhatsApp API,
 * enforcing the same guards as the bot path: pause, opt-out and the WhatsApp
 * 24h customer-service window. Stores the outbound message on success.
 */
export async function sendBridgeReply(repos: Repositories, customerPhone: string, text: string): Promise<BridgeSendResult> {
  if (repos.isPaused()) {
    return { ok: false, message: bridgeMessages.botPaused };
  }
  if (repos.optOut.isOptedOut(customerPhone)) {
    return { ok: false, message: bridgeMessages.customerOptedOut };
  }
  if (!isWithinServiceWindow(repos, customerPhone)) {
    return { ok: false, message: bridgeMessages.serviceWindowClosed };
  }

  try {
    await sendText(customerPhone, text);
    repos.message.addMessage({
      customer_phone: customerPhone,
      direction: 'outbound',
      message_type: 'text',
      body: text,
      created_at: new Date().toISOString(),
    });
    return { ok: true, message: bridgeMessages.sent(customerPhone) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ err, phone: customerPhone }, '[BRIDGE] send failed');
    return { ok: false, message: bridgeMessages.sendFailed(reason) };
  }
}

/**
 * Relays an agent's media (image, e.g. a payment QR, or a video) to a customer via
 * the WhatsApp API. Enforces the same guards as `sendBridgeReply`. The bytes are
 * uploaded to the WhatsApp account first, then sent by media id with the resolved
 * kind. Stores the outbound on success.
 */
export async function sendBridgeMedia(
  repos: Repositories,
  customerPhone: string,
  media: Buffer,
  mimeType: string,
  caption?: string,
): Promise<BridgeSendResult> {
  if (repos.isPaused()) {
    return { ok: false, message: bridgeMessages.botPaused };
  }
  if (repos.optOut.isOptedOut(customerPhone)) {
    return { ok: false, message: bridgeMessages.customerOptedOut };
  }
  if (!isWithinServiceWindow(repos, customerPhone)) {
    return { ok: false, message: bridgeMessages.serviceWindowClosed };
  }

  try {
    const uploaded = await uploadMedia(media, mimeType);
    if (uploaded.kind === 'video') {
      await sendVideoId(customerPhone, uploaded.id, caption);
    } else if (uploaded.kind === 'audio') {
      await sendAudioId(customerPhone, uploaded.id);
    } else {
      await sendImageId(customerPhone, uploaded.id, caption);
    }
    repos.message.addMessage({
      customer_phone: customerPhone,
      direction: 'outbound',
      message_type: uploaded.kind,
      body: caption ?? '',
      created_at: new Date().toISOString(),
    });
    return { ok: true, message: bridgeMessages.sent(customerPhone) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ err, phone: customerPhone }, '[BRIDGE] media send failed');
    return { ok: false, message: bridgeMessages.sendFailed(reason) };
  }
}
