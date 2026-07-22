import type { FollowUpCandidate, Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { buildFollowUpPrompt } from './deepseek-client.js';
import { llmClient } from './response-engine.js';
import {
  stripHandoffPhrases,
  containsUnsafeReservationClaim,
  containsPromptLeakOrPolicyViolation,
  isNonSalesInquiry,
  isCustomerFollowUpPromise,
  isReviewPause,
  isSoftCloseMessage,
} from './reply-guard.js';
import { sendImageUrl, sendText, WhatsAppSendError } from './whatsapp-client.js';
import { checkBudget } from './budget-guard.js';
import { checkTimeWindow, isWithinServiceWindow } from './time-window-policy.js';
import { getCollectedFields } from './qualification-engine.js';
import { INPUT_COST_PER_TOKEN, OUTPUT_COST_PER_TOKEN } from './constants.js';
import { getSkills } from './skill-loader.js';
import { getActiveExperience, getGalleryImages, getShortDescription } from './product-registry.js';
import { galleryMediaId, recordGalleryNudge, recordImageSend, selectEligibleGalleryImages } from './media-service.js';

/**
 * WhatsApp only allows free-form messages within 24h of the customer's last
 * inbound. The follow-up is gated below this so it is never sent late.
 */
const MAX_FOLLOW_HOURS = 19;
const POLL_MS = 60_000;
/** Per tick, cap candidates so a backlog never blocks other bot/Telegram work. */
const FOLLOW_UP_BATCH = 5;
type AutomatedFollowUpStage = 'first_nudge' | 'second_nudge';

/**
 * Cliché phrases to remove. Matched anywhere (leading or mid-sentence) so a
 * draft like "Justo hoy me acordé de ti, ¿sigues?" is cleaned, not leaked.
 * Leading punctuation/connectors are consumed to avoid dangling ", ?".
 */
const RETRYABLE_NUDGE_PHRASES = [
  /(?:^|[,.;:!¡¿]?\s*)(?:¡?hola\s+de\s+nuevo!?|hola\s+otra\s+vez!?)[,!.:\s-]*/gi,
  /(?:^|[,.;:!¡¿]?\s*)(?:pens[eé]\s+en\s+(?:ti|ustedes))[,!.:\s-]*/gi,
  /(?:^|[,.;:!¡¿]?\s*)(?:me\s+acord[eé]\s+de\s+(?:ti|ustedes))[,!.:\s-]*/gi,
  /(?:^|[,.;:!¡¿]?\s*)(?:vi\s+algo\s+y\s+pens[eé]\s+en\s+ti|se\s+me\s+vino\s+una\s+(?:idea|imagen))[,!.:\s-]*/gi,
  /(?:^|[,.;:!¡¿]?\s*)(?:sigues\s+interesad[oa]|solo\s+pasaba\s+a\s+ver|c[oó]mo\s+vas|como\s+vas)[,!.:\s-]*/gi,
];

const COMMERCIAL_NUDGE_PATTERNS = [
  /\b(?:costo|precio|valor|cost|price)\b|\$\s*\d|\b\d[\d,.]*\s*(?:COP|USD)\b/i,
  /\bplan(?:es)?\s+(?:de\s+\d|minero|rural|2d|3d)\b/i,
];

const HARD_BLOCK_NUDGE_PATTERNS = [
  /\b(?:comprar|reserva[rs]?|dep[oó]sito|buy|purchase|book(?:ing)?|reserve|reservation|deposit|down\s+payment|pay)\b/i,
  /https?:\/\//i,
  /\binstagram\b/i,
  /\b(?:hook para reconectar|reconectar con este lead|este lead|hook to reconnect|reconnect with this lead|this lead)\b/i,
  /\b(?:viajeros?|travelers?)\b.{0,60}\b(?:encontraron|found)\b/i,
];

const REVIEW_REMINDER_BLOCK_PATTERNS = [
  /\b(?:precio|valor|costo|cost|price)\b/i,
  /\b(?:disponibilidad|available|availability|cupos?|spots?)\b/i,
  /\b(?:reserva[rs]?|reservar|reserve|booking|book)\b/i,
  /\b(?:urgente|urgency|ultimo[as]?|last|pronto|soon|agota[rs]?|sell\s+out)\b/i,
  /\b(?:foto|fotos|imagen(?:es)?|photos?|pictures?)\b/i,
];

function stripRetryableNudgeOpeners(reply: string): string {
  let cleaned = reply.trim();
  for (const pattern of RETRYABLE_NUDGE_PHRASES) {
    cleaned = cleaned.replace(pattern, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  // Capitalize first letter if stripping left a lowercase lead.
  if (cleaned) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return cleaned;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripOwnerReIntro(reply: string): string {
  const owner = escapeRegex(env.OWNER_NAME);
  const partner = escapeRegex(env.PARTNER_NAME);
  const introPattern = new RegExp(
    String.raw`\s*(?:Soy\s+${owner},?\s*co[- ]?founder\s+(?:de\s+|of\s+)?Andean\s+Scapes\s+(?:junto\s+(?:a|con)\s+${partner}|with\s+${partner})[^.]*\.?\s*)`,
    'gi',
  );
  return reply.replace(introPattern, '').trim();
}

function startsWithOwnerOrPartnerName(reply: string): boolean {
  const protectedNames = [env.OWNER_NAME, env.PARTNER_NAME]
    .flatMap(name => [name, name.split(/\s+/)[0]])
    .filter(name => name.length > 1)
    .map(escapeRegex);
  return protectedNames.some(name => new RegExp(`^${name}(?:[,!:.\\s]|$)`, 'i').test(reply));
}

function configuredHours(): number {
  return Math.min(env.TIME_FOLLOW_HOURS, MAX_FOLLOW_HOURS);
}

export function isFollowUpSendWindow(now = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', hour: 'numeric', hourCycle: 'h23',
  }).format(now));
  return hour >= env.FOLLOW_UP_SEND_START_HOUR && hour < env.FOLLOW_UP_SEND_END_HOUR;
}

function isPermanentFollowUpPause(text: string): boolean {
  return isSoftCloseMessage(text)
    || isCustomerFollowUpPromise(text)
    || /(?:quiero\s+pensarlo|lo\s+(?:quiero|voy|vamos)\s+a\s+pensar|déjame\s+pensarlo|let\s+me\s+think|estamos\s+validando|a[uú]n\s+no|when\s+we\s+decide)/i.test(text);
}

function recordSent(
  phone: string,
  reply: string,
  repos: Repositories,
  stage: AutomatedFollowUpStage,
  anchorInboundAt: string,
): void {
  const sentAt = new Date().toISOString();
  repos.message.addMessage({
    customer_phone: phone,
    direction: 'outbound',
    message_type: 'text',
    body: reply,
    created_at: sentAt,
  });
  repos.conversation.markFollowUpSent(phone);
  repos.followUpEvent.markClaimSent(phone, anchorInboundAt, stage, sentAt);
}

function reviewReminderFallback(lang: 'es' | 'en'): string {
  const skills = getSkills();
  return skills.fallbackReplies[lang].followUpReviewReminder
    .replace('{{experienceSummary}}', getShortDescription(getActiveExperience(skills)));
}

function standardFollowUpFallback(lang: 'es' | 'en', phase: string | null, stage: AutomatedFollowUpStage): string {
  const replies = getSkills().fallbackReplies[lang];
  if (stage === 'second_nudge') return replies.followUpFinalDirect;
  if (phase === 'pricing') return replies.followUpPricing;
  if (phase === 'value') return replies.followUpValue;
  if (phase === 'greeting') return replies.followUpGreeting;
  return replies.followUpSafeNudge;
}

async function sendReviewGallery(repos: Repositories, phone: string): Promise<void> {
  const images = selectEligibleGalleryImages(repos, phone, getGalleryImages(getSkills()));
  let sent = false;
  for (const image of images) {
    if (!isWithinServiceWindow(repos, phone) || checkTimeWindow(repos, phone).isLimited) break;
    try {
      await sendImageUrl(phone, image.url, '');
    } catch (err) {
      logger.warn({ err, phone }, '[FOLLOW_UP] gallery image failed');
      continue;
    }
    try {
      recordImageSend(repos, phone, galleryMediaId(image));
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'outbound',
        message_type: 'image',
        body: '',
        created_at: new Date().toISOString(),
      });
      sent = true;
    } catch (err) {
      logger.error({ err, phone }, '[FOLLOW_UP] gallery image sent but persistence failed');
      break;
    }
  }
  if (sent) recordGalleryNudge(repos, phone);
}

async function processCandidates(
  repos: Repositories,
  candidates: FollowUpCandidate[],
  stage: AutomatedFollowUpStage,
): Promise<void> {
  for (const c of candidates) {
    // Re-check guards at send time (candidate query is a coarse pre-filter).
    if (repos.optOut.isOptedOut(c.customerPhone)) continue;
    if (!isWithinServiceWindow(repos, c.customerPhone)) continue;
    if (checkTimeWindow(repos, c.customerPhone).isLimited) continue;
    if (!checkBudget(repos, c.customerPhone).aiAllowed) continue;

    const lang = c.language ?? 'es';
    const currentScore = repos.conversation.getLeadScore(c.customerPhone);
    const collected = getCollectedFields(repos, c.customerPhone);
    const salesPhase = repos.conversation.getSalesPhase(c.customerPhone);

    // Never follow up on leads already in closing / pending validation.
    if (salesPhase === 'closing') continue;

    const history = repos.message.getRecentMessages(c.customerPhone, 8);
    const latestInbound = [...history].reverse().find(message => message.role === 'user');
    const latestOutbound = [...history].reverse().find(message => message.role === 'assistant');
    if (!latestInbound || !latestOutbound) continue;
    if (isNonSalesInquiry(latestInbound.content)) continue;

    const anchorInboundAt = c.anchorInboundAt;
    if (!anchorInboundAt) continue;
    const reviewReminder = stage === 'second_nudge' && c.reviewPause === true;
    const seqNumber = repos.followUpEvent.countByPhone(c.customerPhone) + 1;
    const claimed = repos.followUpEvent.claim({
      customerPhone: c.customerPhone,
      sequenceNumber: seqNumber,
      stage,
      anchorInboundAt,
      decisionReason: null,
      sentAt: null,
      repliedAt: null,
      scoreBefore: currentScore,
      scoreAfter: null,
      detectedPain: null,
      status: 'pending',
    });
    if (!claimed) continue;

    if (stage === 'first_nudge' && isPermanentFollowUpPause(latestInbound.content)) {
      repos.followUpEvent.markClaimSuppressed(c.customerPhone, anchorInboundAt, stage, 'customer_follow_up_promise');
      continue;
    }
    if (stage === 'first_nudge' && isReviewPause(latestInbound.content)) {
      repos.followUpEvent.markClaimSuppressed(c.customerPhone, anchorInboundAt, stage, 'review_pause');
      continue;
    }
    if (stage === 'second_nudge' && isPermanentFollowUpPause(latestInbound.content)) {
      repos.followUpEvent.markClaimSuppressed(c.customerPhone, anchorInboundAt, stage, 'customer_follow_up_promise');
      continue;
    }
    if (reviewReminder && (currentScore < 60 || !repos.conversation.getPriceGivenAt(c.customerPhone))) {
      repos.followUpEvent.markClaimSuppressed(c.customerPhone, anchorInboundAt, stage, 'review_lead_not_qualified');
      continue;
    }

    let usageRecorded = false;
    const result = await llmClient.complete({
      systemPrompt: buildFollowUpPrompt({ lang, phase: salesPhase, stage, reviewReminder }),
      message: `Generate the follow-up now. Collected facts: ${JSON.stringify(collected)}`,
      history: history.map(h => ({ role: h.role, content: h.content })),
      lang,
      onAttempt: attempt => {
        usageRecorded = true;
        const cost = attempt.tokens.prompt * INPUT_COST_PER_TOKEN + attempt.tokens.completion * OUTPUT_COST_PER_TOKEN;
        repos.aiUsage.recordUsage({ phone: c.customerPhone, model: env.DEEPSEEK_MODEL, promptTokens: attempt.tokens.prompt, completionTokens: attempt.tokens.completion, cachedTokens: 0, estimatedCost: cost, purpose: 'follow_up', success: attempt.success, errorType: attempt.success ? null : 'completion_failed' });
      },
    });

    if (result && !usageRecorded) {
      const cost = result.tokens.prompt * INPUT_COST_PER_TOKEN + result.tokens.completion * OUTPUT_COST_PER_TOKEN;
      repos.aiUsage.recordUsage({ phone: c.customerPhone, model: env.DEEPSEEK_MODEL, promptTokens: result.tokens.prompt, completionTokens: result.tokens.completion, cachedTokens: 0, estimatedCost: cost, purpose: 'follow_up', success: true });
    }

    let reply = result?.turn.reply.trim() ?? '';
    if (reviewReminder && (!reply || /[?¿]/.test(reply))) reply = reviewReminderFallback(lang);
    if (!reply) {
      repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'llm_unavailable');
      logger.warn({ phone: c.customerPhone, stage }, '[FOLLOW_UP] no LLM draft; skipping nudge');
      continue;
    }

    reply = stripHandoffPhrases(reply);
    // Strip accidental full-intro re-greetings that the LLM may smuggle in
    // despite the task prompt's instructions.
    reply = stripOwnerReIntro(reply);
    reply = stripRetryableNudgeOpeners(reply);
    if (!reply) {
      repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'empty_after_sanitization');
      continue;
    }
    if (startsWithOwnerOrPartnerName(reply)) {
      repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'unsafe_personalization');
      continue;
    }
    if (reviewReminder && REVIEW_REMINDER_BLOCK_PATTERNS.some(p => p.test(reply))) {
      reply = reviewReminderFallback(lang);
    }
    // Unsafe reservation, prompt-leak, and commercial drafts are replaced with trusted copy.
    if (HARD_BLOCK_NUDGE_PATTERNS.some(p => p.test(reply))) {
      logger.warn({ phone: c.customerPhone, replyLen: reply.length }, '[FOLLOW_UP] draft replaced by hard nudge guard');
      reply = reviewReminder
        ? reviewReminderFallback(lang)
        : standardFollowUpFallback(lang, salesPhase, stage);
    }
    if (!reviewReminder && COMMERCIAL_NUDGE_PATTERNS.some(p => p.test(reply))) {
      reply = standardFollowUpFallback(lang, salesPhase, stage);
    }
    if (!reviewReminder && salesPhase === 'pricing' && !/(?:incluye|log[ií]stica|llegar|includes?|logistics?|getting there)/i.test(reply)) {
      reply = standardFollowUpFallback(lang, salesPhase, stage);
    }
    // Same safety guards as the live reply path: unsafe drafts never reach customers.
    if (containsUnsafeReservationClaim(reply) || containsPromptLeakOrPolicyViolation(reply)) {
      repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'reply_guard_blocked');
      continue;
    }

    // Candidate selection happened before the LLM call. Recheck immediately
    // before dispatch so a newly active or closed conversation wins the race.
    if (repos.isPaused()) { repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'bot_paused'); continue; }
    if (repos.optOut.isOptedOut(c.customerPhone)) { repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'opted_out'); continue; }
    if (repos.conversation.getBookedAt(c.customerPhone)) { repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'booked'); continue; }
    if (repos.conversation.getHandedOffAt(c.customerPhone)) { repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'handed_off'); continue; }
    if (repos.conversation.getMode(c.customerPhone) !== 'bot') { repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'bridged'); continue; }
    if (repos.message.getLastMessageDirection(c.customerPhone) !== 'outbound') { repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'customer_replied'); continue; }
    if (repos.conversation.getSoftClosedAt(c.customerPhone)) { repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'soft_closed'); continue; }
    if (!isWithinServiceWindow(repos, c.customerPhone)) { repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'service_window_closed'); continue; }
    if (checkTimeWindow(repos, c.customerPhone).isLimited) { repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'message_limit_reached'); continue; }
    if (!isFollowUpSendWindow()) { repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'send_window_closed'); continue; }

    try {
      await sendText(c.customerPhone, reply);
    } catch (err) {
      if (err instanceof WhatsAppSendError && !err.deliveryUncertain) {
        repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, err.retryable ? 'whatsapp_retryable' : 'whatsapp_rejected');
      } else {
        repos.followUpEvent.markClaimUncertain(c.customerPhone, anchorInboundAt, stage, 'whatsapp_delivery_uncertain');
      }
      logger.warn({ err, phone: c.customerPhone, stage }, '[FOLLOW_UP] send failed');
      continue;
    }

    repos.followUpEvent.markClaimUncertain(c.customerPhone, anchorInboundAt, stage, 'whatsapp_accepted_persistence_pending');
    try {
      recordSent(c.customerPhone, reply, repos, stage, anchorInboundAt);
      if (reviewReminder) await sendReviewGallery(repos, c.customerPhone);
      logger.info({ phone: c.customerPhone, stage }, '[FOLLOW_UP] nudge sent');
    } catch (err) {
      logger.error({ err, phone: c.customerPhone, stage }, '[FOLLOW_UP] sent but persistence failed');
    }
  }
}

async function runFollowUps(repos: Repositories): Promise<void> {
  if (!env.AI_ENABLED || !isFollowUpSendWindow()) return;
  if (repos.isPaused()) return;

  const now = Date.now();
  const serviceWindowStart = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const secondCutoff = new Date(now - env.TIME_FINAL_NUDGE_HOURS * 60 * 60 * 1000).toISOString();
  const secondCandidates = repos.conversation.getSecondFollowUpCandidates(secondCutoff, serviceWindowStart, FOLLOW_UP_BATCH);
  await processCandidates(repos, secondCandidates, 'second_nudge');

  const firstCutoff = new Date(now - configuredHours() * 60 * 60 * 1000).toISOString();
  const firstCandidates = repos.conversation.getFollowUpCandidates(firstCutoff, serviceWindowStart, FOLLOW_UP_BATCH);
  await processCandidates(repos, firstCandidates, 'first_nudge');
}

export function startFollowUpScheduler(repos: Repositories): ReturnType<typeof setInterval> | undefined {
  if (configuredHours() <= 0) return undefined;
  const interval = setInterval(() => {
    void runFollowUps(repos).catch(err => logger.warn({ err }, '[FOLLOW_UP] worker failed'));
  }, POLL_MS);
  return interval;
}

export { runFollowUps };
