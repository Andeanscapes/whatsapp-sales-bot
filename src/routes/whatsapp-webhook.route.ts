import { createHmac, timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { getSkills } from '../services/skill-loader.js';
import { buildHandedOffReply, processMessage } from '../services/response-engine.js';
import { sendText, sendImageUrl, downloadMedia } from '../services/whatsapp-client.js';
import { canSendImage, recordGalleryNudge, recordImageSend, selectGalleryImages, selectPlanImage, canSendPlanImage } from '../services/media-service.js';
import { sendAlert } from '../services/alert-service.js';
import { sendTelegramMessage, sendTelegramPhoto, sendTelegramVoice } from '../services/telegram-bot.js';
import { getLineById, hasRoutingConfig, isBridgeTelegramChat, isReferralLine } from '../services/lead-routing.js';
import { getOwnerImage, getDynamicPlanImages, getGalleryImages } from '../services/product-registry.js';
import { isBridgeActive } from '../services/bridge-service.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { isSoftCloseMessage } from '../services/reply-guard.js';
import { logger } from '../config/logger.js';
import { logSystemError } from '../services/error-logger.js';

const processingPhones = new Map<string, Promise<void>>();

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

function safeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const messageSchema = z.object({
  from: z.string(),
  id: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  image: z.object({ id: z.string(), mime_type: z.string().optional(), caption: z.string().optional() }).optional(),
  audio: z.object({ id: z.string(), mime_type: z.string().optional() }).optional(),
  video: z.object({ id: z.string(), mime_type: z.string().optional(), caption: z.string().optional() }).optional(),
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
  type: 'text' | 'image' | 'audio' | 'video';
  text: string;
  media: ExtractedMedia | null;
  timestamp: string;
}

export function extractMessages(body: unknown): ExtractedMessage[] | null {
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
        } else if (m.type === 'video' && m.video) {
          result.push({
            from: m.from,
            id: m.id,
            type: 'video',
            text: m.video.caption ?? '',
            media: { id: m.video.id, mimeType: m.video.mime_type ?? null },
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
  if (repos.isPaused()) return false;
  if (repos.optOut.isOptedOut(msg.from)) return false;
  if (!isBridgeActive(repos, msg.from)) return false;

  const session = repos.bridgeSession.getByCustomer(msg.from);
  if (!session) return false;
  if (!isBridgeTelegramChat(session.agentChatId)) {
    repos.bridgeSession.close(session.agentChatId);
    repos.conversation.setMode(msg.from, 'bot');
    return false;
  }

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

  if (msg.type === 'video') {
    try {
      await sendTelegramMessage(session.agentChatId, bridgeMessages.newCustomerVideo(msg.from));
    } catch (err) {
      logger.warn({ err, phone: msg.from, chatId: session.agentChatId }, '[BRIDGE] customer video notify failed; keeping bridge active');
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

  if (isSoftCloseMessage(msg.text)) {
    repos.message.addMessage({
      whatsapp_message_id: msg.id,
      customer_phone: msg.from,
      direction: 'inbound',
      message_type: 'text',
      body: msg.text,
      created_at: new Date().toISOString(),
      raw_json: null,
    });
    repos.conversation.setSoftClosed(msg.from);
    repos.conversation.clearHandoff(msg.from);
    const skills = getSkills();
    const lang = repos.conversation.getLanguage(msg.from) ?? 'es';
    const igUrl = skills.andeanScapes.business.socialLinks?.instagram ?? '';
    return skills.fallbackReplies[lang].softCloseReply.replace('{{instagramUrl}}', igUrl);
  }

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

export async function forwardPostHandoffMedia(repos: Repositories, msg: ExtractedMessage): Promise<boolean> {
  if (msg.type === 'text') return false;
  if (!hasRoutingConfig()) return false;
  if (repos.isPaused()) return false;
  if (repos.optOut.isOptedOut(msg.from)) return false;
  if (!repos.conversation.getHandedOffAt(msg.from)) return false;

  const assignment = repos.conversation.getAssignment(msg.from);
  if (!assignment) return false;

  repos.message.addMessage({
    whatsapp_message_id: msg.id,
    customer_phone: msg.from,
    direction: 'inbound',
    message_type: msg.type,
    body: msg.text || '',
    created_at: new Date().toISOString(),
    raw_json: null,
  });

  try {
    if (msg.type === 'image' && msg.media) {
      try {
        const media = await downloadMedia(msg.media.id);
        await sendTelegramPhoto(assignment.assignedAgentChat, media.buffer, media.mimeType, bridgeMessages.dormantBridgeImageNotice(msg.from));
      } catch (err) {
        logger.warn({ err, phone: msg.from, chatId: assignment.assignedAgentChat }, '[HANDOFF] image download failed; sending text notice');
        await sendTelegramMessage(assignment.assignedAgentChat, bridgeMessages.dormantBridgeImageNotice(msg.from));
      }
    } else if (msg.type === 'audio' && msg.media) {
      try {
        const media = await downloadMedia(msg.media.id);
        await sendTelegramVoice(assignment.assignedAgentChat, media.buffer, media.mimeType);
        await sendTelegramMessage(assignment.assignedAgentChat, bridgeMessages.dormantBridgeAudioNotice(msg.from));
      } catch (err) {
        logger.warn({ err, phone: msg.from, chatId: assignment.assignedAgentChat }, '[HANDOFF] audio download failed; sending text notice');
        await sendTelegramMessage(assignment.assignedAgentChat, bridgeMessages.dormantBridgeAudioNotice(msg.from));
      }
    } else if (msg.type === 'video') {
      await sendTelegramMessage(assignment.assignedAgentChat, bridgeMessages.dormantBridgeVideoNotice(msg.from));
    } else {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * Legacy handed-off conversations without a live bridge still notify their
 * assigned agent. A normal alert-only assignment must not enter this path: the
 * bot continues until an agent explicitly runs /bridge.
 */
export async function notifyAssignedLineIfDormant(repos: Repositories, msg: ExtractedMessage): Promise<boolean> {
  if (!hasRoutingConfig()) return false;
  if (repos.isPaused()) return false;
  if (repos.optOut.isOptedOut(msg.from)) return false;
  if (repos.conversation.getMode(msg.from) !== 'bot') return false;
  if (repos.conversation.getHandedOffAt(msg.from)) return false;

  const assignment = repos.conversation.getAssignment(msg.from);
  if (!assignment) return false;

  const line = getLineById(assignment.assignedLineId);
  if (!line || line.type !== 'bridge') return false;

  // Text continues into processMessage, which owns inbound persistence.
  // Non-text never reaches the bot path, so store here once.
  if (msg.type !== 'text') {
    repos.message.addMessage({
      whatsapp_message_id: msg.id,
      customer_phone: msg.from,
      direction: 'inbound',
      message_type: msg.type,
      body: msg.text || '',
      created_at: new Date().toISOString(),
      raw_json: null,
    });
  }

  try {
    if (msg.type === 'image' && msg.media) {
      try {
        const media = await downloadMedia(msg.media.id);
        await sendTelegramPhoto(assignment.assignedAgentChat, media.buffer, media.mimeType, bridgeMessages.dormantBridgeImageNotice(msg.from));
      } catch (err) {
        logger.warn({ err, phone: msg.from, chatId: assignment.assignedAgentChat }, '[BRIDGE] dormant image download failed; sending text notice');
        await sendTelegramMessage(assignment.assignedAgentChat, bridgeMessages.dormantBridgeImageNotice(msg.from));
      }
    } else if (msg.type === 'audio' && msg.media) {
      try {
        const media = await downloadMedia(msg.media.id);
        await sendTelegramVoice(assignment.assignedAgentChat, media.buffer, media.mimeType);
        await sendTelegramMessage(assignment.assignedAgentChat, bridgeMessages.dormantBridgeAudioNotice(msg.from));
      } catch (err) {
        logger.warn({ err, phone: msg.from, chatId: assignment.assignedAgentChat }, '[BRIDGE] dormant audio download failed; sending text notice');
        await sendTelegramMessage(assignment.assignedAgentChat, bridgeMessages.dormantBridgeAudioNotice(msg.from));
      }
    } else if (msg.type === 'video') {
      await sendTelegramMessage(assignment.assignedAgentChat, bridgeMessages.dormantBridgeVideoNotice(msg.from));
    } else {
      await sendTelegramMessage(assignment.assignedAgentChat, bridgeMessages.dormantBridgeNotice(msg.from, msg.text));
    }
  } catch {
    // best-effort; never short-circuit the bot
  }
  return false;
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

    if (mode === 'subscribe' && safeStringEqual(token ?? '', env.WHATSAPP_VERIFY_TOKEN)) {
      return reply.type('text/plain').send(challenge);
    }
    return reply.code(403).send('Forbidden');
  });

  app.post('/webhooks/whatsapp', async (req, reply) => {
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = (req as RequestWithRawBody).rawBody;
    if (!rawBody || typeof signature !== 'string' || !verifySignature(rawBody, signature, env.WHATSAPP_APP_SECRET)) {
      logger.warn({ hasBody: !!rawBody, hasSig: typeof signature === 'string' }, '[WEBHOOK] POST signature verification failed');
      return reply.code(403).send({ error: 'Invalid signature' });
    }

    reply.code(200).send({ ok: true });

    const messages = extractMessages(req.body);
    if (!messages) return;

    for (const msg of messages) {
      logger.info({ from: msg.from, type: msg.type, msgId: msg.id, preview: msg.type === 'text' ? msg.text.slice(0, 80) : '(non-text)' }, '[WEBHOOK] incoming WhatsApp message');
      if (repos.dedupe.isProcessed(msg.id)) continue;

      repos.dedupe.markProcessed(msg.id);
      const prev = processingPhones.get(msg.from) ?? Promise.resolve();
      const task = prev.then(async () => {
        try {
          // Inbound routing precedence: live bridge session > post-handoff notify > bot.
          if (await forwardBridgeMessage(repos, msg)) return;
          if (await notifyAssignedLineIfDormant(repos, msg)) return;
          if (await forwardPostHandoffMedia(repos, msg)) return;
          if (msg.type !== 'text') return;

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
            return;
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
              const conv = repos.conversation.getByPhone(msg.from);
              try {
                await sendAlert({
                  customerPhone: msg.from,
                  score: repos.conversation.getLeadScore(msg.from),
                  intent: 'system_error',
                  message: msg.text,
                  name: String(conv?.collected_name ?? 'unknown'),
                  date: String(conv?.collected_date ?? 'unknown'),
                  people: String(conv?.collected_people ?? 'unknown'),
                  transport: String(conv?.collected_transport_need ?? 'unknown'),
                }, repos);
              } catch (alertErr) {
                logSystemError('alert_send', 'error', alertErr, { phone: msg.from, alertType: 'system_error' });
              }
            }
            return;
          }

          if (result.shouldSendReply) {
            logger.info({ phone: msg.from, replyLen: result.reply.length, usedAi: result.usedAi, score: result.leadScore, alert: result.shouldAlertOwner, image: result.shouldSendImage }, '[WEBHOOK] bot reply triggered');
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

              if (result.shouldSendOwnerImage) {
                const skills = getSkills();
                const ownerImg = getOwnerImage(skills);
                if (ownerImg && canSendImage(repos, msg.from) && canSendPlanImage(repos, msg.from, 'owner_intro')) {
                  let imageSent = false;
                  try {
                    await sendImageUrl(msg.from, ownerImg.url, ownerImg.caption);
                    recordImageSend(repos, msg.from, 'owner_intro');
                    imageSent = true;
                  } catch (err) {
                    logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'owner_image' });
                  }
                  if (imageSent) {
                    repos.message.addMessage({
                      customer_phone: msg.from,
                      direction: 'outbound',
                      message_type: 'image',
                      body: ownerImg.caption,
                      created_at: new Date().toISOString(),
                    });
                  }
                }
              }

              if (result.priceJustGiven) {
                const skills = getSkills();
                const collectedPlan = repos.conversation.getCollectedPlan(msg.from);
                const image = selectPlanImage(getDynamicPlanImages(skills), collectedPlan);
                if (image && canSendImage(repos, msg.from) && canSendPlanImage(repos, msg.from, image.id)) {
                  const caption = result.priceFollowUpText ?? image.caption;
                  let priceSent = false;
                  try {
                    await sendImageUrl(msg.from, image.url, caption);
                    recordImageSend(repos, msg.from, image.id);
                    priceSent = true;
                  } catch (err) {
                    logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'price_image' });
                  }
                  if (priceSent) {
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
                const image = selectPlanImage(getDynamicPlanImages(skills), collectedPlan);
                if (image && canSendImage(repos, msg.from) && canSendPlanImage(repos, msg.from, image.id)) {
                  try {
                    await sendImageUrl(msg.from, image.url, image.caption);
                    recordImageSend(repos, msg.from, image.id);
                  } catch (err) {
                    logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'ai_image' });
                  }
                }
              }

              if (result.shouldSendGalleryImages) {
                const skills = getSkills();
                const gallery = selectGalleryImages(getGalleryImages(skills));
                if (gallery.length > 0) {
                  const lang = repos.conversation.getLanguage(msg.from) ?? 'es';
                  const intro = skills.fallbackReplies[lang].galleryIntro;
                  let introSent = false;
                  if (result.reply.trim() !== intro.trim()) {
                    try {
                      await sendText(msg.from, intro);
                      introSent = true;
                    } catch (err) {
                      logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'gallery_intro' });
                    }
                  }
                  if (introSent) {
                    repos.message.addMessage({
                      customer_phone: msg.from,
                      direction: 'outbound',
                      message_type: 'text',
                      body: intro,
                      created_at: new Date().toISOString(),
                    });
                  }
                  let galleryImageSent = false;
                  for (const img of gallery) {
                    if (!canSendImage(repos, msg.from)) break;
                    const mediaId = `gallery_${new URL(img.url).pathname}`;
                    try {
                      await sendImageUrl(msg.from, img.url, '');
                      recordImageSend(repos, msg.from, mediaId);
                      galleryImageSent = true;
                      repos.message.addMessage({
                        customer_phone: msg.from,
                        direction: 'outbound',
                        message_type: 'image',
                        body: '',
                        created_at: new Date().toISOString(),
                      });
                    } catch (err) {
                      logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'gallery_image' });
                    }
                  }
                  if (galleryImageSent) {
                    recordGalleryNudge(repos, msg.from);
                    const followUp = skills.fallbackReplies[lang].galleryFollowUp;
                    try {
                      await sendText(msg.from, followUp);
                      repos.message.addMessage({
                        customer_phone: msg.from,
                        direction: 'outbound',
                        message_type: 'text',
                        body: followUp,
                        created_at: new Date().toISOString(),
                      });
                    } catch (err) {
                      logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'gallery_followup' });
                    }
                  }
                }
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
        }
      });
      const queuedTask = task.catch(() => {});
      processingPhones.set(msg.from, queuedTask);
      void queuedTask.finally(() => {
        if (processingPhones.get(msg.from) === queuedTask) processingPhones.delete(msg.from);
      });
    }
  });
}
