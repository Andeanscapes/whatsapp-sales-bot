import { createHmac, timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import type { ProcessMessageOutput } from '../services/types.js';
import { env } from '../config/env.js';
import { getSkills } from '../services/skill-loader.js';
import { buildHandedOffReply, isOptOutMessage, processMessage } from '../services/response-engine.js';
import { classifyConsentReply, consentCycleKey } from '../services/followup-consent.js';
import { sendText, sendImageUrl, downloadMedia, WhatsAppSendError, MAX_IMAGE_CAPTION_CHARS } from '../services/whatsapp-client.js';
import { canSendImage, galleryMediaId, galleryMediaIdFromUrl, markLlmGalleryShown, releaseImageReservation, remainingGalleryImageBudget, reserveImageSend, reserveRequestedGalleryImageSend, selectPlanImage } from '../services/media-service.js';
import { sendAlert } from '../services/alert-service.js';
import { sendTelegramMessage, sendTelegramPhoto, sendTelegramVoice } from '../services/telegram-bot.js';
import { getLineById, hasRoutingConfig, isBridgeTelegramChat, isReferralLine } from '../services/lead-routing.js';
import { findActiveExperience, getOwnerImage, getDynamicPlanImages, resolveExperience } from '../services/product-registry.js';
import { isBridgeActive } from '../services/bridge-service.js';
import { scoreBridgeInbound } from '../services/bridge-lead-scoring.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { isSoftCloseMessage } from '../services/reply-guard.js';
import { normalizePhone } from '../services/report-exclusions.js';
import { logger } from '../config/logger.js';
import { logSystemError } from '../services/error-logger.js';
import { recordAdReferral, type MetaAdReferral } from '../services/ad-referral.js';
import { createTurnPacer } from '../services/human-delay.js';
import { recordOutboundMedia } from '../services/conversation-media.js';

const processingPhones = new Map<string, Promise<void>>();
const pendingByPhone = new Map<string, number>();

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
  referral: z.object({
    ctwa_clid: z.string().max(500).optional(),
    source_id: z.string().max(500).optional(),
    source_type: z.string().max(100).optional(),
    headline: z.string().max(500).optional(),
  }).strip().optional(),
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
  referral?: MetaAdReferral;
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
          result.push({ from: m.from, id: m.id, type: 'text', text: m.text?.body ?? '', media: null, timestamp: '', ...(m.referral ? { referral: m.referral } : {}) });
        } else if (m.type === 'image' && m.image) {
          result.push({
            from: m.from,
            id: m.id,
            type: 'image',
            text: m.image.caption ?? '',
            media: { id: m.image.id, mimeType: m.image.mime_type ?? null },
            timestamp: '',
            ...(m.referral ? { referral: m.referral } : {}),
          });
        } else if (m.type === 'audio' && m.audio) {
          result.push({
            from: m.from,
            id: m.id,
            type: 'audio',
            text: '',
            media: { id: m.audio.id, mimeType: m.audio.mime_type ?? null },
            timestamp: '',
            ...(m.referral ? { referral: m.referral } : {}),
          });
        } else if (m.type === 'video' && m.video) {
          result.push({
            from: m.from,
            id: m.id,
            type: 'video',
            text: m.video.caption ?? '',
            media: { id: m.video.id, mimeType: m.video.mime_type ?? null },
            timestamp: '',
            ...(m.referral ? { referral: m.referral } : {}),
          });
        }
      }
    }
  }
  return result.length > 0 ? result : null;
}

export function isWebhookSenderAllowed(from: string): boolean {
  if (!env.WEBHOOK_OWNER_ONLY_ENABLED) return true;
  return normalizePhone(from) === normalizePhone(env.OWNER_PERSONAL_WHATSAPP_NUMBER);
}

async function recordBridgeRelayFailure(repos: Repositories, phone: string, agentChatId: string, messageType: string): Promise<void> {
  const body = bridgeMessages.relayFailed(phone, messageType);
  repos.ownerAlert.insert(phone, 'telegram', 0, 'bridge_relay_failed', body);
  if (!env.TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID === agentChatId) return;
  try {
    await sendTelegramMessage(env.TELEGRAM_CHAT_ID, bridgeMessages.fallbackAlert(body));
  } catch {
    logger.warn({ chatId: env.TELEGRAM_CHAT_ID }, '[BRIDGE] fallback owner notification also failed');
  }
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
    repos.conversation.setMode(msg.from, session.returnMode);
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
  void scoreBridgeInbound(repos, msg.from, msg.text).catch(err => {
    logger.warn({ err, phone: msg.from }, '[BRIDGE] silent lead scoring failed');
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
        await recordBridgeRelayFailure(repos, msg.from, session.agentChatId, msg.type);
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
        await recordBridgeRelayFailure(repos, msg.from, session.agentChatId, msg.type);
      }
    }
    return true;
  }

  if (msg.type === 'video') {
    try {
      await sendTelegramMessage(session.agentChatId, bridgeMessages.newCustomerVideo(msg.from));
    } catch (err) {
      logger.warn({ err, phone: msg.from, chatId: session.agentChatId }, '[BRIDGE] customer video notify failed; keeping bridge active');
      await recordBridgeRelayFailure(repos, msg.from, session.agentChatId, msg.type);
    }
    return true;
  }

  try {
    await sendTelegramMessage(session.agentChatId, bridgeMessages.newCustomerMessage(msg.from, msg.text));
    return true;
  } catch (err) {
    logger.warn({ err, phone: msg.from, chatId: session.agentChatId }, '[BRIDGE] failed to notify active agent; resuming bot path');
    await recordBridgeRelayFailure(repos, msg.from, session.agentChatId, msg.type);
    repos.bridgeSession.close(session.agentChatId);
    repos.conversation.setMode(msg.from, session.returnMode);
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
 * Notify the assigned bridge agent without silencing the bot.
 * Runs for:
 * - mode `bot` with a sticky bridge assignment (dormant assignment)
 * - mode `human_pending` (close escalated; bot still replies until /chat)
 * Does not run for live `bridge_active` (handled by forwardBridgeMessage).
 */
export async function notifyAssignedLineIfDormant(repos: Repositories, msg: ExtractedMessage): Promise<boolean> {
  if (!hasRoutingConfig()) return false;
  if (repos.isPaused()) return false;
  if (repos.optOut.isOptedOut(msg.from)) return false;
  const mode = repos.conversation.getMode(msg.from);
  if (mode !== 'bot' && mode !== 'human_pending') return false;
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

interface ReplyCarryingImage {
  url: string;
  mediaId: string;
  flow: 'price_image' | 'contextual_image';
  /** Feed caption, used only when the reply is too long to be the caption. */
  fallbackCaption: string;
}

/**
 * The single image that carries the reply as its caption, or null for a plain
 * text reply. A price turn shows the plan card; any other turn may show a themed
 * contextual photo. The engine never sets both (contextual selection is skipped
 * on price turns), so this is a priority list, not a merge.
 *
 * Resolved once per turn: the price fallback path below reuses this result rather
 * than re-deriving the plan image, so the two paths cannot select different cards.
 */
function resolveReplyCarryingImage(
  repos: Repositories,
  phone: string,
  result: ProcessMessageOutput,
): ReplyCarryingImage | null {
  if (result.priceJustGiven) {
    const skills = getSkills();
    // findActiveExperience (not resolveExperience) so an empty catalog degrades to a
    // plain text reply instead of throwing inside the delivery path.
    const experience = findActiveExperience(skills, repos.conversation.getSelectedExperienceId(phone));
    if (!experience) return null;
    const planImage = selectPlanImage(
      getDynamicPlanImages(skills),
      repos.conversation.getCollectedPlan(phone),
      experience.id,
    );
    return planImage
      ? { url: planImage.url, mediaId: planImage.id, flow: 'price_image', fallbackCaption: planImage.caption }
      : null;
  }
  return result.contextualImage
    ? {
      url: result.contextualImage.url,
      mediaId: galleryMediaId(result.contextualImage),
      flow: 'contextual_image',
      fallbackCaption: '',
    }
    : null;
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
      logger.info({ from: msg.from, type: msg.type, msgId: msg.id, textLen: msg.type === 'text' ? msg.text.length : undefined }, '[WEBHOOK] incoming WhatsApp message');
      if (!isWebhookSenderAllowed(msg.from)) {
        logger.info({ from: msg.from }, '[WEBHOOK] ignored non-owner sender (WEBHOOK_OWNER_ONLY_ENABLED)');
        continue;
      }
      if (repos.dedupe.isProcessed(msg.id)) continue;

      repos.dedupe.markProcessed(msg.id);
      if (msg.referral) recordAdReferral(repos, msg.from, msg.referral);
      const prev = processingPhones.get(msg.from) ?? Promise.resolve();
      // Queue position is claimed synchronously at enqueue time so a task can tell
      // whether newer inbound from the same phone is already waiting behind it.
      const queuePosition = (pendingByPhone.get(msg.from) ?? 0) + 1;
      pendingByPhone.set(msg.from, queuePosition);
      const task = prev.then(async () => {
        const startedAtMs = Date.now();
        // Newer inbound queued → the customer already waited, so reply without delay.
        const shouldSkip = () => (pendingByPhone.get(msg.from) ?? 0) > queuePosition;
        const pacer = createTurnPacer(startedAtMs, shouldSkip, env.MESSAGE_DELAY);

        try {
          const optOutRequest = msg.type === 'text' && isOptOutMessage(msg.text);

          // Inbound routing precedence: live bridge session > post-handoff notify > bot.
          // Opt-out requests always use the bot path so compliance state is set.
          if (!optOutRequest && await forwardBridgeMessage(repos, msg)) return;
          if (!optOutRequest && await notifyAssignedLineIfDormant(repos, msg)) return;
          if (!optOutRequest && await forwardPostHandoffMedia(repos, msg)) return;
          // Bot is silenced for this customer (/stopbot). Persist the inbound so
          // it stays visible in lead history, but never generate a bot reply.
          if (!optOutRequest && repos.conversation.getMode(msg.from) === 'human_only') {
            repos.message.addMessage({
              whatsapp_message_id: msg.id,
              customer_phone: msg.from,
              direction: 'inbound',
              message_type: msg.type,
              body: msg.text || '',
              created_at: new Date().toISOString(),
              raw_json: null,
            });
            return;
          }
          // Non-text inbound never reaches the bot path, so persist it here for the
          // operator transcript. Shape matches the bridge/handoff/human_only sites
          // above (`body` is the WhatsApp caption); `media_id` is what lets a replay
          // re-download the photo.
          //
          // Note: this advances `getLastInboundAt`, which is intentional — Meta
          // measures the 24h service window from ANY customer message, so ignoring
          // photos under-counted it. Follow-up schedules therefore shift later,
          // never earlier.
          if (msg.type !== 'text') {
            repos.message.addMessage({
              whatsapp_message_id: msg.id,
              customer_phone: msg.from,
              direction: 'inbound',
              message_type: msg.type,
              body: msg.text || '',
              created_at: new Date().toISOString(),
              raw_json: null,
              media_id: msg.media?.id,
            });
            return;
          }

          const handoffReply = await forwardPostHandoffMessage(repos, msg);
          if (handoffReply !== null) {
            let sent = false;
            try {
               if (!await pacer.pace()) return;
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

          // Classify consent only after every human/bridge/handoff route declined
          // the message. A bare "si" sent to a human agent must never activate
          // recurring marketing. The message still flows through the bot so the
          // LLM owns the acknowledgment text (AGENTS.md invariant 8).
          let consentAcceptedThisTurn = false;
          let consentDeclinedThisTurn = false;
          let consentDecisionStored = false;
          if (!optOutRequest) {
            const subscription = repos.followupSubscription.getByPhone(msg.from);
            const decision = subscription?.status === 'pending'
              ? classifyConsentReply(msg.text)
              : 'ambiguous';
            if (subscription?.status === 'pending' && decision !== 'ambiguous') {
              // The inbound is stored inside the same transaction as the decision so
              // the audit trail can never show a consent change without its message.
               repos.runInTransaction(() => {
                 repos.message.addMessage({
                   whatsapp_message_id: msg.id,
                   customer_phone: msg.from,
                   direction: 'inbound',
                   message_type: 'text',
                   body: msg.text,
                   created_at: new Date().toISOString(),
                   raw_json: null,
                 });
                 if (decision === 'affirm') {
                   repos.followupSubscription.affirm(msg.from, msg.id, 'customer_reply');
                 } else {
                   repos.followupSubscription.decline(msg.from, msg.id);
                 }
                 // Record the grant for append-only audit trail, regardless of decision
                 repos.followupConsentGrant.record({
                   customer_phone: msg.from,
                   decision,
                   decided_at: new Date().toISOString(),
                    inbound_message_id: msg.id,
                    source: 'customer_reply',
                    ask_cycle_key: consentCycleKey(subscription.consent_session),
                    app_version: env.APP_VERSION,
                 });
               });
              consentAcceptedThisTurn = decision === 'affirm';
              consentDeclinedThisTurn = decision === 'decline';
              consentDecisionStored = true;
              logger.info({ phone: msg.from, decision }, '[FOLLOWUP] consent decision recorded');
            }
          }

          let result;
          try {
            result = await processMessage({
              repos,
              customerPhone: msg.from,
              message: msg.text,
              messageId: msg.id,
              consentAcceptedThisTurn,
              consentDeclinedThisTurn,
              storeInbound: !consentDecisionStored,
            });
          } catch (err) {
            logSystemError('webhook_process', 'error', err, { phone: msg.from });
            const humanFallback = systemErrorRetry(repos, msg.from);
            let sent = false;
            try {
              if (shouldSkip()) return;
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
            let sent = false;

            logger.info({ phone: msg.from, replyLen: result.reply.length, usedAi: result.usedAi, score: result.leadScore, alert: result.shouldAlertOwner, image: result.shouldSendImage, requestedPhotos: result.requestedGalleryImages?.length ?? 0 }, '[WEBHOOK] bot reply triggered');

            // Explicitly requested gallery photos. Ordering matters: the reply's
            // single continuation question must render UNDER the photos. A text
            // message sent after the images cannot guarantee that — WhatsApp
            // downloads every `image.link` before delivering, so the text
            // overtakes them (same reason the contextual path below captions its
            // photo). The last photo therefore carries the reply as its caption;
            // the rest go captionless. If the reply is too long to caption or that
            // last send fails, the text fallback below still delivers it.
            //
            // Claims are taken up front so the caption can land on the LAST
            // SUCCESSFULLY CLAIMED photo. Picking it by array index instead would
            // lose the caption whenever that one photo's claim is refused, and the
            // reply would fall back to a trailing text — the exact ordering the
            // caption exists to prevent.
            const bridgeActiveAtDelivery = isBridgeActive(repos, msg.from);
            const requestedGallery = bridgeActiveAtDelivery ? [] : (result.requestedGalleryImages ?? []);
            if (bridgeActiveAtDelivery && (result.requestedGalleryImages?.length ?? 0) > 0) {
              logger.info({ phone: msg.from }, '[WEBHOOK] requested photos cancelled — bridge activated during reply generation');
            }
            const claimedGallery: { url: string; reservationId: number }[] = [];
            for (const imageUrl of requestedGallery) {
              if (isBridgeActive(repos, msg.from)) break;
              if (!canSendImage(repos, msg.from)) break;
              if (remainingGalleryImageBudget(repos, msg.from) <= claimedGallery.length) break;
              const mediaId = galleryMediaIdFromUrl(imageUrl);
              if (mediaId == null) continue;
              const reservationId = reserveRequestedGalleryImageSend(repos, msg.from, mediaId, msg.id);
              if (reservationId == null) continue;
              claimedGallery.push({ url: imageUrl, reservationId });
            }
            if (requestedGallery.length > 0 && claimedGallery.length === 0) {
              // The reply was written on the promise of photos; every claim was
              // refused, so it ships alone. Visible instead of silent.
              logger.warn({ phone: msg.from, requested: requestedGallery.length }, '[WEBHOOK] every requested photo was refused by media claims — reply ships without them');
            }

            // `claimedGallery.length` first so a reply with no photos never touches
            // MAX_IMAGE_CAPTION_CHARS — this is the common path.
            const captionIndex = claimedGallery.length > 0 && result.reply.length <= MAX_IMAGE_CAPTION_CHARS
              ? claimedGallery.length - 1
              : -1;
            let galleryDeliveryStarted = false;
            let finishGalleryWithoutPacing = false;
            for (const [index, claim] of claimedGallery.entries()) {
              const caption = index === captionIndex ? result.reply : '';
              try {
                if (isBridgeActive(repos, msg.from)) {
                  for (const pending of claimedGallery.slice(index)) releaseImageReservation(repos, pending.reservationId);
                  break;
                }
                if (!finishGalleryWithoutPacing && !await pacer.pace()) {
                  if (!galleryDeliveryStarted) {
                    for (const pending of claimedGallery.slice(index)) releaseImageReservation(repos, pending.reservationId);
                    break;
                  }
                  // Once one photo may have reached the customer, finish the burst
                  // atomically so the captioned reply is never stranded.
                  finishGalleryWithoutPacing = true;
                }
                if (isBridgeActive(repos, msg.from)) {
                  for (const pending of claimedGallery.slice(index)) releaseImageReservation(repos, pending.reservationId);
                  break;
                }
                await sendImageUrl(msg.from, claim.url, caption);
                galleryDeliveryStarted = true;
                if (caption) sent = true;
                repos.message.addMessage({
                  customer_phone: msg.from,
                  direction: 'outbound',
                  message_type: 'image',
                  body: '',
                  created_at: new Date().toISOString(),
                });
                recordOutboundMedia(repos, {
                  phone: msg.from,
                  url: claim.url,
                  mediaId: galleryMediaIdFromUrl(claim.url) ?? claim.url,
                  caption,
                  carriedReply: index === captionIndex,
                  flow: 'requested_gallery',
                  turnInboundMessageId: msg.id,
                  sequence: index,
                });
              } catch (err) {
                // An uncertain delivery is terminal: Meta may still deliver the
                // captioned photo, so re-sending the reply as text would show it
                // twice. Keep the claim and treat the reply as sent.
                const uncertain = err instanceof WhatsAppSendError && err.deliveryUncertain;
                if (!uncertain) releaseImageReservation(repos, claim.reservationId);
                if (uncertain) galleryDeliveryStarted = true;
                if (caption && uncertain) sent = true;
                logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'requested_gallery_image' });
              }
            }
            if (galleryDeliveryStarted) markLlmGalleryShown(repos, msg.from);

            // Deliver the reply as the caption of one photo, so the closing question
            // always renders under the image. Two separate messages cannot guarantee
            // that order: WhatsApp downloads `image.link` before delivering, so a text
            // sent afterwards arrives first. On a price turn the plan card carries the
            // reply; otherwise the themed contextual photo does (the engine never
            // produces both). The reply is still recorded as an outbound text below,
            // keeping LLM history identical however it was delivered.
            //
            // Suppressed on a requested-gallery turn: the last requested photo
            // already carries the reply, and adding the plan card on top would be a
            // media flood. Logged because a price turn silently loses its card.
            const replyImage = bridgeActiveAtDelivery || requestedGallery.length > 0
              ? null
              : resolveReplyCarryingImage(repos, msg.from, result);
            if (requestedGallery.length > 0 && result.priceJustGiven) {
              logger.info({ phone: msg.from }, '[WEBHOOK] plan card suppressed — requested gallery carries this reply');
            }
            let replyImageAttempted = false;
            // `.length` counts UTF-16 units while Meta counts characters, so surrogate
            // pairs (emoji) make this guard conservative — never permissive.
            if (replyImage
              && result.reply.length <= MAX_IMAGE_CAPTION_CHARS
              && !isBridgeActive(repos, msg.from)
              && canSendImage(repos, msg.from)) {
              const reservationId = reserveImageSend(repos, msg.from, replyImage.mediaId);
              if (reservationId != null) {
                replyImageAttempted = true;
                try {
                  if (!await pacer.pace()) {
                    releaseImageReservation(repos, reservationId);
                  } else if (isBridgeActive(repos, msg.from)) {
                    releaseImageReservation(repos, reservationId);
                  } else {
                    await sendImageUrl(msg.from, replyImage.url, result.reply);
                    sent = true;
                    recordOutboundMedia(repos, {
                      phone: msg.from,
                      url: replyImage.url,
                      mediaId: replyImage.mediaId,
                      caption: result.reply,
                      carriedReply: true,
                      flow: replyImage.flow,
                      turnInboundMessageId: msg.id,
                    });
                  }
                } catch (err) {
                  // An uncertain delivery is terminal (see sendTextWithId): Meta may
                  // hold the message, so re-sending the same copy as text would show
                  // the customer the reply twice. Keep the claim and treat it as sent.
                  const uncertain = err instanceof WhatsAppSendError && err.deliveryUncertain;
                  if (!uncertain) releaseImageReservation(repos, reservationId);
                  sent = uncertain;
                  logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: replyImage.flow });
                }
              }
            }

            // Plain text when there is no image, the reply is too long to caption,
            // or the image send failed — the reply must never be lost.
            if (!sent) {
              try {
                // Once a gallery photo may have shipped, the reply is part of that
                // atomic burst and cannot be cancelled by a newer inbound.
                if (galleryDeliveryStarted || await pacer.pace()) {
                  await sendText(msg.from, result.reply);
                  sent = true;
                }
              } catch (err) {
                logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'bot_reply' });
              }
            }

            if (sent) {
              repos.runInTransaction(() => {
                repos.message.addMessage({
                  customer_phone: msg.from,
                  direction: 'outbound',
                  message_type: 'text',
                  body: result.reply,
                  created_at: new Date().toISOString(),
                });
                if (result.outboundDateAction === 'asked') repos.conversation.setDateAsked(msg.from);
                if (result.outboundDateAction === 'options_offered') repos.conversation.setDateOptionsOffered(msg.from);
              });

              if (result.shouldSendOwnerImage && !isBridgeActive(repos, msg.from)) {
                const skills = getSkills();
                const ownerImg = getOwnerImage(skills);
                const reservationId = ownerImg && canSendImage(repos, msg.from)
                  ? reserveImageSend(repos, msg.from, 'owner_intro')
                  : null;
                if (ownerImg && reservationId != null) {
                  let imageSent = false;
                  try {
                    if (!await pacer.pace()) {
                      releaseImageReservation(repos, reservationId);
                    } else if (isBridgeActive(repos, msg.from)) {
                      releaseImageReservation(repos, reservationId);
                    } else {
                      await sendImageUrl(msg.from, ownerImg.url, ownerImg.caption);
                      imageSent = true;
                    }
                  } catch (err) {
                    if (!(err instanceof WhatsAppSendError) || !err.deliveryUncertain) releaseImageReservation(repos, reservationId);
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
                    recordOutboundMedia(repos, {
                      phone: msg.from,
                      url: ownerImg.url,
                      mediaId: 'owner_intro',
                      caption: ownerImg.caption,
                      carriedReply: false,
                      flow: 'owner_image',
                      turnInboundMessageId: msg.id,
                    });
                  }
                }
              }

              // Only when the plan card did NOT already carry the reply as its caption
              // (reply too long to caption, or no claim available). Otherwise this
              // would send the same card twice. Reuses the image resolved above so
              // both paths can never disagree on which card to show.
              if (result.priceJustGiven && !replyImageAttempted && !isBridgeActive(repos, msg.from)) {
                const image = replyImage;
                const reservationId = image && canSendImage(repos, msg.from)
                  ? reserveImageSend(repos, msg.from, image.mediaId)
                  : null;
                if (image && reservationId != null) {
                  const caption = image.fallbackCaption;
                    let priceSent = false;
                    try {
                      if (!await pacer.pace()) {
                        releaseImageReservation(repos, reservationId);
                      } else if (isBridgeActive(repos, msg.from)) {
                        releaseImageReservation(repos, reservationId);
                      } else {
                        await sendImageUrl(msg.from, image.url, caption);
                        priceSent = true;
                      }
                    } catch (err) {
                    if (!(err instanceof WhatsAppSendError) || !err.deliveryUncertain) releaseImageReservation(repos, reservationId);
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
                    recordOutboundMedia(repos, {
                      phone: msg.from,
                      url: image.url,
                      mediaId: image.mediaId,
                      caption,
                      carriedReply: false,
                      flow: 'price_image_fallback',
                      turnInboundMessageId: msg.id,
                    });
                  }
                }
              }

              if (result.shouldSendImage && !result.priceJustGiven && !isBridgeActive(repos, msg.from)) {
                const skills = getSkills();
                const collectedPlan = repos.conversation.getCollectedPlan(msg.from);
                const experienceId = resolveExperience(skills, repos.conversation.getSelectedExperienceId(msg.from)).id;
                const image = selectPlanImage(getDynamicPlanImages(skills), collectedPlan, experienceId);
                const reservationId = image && canSendImage(repos, msg.from)
                  ? reserveImageSend(repos, msg.from, image.id)
                  : null;
                if (image && reservationId != null) {
                  try {
                    if (!await pacer.pace()) {
                      releaseImageReservation(repos, reservationId);
                    } else if (isBridgeActive(repos, msg.from)) {
                      releaseImageReservation(repos, reservationId);
                    } else {
                      await sendImageUrl(msg.from, image.url, image.caption);
                      recordOutboundMedia(repos, {
                        phone: msg.from,
                        url: image.url,
                        mediaId: image.id,
                        caption: image.caption,
                        carriedReply: false,
                        flow: 'ai_image',
                        turnInboundMessageId: msg.id,
                      });
                    }
                  } catch (err) {
                    if (!(err instanceof WhatsAppSendError) || !err.deliveryUncertain) releaseImageReservation(repos, reservationId);
                    logSystemError('whatsapp_send', 'error', err, { phone: msg.from, flow: 'ai_image' });
                  }
                }
              }

            }
          }

          // Outside the reply branch on purpose: an alert must fire even when the
          // engine produces no reply (limit_loop, silent handoffs) or the send failed.
          if (result.shouldAlertOwner) {
            const conversation = repos.conversation.getByPhone(msg.from);
            try {
              const delivered = await sendAlert({
                customerPhone: msg.from,
                score: result.leadScore,
                intent: result.ownerAlertType ?? 'lead',
                message: msg.text,
                name: String(conversation?.collected_name ?? 'unknown'),
                date: String(conversation?.collected_date ?? 'unknown'),
                people: String(conversation?.collected_people ?? 'unknown'),
                transport: String(conversation?.collected_transport_need ?? 'unknown'),
              }, repos);
              // sendAlert() returning false means every configured channel (assigned
              // line, fallback owner chat, or ALERT_CHANNEL) failed to deliver — the
              // owner never learns about this lead. That must not fail silently: log
              // it as a system error (critical pages the owner via a separate ops
              // channel, deduped hourly) with routing context but no secrets.
              if (!delivered) {
                logSystemError(
                  'alert_send',
                  'critical',
                  new Error('Owner alert produced no delivered channel'),
                  { phone: msg.from, alertType: result.ownerAlertType, alertChannel: env.ALERT_CHANNEL },
                );
              }
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
        if (pendingByPhone.get(msg.from) === queuePosition) pendingByPhone.delete(msg.from);
      });
    }
  });
}
