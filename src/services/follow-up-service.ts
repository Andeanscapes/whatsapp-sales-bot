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

const FOLLOW_UP_TASK =
  'RE-ENGAGEMENT TASK: Reconnect with someone who stopped replying. Your goal is NOT to sell — it is to spark genuine curiosity with something unexpected and personal.\n' +
  '\n' +
  'HOW TO WIN:\n' +
  '- Open with a pattern interrupt: "Me acorde de ti", "Vi algo y pense en ti", "Tengo una pregunta", "Se me vino una idea"\n' +
  '- Make it about THEM: their dream, their date, their group. Zero mentions of product, company, or price\n' +
  '- Create a curiosity gap: one short question that makes them think or smile. Not yes/no\n' +
  '- Use their name if you know it. Reference their date/people naturally if mentioned\n' +
  '- Max 200 chars. 1-2 sentences. 1 emoji max if natural. Tone: a friend texting\n' +
  '\n' +
  'WHAT KILLS CONVERSIONS:\n' +
  '- "Hola de nuevo", "Como vas", "Solo pasaba a ver", "Sigues interesado", "Queria saber"\n' +
  '- Mentioning the product, price, company, "reservar", "comprar", "plan"\n' +
  '- Sounding like a bot, script, or desperate salesperson\n' +
  '- Multiple questions, long paragraphs, corporate tone\n' +
  '- English replies when the customer speaks Spanish, or vice versa\n' +
  '\n' +
  'SAFETY: Never confirm dates, availability, spots, payments. Never include links or IG handles.\n' +
  '\n' +
  'CRITICAL: Never assume or invent the customer\'s companion or their name. If they said "para 2 personas" but never gave a name, do NOT guess who the other person is. Do NOT use names from the system context (Heinner, Alexandra, etc.) as if they were the customer\'s companion. Only reference companions the customer explicitly named.';

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

function igInvite(lang: 'es' | 'en' | null, igUrl: string): string {
  if (lang === 'en') {
    return `\n\nIn the meantime, check our IG ${igUrl} — real testimonials, videos, and more content from the experience.`;
  }
  return `\n\nMientras tanto, mira nuestro IG ${igUrl} — testimonios reales, videos y mas contenido de la experiencia.`;
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
    repos.aiUsage.recordUsage(phone, env.DEEPSEEK_MODEL, result.tokens.prompt, result.tokens.completion, 0, cost);
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
  const painCandidates = repos.conversation.getPainQuestionCandidates(serviceWindowStart, FOLLOW_UP_BATCH);
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

    // Reuse the production system prompt so follow-ups stay grounded in skill facts.
    const systemPrompt = buildSystemPrompt(skills, lang, collected, salesPhase ?? undefined);
    const history = repos.message.getRecentMessages(c.customerPhone, 16);

    const result = await llmClient.complete({
      systemPrompt,
      systemPromptSuffix: FOLLOW_UP_TASK,
      message: 'Genera el mejor seguimiento para este lead ahora.',
      history: history.map(h => ({ role: h.role, content: h.content })),
      lang,
    });

    let reply = result?.turn.reply.trim() ?? '';
    if (!reply) {
      // Mark as attempted so a permanently-empty case does not retry forever.
      repos.conversation.markFollowUpSent(c.customerPhone);
      continue;
    }

    reply = stripHandoffPhrases(reply);
    // Strip accidental full-intro re-greetings that the LLM may smuggle in
    // despite the task prompt's instructions.
    reply = stripOwnerReIntro(reply);
    // Append IG invite so silent leads have a low-friction way to re-engage.
    // Skip if the last outbound already includes the IG link — avoid repetitive spam.
    const igUrl = skills.andeanScapes.business.socialLinks?.instagram;
    if (igUrl && reply.length + igUrl.length < 900) {
      const lastOutbound = repos.message.getLastOutboundBody(c.customerPhone);
      if (!lastOutbound?.includes(igUrl)) {
        reply += igInvite(lang, igUrl);
      }
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

export { runFollowUps };
