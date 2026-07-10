import type { Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getSkills } from './skill-loader.js';
import { buildSystemPrompt } from './deepseek-client.js';
import { llmClient } from './response-engine.js';
import {
  stripHandoffPhrases,
  containsUnsafeReservationClaim,
  containsPromptLeakOrPolicyViolation,
} from './reply-guard.js';
import { sendText } from './whatsapp-client.js';
import { checkBudget } from './budget-guard.js';
import { isWithinServiceWindow } from './time-window-policy.js';
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
/**
 * Max wasted LLM drafts per lead before we give up on the first nudge.
 * Bounds cost when DeepSeek keeps returning empty / unusable drafts within the
 * service window. Reset once the lead is marked (sent or attempt-exhausted).
 */
const MAX_FIRST_NUDGE_DRAFT_ATTEMPTS = 3;
const firstNudgeDraftAttempts = new Map<string, number>();

const FOLLOW_UP_TASK =
  'RE-ENGAGEMENT TASK: Reconnect with someone who stopped replying. Your goal is NOT to sell — it is to spark genuine curiosity with something UNIQUE to THIS conversation.\n' +
  '\n' +
  'HOW TO WIN:\n' +
  '- Hook must be CONCRETE and UNIQUE from this conversation history ONLY: their name, their date, their group size, their exact words, their situation.\n' +
  '- Examples of GOOD hooks: "Juana, ¿te acordas que hablamos de octubre? Justo vi algo de esa epoca...", "Pensando en tu viaje de octubre, ¿ya sabes como vas a llegar?"\n' +
  '- Create a curiosity gap: one short question tied to something they already shared. Not yes/no.\n' +
  '- Max ~200 chars. 1-2 sentences. 1 emoji max if natural. Tone: a friend texting, NOT a salesperson.\n' +
  '- Language: same as the customer used in history.\n' +
  '\n' +
  'BANNED PHRASES (will be cleaned or rejected):\n' +
  '- "pensé en ti" / "pense en ti" / "pensé en ustedes"\n' +
  '- "me acordé de ti" / "me acorde de ti" / "me acordé de ustedes"\n' +
  '- "vi algo y pensé en ti" / "se me vino una idea" / "se me vino una imagen" (as generic openers without concrete history)\n' +
  '- "sigues interesado" / "solo pasaba a ver" / "cómo vas" / "hola de nuevo" / "como vas"\n' +
  '- Zero mentions of product, price, company, "reservar", "plan", deposit, IG, social media, links.\n' +
  '\n' +
  'SAFETY: Never confirm dates, availability, spots, payments. Never include links or IG handles. Never invent companions or names not in history.\n' +
  '\n' +
  'CRITICAL: Never assume or invent the customer\'s companion or their name. If they said "para 2 personas" but never gave a name, do NOT guess who the other person is. Only reference facts the customer explicitly shared.';

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
  /\b(?:reservar|comprar|costo|precio|dep[oó]sito)\b/i,
  /\bplan(?:es)?\s+(?:de\s+\d|minero|rural|2d|3d)\b/i,
  /https?:\/\//i,
  /\binstagram\b/i,
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

/**
 * Records a wasted draft attempt for a lead. When the cap is hit we mark the
 * follow-up as sent so the worker stops retrying and burning LLM budget.
 * Returns true when the lead should be given up on.
 */
function registerWastedDraft(repos: Repositories, phone: string): boolean {
  const next = (firstNudgeDraftAttempts.get(phone) ?? 0) + 1;
  if (next >= MAX_FIRST_NUDGE_DRAFT_ATTEMPTS) {
    firstNudgeDraftAttempts.delete(phone);
    repos.conversation.markFollowUpSent(phone);
    return true;
  }
  firstNudgeDraftAttempts.set(phone, next);
  return false;
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

function configuredHours(): number {
  if (env.TIME_FOLLOW_HOURS <= 0) return 0;
  return Math.min(env.TIME_FOLLOW_HOURS, MAX_FOLLOW_HOURS);
}

async function sendAndRecord(
  phone: string,
  reply: string,
  repos: Repositories,
  sequenceNumber: number,
  stage: 'first_nudge' | 'pain_question',
  scoreBefore: number,
  result: { tokens: { prompt: number; completion: number } } | null,
): Promise<void> {
  const sentAt = new Date().toISOString();
  await sendText(phone, reply);
  repos.message.addMessage({
    customer_phone: phone,
    direction: 'outbound',
    message_type: 'text',
    body: reply,
    created_at: sentAt,
  });
  repos.conversation.markFollowUpSent(phone);
  repos.followUpEvent.insert({
    customerPhone: phone,
    sequenceNumber,
    stage,
    sentAt,
    repliedAt: null,
    scoreBefore,
    scoreAfter: null,
    detectedPain: null,
    status: 'sent',
  });
  if (result) {
    const cost = result.tokens.prompt * INPUT_COST_PER_TOKEN + result.tokens.completion * OUTPUT_COST_PER_TOKEN;
    repos.aiUsage.recordUsage({ phone, model: env.DEEPSEEK_MODEL, promptTokens: result.tokens.prompt, completionTokens: result.tokens.completion, cachedTokens: 0, estimatedCost: cost, purpose: 'follow_up', success: true });
  }
}

async function runFollowUps(repos: Repositories): Promise<void> {
  const hours = configuredHours();
  if (hours <= 0 || !env.AI_ENABLED) return;
  // Same global guard as the live reply path: a paused bot stays silent.
  if (repos.isPaused()) return;

  const now = Date.now();
  const serviceWindowStart = new Date(now - 23 * 60 * 60 * 1000).toISOString();

  // ── Stage 2: pain question — send to leads who replied the first nudge ───
  const painDelayHours = env.TIME_PAIN_FOLLOW_HOURS ?? 1;
  const firstNudgeRepliedBefore = new Date(now - painDelayHours * 60 * 60 * 1000).toISOString();
  const painCandidates = repos.conversation.getPainQuestionCandidates(serviceWindowStart, FOLLOW_UP_BATCH, firstNudgeRepliedBefore);
  for (const c of painCandidates) {
    if (repos.optOut.isOptedOut(c.customerPhone)) continue;
    if (!isWithinServiceWindow(repos, c.customerPhone)) continue;

    const skills = getSkills();
    const lang = c.language ?? 'es';
    const currentScore = repos.conversation.getLeadScore(c.customerPhone);
    const latest = repos.followUpEvent.getLatestByPhone(c.customerPhone);
    if (!latest) continue;

    const painQuestion = skills.fallbackReplies[lang].followUpPainQuestion;
    const seqNumber = latest.sequenceNumber + 1;
    try {
      await sendAndRecord(c.customerPhone, painQuestion, repos, seqNumber, 'pain_question', currentScore, null);
      logger.info({ phone: c.customerPhone }, '[FOLLOW_UP] pain question sent');
    } catch (err) {
      logger.warn({ err, phone: c.customerPhone }, '[FOLLOW_UP] pain question send failed');
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  // ── Stage 1: first nudge — send to silent leads ──────────────────────────
  const cutoff = new Date(now - hours * 60 * 60 * 1000).toISOString();
  const candidates = repos.conversation.getFollowUpCandidates(cutoff, serviceWindowStart, FOLLOW_UP_BATCH);

  for (const c of candidates) {
    // Re-check guards at send time (candidate query is a coarse pre-filter).
    if (repos.optOut.isOptedOut(c.customerPhone)) continue;
    if (!isWithinServiceWindow(repos, c.customerPhone)) continue;
    if (!checkBudget(repos, c.customerPhone).aiAllowed) continue;

    const skills = getSkills();
    const lang = c.language ?? 'es';
    const currentScore = repos.conversation.getLeadScore(c.customerPhone);
    const collected = getCollectedFields(repos, c.customerPhone);
    const salesPhase = repos.conversation.getSalesPhase(c.customerPhone);

    // Never follow up on leads already in closing / pending validation.
    if (salesPhase === 'closing') continue;

    // Reuse the production system prompt so follow-ups stay grounded in skill facts.
    const systemPrompt = buildSystemPrompt(skills, lang, collected, salesPhase ?? undefined);
    const history = repos.message.getRecentMessages(c.customerPhone, 24);

    const result = await llmClient.complete({
      systemPrompt,
      systemPromptSuffix: FOLLOW_UP_TASK,
      message: 'Genera el mejor seguimiento para este lead ahora.',
      history: history.map(h => ({ role: h.role, content: h.content })),
      lang,
    });

    let reply = result?.turn.reply.trim() ?? '';
    if (!reply) {
      const gaveUp = registerWastedDraft(repos, c.customerPhone);
      logger.warn({ phone: c.customerPhone, gaveUp }, '[FOLLOW_UP] empty draft; retry within window until attempt cap');
      continue;
    }

    reply = stripHandoffPhrases(reply);
    // Strip accidental full-intro re-greetings that the LLM may smuggle in
    // despite the task prompt's instructions.
    reply = stripOwnerReIntro(reply);
    reply = stripRetryableNudgeOpeners(reply);
    if (!reply) {
      const gaveUp = registerWastedDraft(repos, c.customerPhone);
      logger.warn({ phone: c.customerPhone, gaveUp }, '[FOLLOW_UP] retryable draft stripped empty; retry within window until attempt cap');
      continue;
    }
    // Reject drafts that leak commercial intent or unsafe links. These are not
    // style issues, so mark attempted to avoid unsafe retry loops.
    if (HARD_BLOCK_NUDGE_PATTERNS.some(p => p.test(reply))) {
      logger.warn({ phone: c.customerPhone, snippet: reply.slice(0, 80) }, '[FOLLOW_UP] draft blocked by hard nudge guard; skipping send');
      repos.conversation.markFollowUpSent(c.customerPhone);
      continue;
    }
    // Same safety guards the live reply path enforces: never let a follow-up
    // promise a reservation or leak the prompt/policy.
    if (containsUnsafeReservationClaim(reply) || containsPromptLeakOrPolicyViolation(reply)) {
      logger.warn({ phone: c.customerPhone }, '[FOLLOW_UP] draft blocked by safety guard; skipping send');
      repos.conversation.markFollowUpSent(c.customerPhone);
      continue;
    }

    const seqNumber = repos.followUpEvent.countByPhone(c.customerPhone) + 1;
    try {
      await sendAndRecord(c.customerPhone, reply, repos, seqNumber, 'first_nudge', currentScore, result);
      firstNudgeDraftAttempts.delete(c.customerPhone);
      logger.info({ phone: c.customerPhone }, '[FOLLOW_UP] first nudge sent');
    } catch (err) {
      logger.warn({ err, phone: c.customerPhone }, '[FOLLOW_UP] send failed');
    }
  }
}

export function startFollowUpScheduler(repos: Repositories): ReturnType<typeof setInterval> | undefined {
  if (configuredHours() <= 0) return undefined;
  const interval = setInterval(() => {
    void runFollowUps(repos).catch(err => logger.warn({ err }, '[FOLLOW_UP] worker failed'));
  }, POLL_MS);
  return interval;
}

/** Test-only: clears the in-memory wasted-draft attempt counters. */
export function resetFollowUpDraftAttempts(): void {
  firstNudgeDraftAttempts.clear();
}

export { runFollowUps };
