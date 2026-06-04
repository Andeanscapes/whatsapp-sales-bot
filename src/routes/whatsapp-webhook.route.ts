import { createHmac, timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { getSkills } from '../services/skill-loader.js';
import { buildHandedOffReply, processMessage } from '../services/response-engine.js';
import { sendText, sendImageUrl, downloadMedia } from '../services/whatsapp-client.js';
import { recordImageSend, selectImageForPlan, canSendPlanImage } from '../services/media-service.js';
import { sendAlert } from '../services/alert-service.js';
import { sendTelegramMessage, sendTelegramPhoto, sendTelegramVoice } from '../services/telegram-bot.js';
import { getLineById, hasRoutingConfig, isReferralLine } from '../services/lead-routing.js';
import { isBridgeActive } from '../services/bridge-service.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { logger } from '../config/logger.js';
import { logSystemError } from '../services/error-logger.js';

const processingPhones = new Set<string>();

type RequestWithRawBody = FastifyRequest & { rawBody?: Buffer };

function systemErrorRetry(repos: Repositories, phone: string): string {
  const lang = repos.conversation.getLanguage(phone) ?? 'es';
  return getSkills().fallbackReplies[lang].systemErrorRetry;
}

function verifySignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

const messageSchema = z.object({
  from: z.string(),
  id: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  image: z.object({ id: z.string(), mime_type: z.string().optional(), caption: z.string().optional() }).optional(),
  audio: z.object({ id: z.string(), mime_type: z.string().optional() }).optional(),
});

const webhookPayloadSchema = z.object({
  object: z.string(),
  entry: z.array(z.object({
    id: z.string(),
    changes: z.array(z.object({
      value: z.object({
        messaging_product: z.string().optional(),
        messages: z.array(messageSchema).optional(),
      }).passthrough(),
      field: z.string(),
    })),
  })),
}).passthrough();

export interface ExtractedMedia {
  id: string;
  mimeType: string | null;
}

export interface ExtractedMessage {
  from: string;
  id: string;
  type: 'text' | 'image' | 'audio';
  text: string;
  media: ExtractedMedia | null;
  timestamp: string;
}

function extractMessages(body: unknown): ExtractedMessage[] | null {
  const parsed = webhookPayloadSchema.safeParse(body);
  if (!parsed.success) return null;

  const result: ExtractedMessage[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const messages = change.value?.messages;
      if (!messages) continue;
      for (const m of messages) {
        if (m.type === 'text') {
          result.push({ from: m.from, id: m.id, type: 'text', text: m.text?.body ?? '', media: null, timestamp: '' });
        } else if (m.type === 'image' && m.image) {
          result.push({
            from: m.from,
            id: m.id,
            type: 'image',
            text: m.image.caption ?? '',
            media: { id: m.image.id, mimeType: m.image.mime_type ?? null },
            timestamp: '',
          });
        } else if (m.type === 'audio' && m.audio) {
          result.push({
            from: m.from,
            id: m.id,
            type: 'audio',
            text: '',
            media: { id: m.audio.id, mimeType: m.audio.mime_type ?? null },
            timestamp: '',
          });
        }
      }
    }
  }
  return result.length > 0 ? result : null;
}

/**
 * When a human agent is actively bridging this customer (same API line), the
 * bot must stay silent: store the inbound and forward it to the assigned agent.
 * Opted-out customers are ignored. Only a live `bridge_active` session bypasses
 * the bot; `isBridgeActive` reaps stale/abandoned sessions and reverts the mode
 * to `bot`, so the bot resumes and the conversation is never silently dropped.
 * `referred` customers (handed to another line) keep getting bot replies here.
 */
export async function forwardBridgeMessage(repos: Repositories, msg: ExtractedMessage): Promise<boolean> {
  if (!hasRoutingConfig()) return false;
  if (repos.isPaused()) return false;
  if (repos.optOut.isOptedOut(msg.from)) return false;
  if (!isBridgeActive(repos, msg.from)) return false;

  const session = repos.bridgeSession.getByCustomer(msg.from);
  if (!session) return false;

  repos.message.addMessage({
    whatsapp_message_id: msg.id,
    customer_phone: msg.from,
    direction: 'inbound',
    message_type: msg.type,
    body: msg.text,
    created_at: new Date().toISOString(),
    raw_json: null,
  });

  if (msg.type === 'image' && msg.media) {
    // Image relay failure is transient (download/upload), not an abandoned
    // session. Keep the bridge open and tell the agent; the bot cannot reply to
    // an image, so reverting to the bot would silently drop it. Returns true to
    // short-circuit (message already stored + agent informed).
    try {
      const media = await downloadMedia(msg.media.id);
      await sendTelegramPhoto(session.agentChatId, media.buffer, media.mimeType, bridgeMessages.newCustomerImage(msg.from, msg.text));
    } catch (err) {
      logger.warn({ err, phone: msg.from, chatId: session.agentChatId }, '[BRIDGE] customer image relay failed; notifying agent');
      try {
        await sendTelegramMessage(session.agentChatId, bridgeMessages.customerImageFailed(msg.from));
      } catch {
        // agent notification is best-effort
      }
    }
    return true;
  }

  if (msg.type === 'audio' && msg.media) {
    try {
      const media = await downloadMedia(msg.media.id);
      await sendTelegramVoice(session.agentChatId, media.buffer, media.mimeType);
      await sendTelegramMessage(session.agentChatId, bridgeMessages.newCustomerAudio(msg.from));
    } catch (err) {
      logger.warn({ err, phone: msg.from, chatId: session.agentChatId }, '[BRIDGE] customer audio relay failed; notifying agent');
      try {
        await sendTelegramMessage(session.agentChatId, bridgeMessages.customerAudioFailed(msg.from));
      } catch {
        // agent notification is best-effort
      }
    }
    return true;
  }

  try {
    await sendTelegramMessage(session.agentChatId, bridgeMessages.newCustomerMessage(msg.from, msg.text));
    return true;
  } catch (err) {
    logger.warn({ err, phone: msg.from, chatId: session.agentChatId }, '[BRIDGE] failed to notify active agent; resuming bot path');
    repos.bridgeSession.close(session.agentChatId);
    repos.conversation.setMode(msg.from, 'bot');
    return false;
  }
}

export async function forwardPostHandoffMessage(repos: Repositories, msg: ExtractedMessage): Promise<string | null> {
  if (!hasRoutingConfig()) return null;
  if (repos.isPaused()) return null;
  if (repos.optOut.isOptedOut(msg.from)) return null;
  if (!repos.conversation.getHandedOffAt(msg.from)) return null;

  const assignment = repos.conversation.getAssignment(msg.from);
  if (!assignment) return null;

  const line = getLineById(assignment.assignedLineId);
  const isReferral = isReferralLine(line);

  repos.message.addMessage({
    whatsapp_message_id: msg.id,
    customer_phone: msg.from,
    direction: 'inbound',
    message_type: 'text',
    body: msg.text,
    created_at: new Date().toISOString(),
    raw_json: null,
  });

  try {
    await sendTelegramMessage(assignment.assignedAgentChat, bridgeMessages.postHandoffCustomerMessage({
      phone: msg.from,
      text: msg.text,
      bridge: line?.type === 'bridge',
      displayNumber: isReferral ? line.displayNumber : undefined,
    }));
  } catch (err) {
    logger.warn({ err, phone: msg.from, chatId: assignment.assignedAgentChat }, '[HANDOFF] failed to notify assigned agent');
  }

  return buildHandedOffReply(repos, msg.from, msg.text);
}

/**
 * After a /end command, a customer's next message no longer flows through an
 * active bridge, but the agent who previously owned the bridge should still be
 * notified so they can /chat again. The bot stays silent (short-circuits); the
 * agent decides whether to reopen the bridge or let it expire naturally.
 */
export async function notifyAssignedLineIfDormant(repos: Repositories, msg: ExtractedMessage): Promise<boolean> {
  if (!hasRoutingConfig()) return false;
  if (repos.isPaused()) return false;
  if (repos.optOut.isOptedOut(msg.from)) return false;
  if (msg.type !== 'text') return false;
  if (repos.conversation.getMode(msg.from) !== 'bot') return false;
  if (repos.conversation.getHandedOffAt(msg.from)) return false;

  const assignment = repos.conversation.getAssignment(msg.from);
  if (!assignment) return false;

  const line = getLineById(assignment.assignedLineId);
  if (!line || line.type !== 'bridge') return false;

  repos.message.addMessage({
    whatsapp_message_id: msg.id,
    customer_phone: msg.from,
    direction: 'inbound',
    message_type: 'text',
    body: msg.text,
    created_at: new Date().toISOString(),
    raw_json: null,
  });

  try {
    await sendTelegramMessage(assignment.assignedAgentChat, bridgeMessages.dormantBridgeNotice(msg.from, msg.text));
  } catch {
    // best-effort; don't block the bot path on failure
    return false;
  }
  return true;
}

export async function whatsappWebhookRoutes(app: FastifyInstance, opts: { repos: Repositories }): Promise<void> {
  const repos = opts.repos;

  app.addContentTypeParser<Buffer>('application/json', { parseAs: 'buffer' }, function (_req, body, done) {
    (_req as RequestWithRawBody).rawBody = body;
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/webhooks/whatsapp', async (req, reply) => {
    const query = req.query as Record<string, string>;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
      return reply.type('text/plain').send(challenge);
    }
    return reply.code(403).send('Forbidden');
  });

  app.post('/webhooks/whatsapp', async (req, reply) => {
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = (req as RequestWithRawBody).rawBody;
    if (!rawBody || typeof signature !== 'string' || !verifySignature(rawBody, signature, env.WHATSAPP_APP_SECRET)) {
      return reply.code(403).send({ error: 'Invalid signature' });
    }

    reply.code(200).send({ ok: true });

    const messages = extractMessages(req.body);
    if (!messages) return;

    for (const msg of messages) {
      if (repos.dedupe.isProcessed(msg.id)) continue;

      if (processingPhones.has(msg.from)) {
        logger.warn({ phone: msg.from }, '[WEBHOOK] skipped — already processing a message from this phone');
        continue;
      }

      processingPhones.add(msg.from);
      repos.dedupe.markProcessed(msg.id);
      try {
        // Inbound routing precedence: live bridge session > post-handoff notify > bot.
        // The first two short-circuit the AI path entirely (no LLM tokens spent).
        if (await forwardBridgeMessage(repos, msg)) continue;

        // Dormant bridge: the agent ended their /chat but still owns the lead via
        // sticky assignment. Ping them so they can /chat again. Bot stays silent.
        if (await notifyAssignedLineIfDormant(repos, msg)) continue;

        // Non-text (e.g. image) only flows through the live bridge above. The
        // bot and post-handoff text paths cannot consume media, so skip it.
        if (msg.type !== 'text') continue;

        const handoffReply = await forwardPostHandoffMessage(repos, msg);
        if (handoffReply !== null) {
          let sent = false;
          try {
            await sendText(msg.from, handoffReply);
            sent = true;
          } catch (err) {
            logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'handoff_reply' });
          }
          if (sent) {
            repos.message.addMessage({
              customer_phone: msg.from,
              direction: 'outbound',
              message_type: 'text',
              body: handoffReply,
              created_at: new Date().toISOString(),
            });
          }
          continue;
        }

        let result;
        try {
          result = await processMessage({ repos, customerPhone: msg.from, message: msg.text, messageId: msg.id });
        } catch (err) {
          logSystemError('webhook_process', 'error', err, { phone: msg.from });
          const humanFallback = systemErrorRetry(repos, msg.from);
          let sent = false;
          try {
            await sendText(msg.from, humanFallback);
            sent = true;
          } catch (sendErr) {
            logSystemError('whatsapp_send', 'error', sendErr, { phone: msg.from, flow: 'crash_fallback' });
          }
          if (sent) {
            repos.message.addMessage({
              customer_phone: msg.from,
              direction: 'outbound',
              message_type: 'text',
              body: humanFallback,
              created_at: new Date().toISOString(),
            });
          }
          continue;
        }

        if (result.shouldSendReply) {
          let sent = false;
          try {
            await sendText(msg.from, result.reply);
            sent = true;
          } catch (err) {
            logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'bot_reply' });
          }

          if (sent) {
            repos.message.addMessage({
              customer_phone: msg.from,
              direction: 'outbound',
              message_type: 'text',
              body: result.reply,
              created_at: new Date().toISOString(),
            });
          }
        }

        if (result.priceJustGiven) {
          const skills = getSkills();
          const collectedPlan = repos.conversation.getCollectedPlan(msg.from);
          const image = selectImageForPlan(skills.media.images, collectedPlan);
          if (image && image.value !== 'REPLACE_WITH_PUBLIC_IMAGE_URL' && canSendPlanImage(repos, msg.from, image.id)) {
            const caption = result.priceFollowUpText ?? image.caption;
            let sent = false;
            try {
              await sendImageUrl(msg.from, image.value, caption);
              recordImageSend(repos, msg.from, image.id);
              sent = true;
            } catch (err) {
              logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'price_image' });
            }
            if (sent) {
              repos.message.addMessage({
                customer_phone: msg.from,
                direction: 'outbound',
                message_type: 'image',
                body: caption,
                created_at: new Date().toISOString(),
              });
            }
          }
        }

        if (result.shouldSendImage && !result.priceJustGiven) {
          const skills = getSkills();
          const collectedPlan = repos.conversation.getCollectedPlan(msg.from);
          const image = selectImageForPlan(skills.media.images, collectedPlan);
          if (image && image.value !== 'REPLACE_WITH_PUBLIC_IMAGE_URL' && canSendPlanImage(repos, msg.from, image.id)) {
            try {
              await sendImageUrl(msg.from, image.value, image.caption);
              recordImageSend(repos, msg.from, image.id);
            } catch (err) {
              logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'ai_image' });
            }
          }
        }

        if (result.shouldAlertOwner) {
          const conversation = repos.conversation.getByPhone(msg.from);
          try {
            await sendAlert({
              customerPhone: msg.from,
              score: result.leadScore,
              intent: result.ownerAlertType ?? 'lead',
              message: msg.text,
              name: String(conversation?.collected_name ?? 'unknown'),
              date: String(conversation?.collected_date ?? 'unknown'),
              people: String(conversation?.collected_people ?? 'unknown'),
              transport: String(conversation?.collected_transport_need ?? 'unknown'),
            }, repos);
          } catch (err) {
            logSystemError('alert_send', 'error', err, { phone: msg.from, alertType: result.ownerAlertType });
          }
        }
      } catch (err) {
        req.log.error({ err, phone: msg.from }, 'Failed to process webhook message');
      } finally {
        processingPhones.delete(msg.from);
      }
    }
  });
}
