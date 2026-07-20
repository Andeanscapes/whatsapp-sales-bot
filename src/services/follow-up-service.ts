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
  isPartnerConsultPause,
  isSoftCloseMessage,
} from './reply-guard.js';
import { sendText, WhatsAppSendError } from './whatsapp-client.js';
import { checkBudget } from './budget-guard.js';
import { checkTimeWindow, isWithinServiceWindow } from './time-window-policy.js';
import { getCollectedFields } from './qualification-engine.js';
import { INPUT_COST_PER_TOKEN, OUTPUT_COST_PER_TOKEN } from './constants.js';

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

const HARD_BLOCK_NUDGE_PATTERNS = [
  /\b(?:comprar|costo|precio|dep[oó]sito)\b/i,
  /\bplan(?:es)?\s+(?:de\s+\d|minero|rural|2d|3d)\b/i,
  /https?:\/\//i,
  /\binstagram\b/i,
  /\b(?:hook para reconectar|reconectar con este lead|este lead|hook to reconnect|reconnect with this lead|this lead)\b/i,
  /\b(?:viajeros?|travelers?)\b.{0,60}\b(?:encontraron|found)\b/i,
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

function isFollowUpPause(text: string): boolean {
  return isSoftCloseMessage(text)
    || isPartnerConsultPause(text)
    || /(?:quiero\s+pensarlo|lo\s+(?:quiero|voy|vamos)\s+a\s+pensar|déjame\s+pensarlo|let\s+me\s+think|te\s+avisar|yo\s+te\s+escribo|estamos\s+validando|a[uú]n\s+no|lo\s+(?:voy|vamos)\s+a\s+revisar|when\s+we\s+decide|we'?ll\s+let\s+you\s+know)/i.test(text);
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
    if (isNonSalesInquiry(latestInbound.content) || isFollowUpPause(latestInbound.content)) continue;

    const anchorInboundAt = c.anchorInboundAt;
    if (!anchorInboundAt) continue;
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

    let usageRecorded = false;
    const result = await llmClient.complete({
      systemPrompt: buildFollowUpPrompt({ lang, phase: salesPhase, stage }),
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
    // Replace drafts that leak commercial intent or unsafe links with trusted copy.
    if (HARD_BLOCK_NUDGE_PATTERNS.some(p => p.test(reply))) {
      repos.followUpEvent.markClaimFailed(c.customerPhone, anchorInboundAt, stage, 'unsafe_draft');
      logger.warn({ phone: c.customerPhone, snippet: reply.slice(0, 80) }, '[FOLLOW_UP] draft blocked by hard nudge guard');
      continue;
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
