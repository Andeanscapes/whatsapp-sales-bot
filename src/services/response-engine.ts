import { getSkills, refreshSkills, isDynamicDataFresh, type Skills, type FallbackReplies } from './skill-loader.js';
import { logger } from '../config/logger.js';
import { logSystemError } from './error-logger.js';
import { env } from '../config/env.js';
import { containsMediaMarkerSyntax, parseMediaMarker, resolveMediaThemes } from './media-marker.js';
import { scoreMessage, computeHybridScore, computeAnalyzerFallbackScore, type LlmLeadInput } from './lead-scoring.js';
import { checkTimeWindow } from './time-window-policy.js';
import { checkBudget } from './budget-guard.js';
import { reportAiBudgetBlocked } from './whatsapp-operational-health.js';
import { buildSystemPrompt } from './deepseek-client.js';
import { extractCustomerContext } from './customer-context.js';
import { DeepSeekLlmClient } from './llm/deepseek-llm-client.js';
import { runLeadAnalysis } from './lead-analysis-runner.js';
import type { LlmTurn } from './llm/llm-client.js';
import type { MergedQualification, OutboundDateAction, ProcessMessageInput, ProcessMessageOutput } from './types.js';
import { getActiveExperience, getCommonQuestions, getFutureAvailableDatesForPlan, getGalleryImages, getPlans, hasPublicPaymentFacts, isPricingAvailable, getPublicPaymentFacts, hasMultipleExperiences, getExperiences, scopeSkillsToExperience } from './product-registry.js';
import type { ActiveExperience, PublicPaymentFacts } from './product-registry.js';
import { calculatePriceQuote, formatCop, type TransportNeed } from './pricing-calculator.js';
import {
  extractBookingFields,
  contextAwareExtract,
  reconstructFromHistory,
  buildDbQualification,
  getCollectedFields,
  resolveLanguage,
  isConfirmedDate,
  isQualificationComplete,
  detectPlan,
  isDateAskQuestion,
} from './qualification-engine.js';
import { galleryImageLimit, hasShownLlmGallery, remainingGalleryImageBudget, selectBalancedByCategory } from './media-service.js';
import {
  isSoftCloseMessage,
  isAdcodeNoise,
  containsInternalEntryMarker,
  isReEngagementMessage,
  isReviewPause,
  getLastAssistantQuestion,
  detectsReservationIntent,
  detectsAvailabilityConfirmRequest,
  detectsOrganizerContactShare,
  detectsWrongServiceNatureOnly,
  isReservationIntentOrConfirmation,
  isExplicitCloseCtaConfirmation,
  matchesCloseCtaQuestion,
  replyMentionsPrice,
  containsHandoffPhrase,
  containsUnsafeReservationClaim,
  containsPaymentDetailLeak,
  containsFalseReservationClaim,
  containsPromptLeakOrPolicyViolation,
  isTruncatedReply,
  isGalleryRequest,
  isGalleryContinuationRequest,
  isNonSalesInquiry,
  hasUnmarkedPhotoPromise,
  isGalleryConfirmation,
  detectProactiveLeadPain,
  isPaymentMethodsQuestion,
  qualificationSummary,
  isReservationIntentNegated,
  extractEmojis,
  logEmojiStyle,
  logReplyStyle,
  diagnosticMediaReply,
  stripEmojisOnPaymentClose,
  stripPaymentMoveWithoutDate,
} from './reply-guard.js';
import { findEntryMarker, parseEntryMarker } from './entry-marker.js';
import { classifyConsentReply, isDuplicateConsentEcho } from './followup-consent.js';
import { detectRequestedGalleryThemes, selectContextualImage } from './contextual-media.js';
import { assignLine, isReferralLine } from './lead-routing.js';
import { MONTH_NAMES } from './constants.js';
import { estimateDeepSeekCost } from './deepseek-cost.js';
import type { ConversationRow, RecentMessage, LeadPain } from '../db/repositories/types.js';

export {
  detectsReservationIntent,
  isReservationIntentOrConfirmation,
  replyMentionsPrice,
  containsHandoffPhrase,
  isTruncatedReply,
};

export type { ProcessMessageInput, ProcessMessageOutput };

function withConversationState(
  repos: ProcessMessageInput['repos'],
  customerPhone: string,
  output: ProcessMessageOutput,
): ProcessMessageOutput {
  return {
    ...output,
    conversationMode: repos.conversation.getMode(customerPhone),
    salesPhase: repos.conversation.getSalesPhase(customerPhone),
    softClosed: repos.conversation.getSoftClosedAt(customerPhone) != null,
    intent: repos.conversation.getLeadIntent(customerPhone),
  };
}

function formatEntryPriorContext(conversation: ConversationRow): string {
  const fields = [
    conversation.collected_plan ? `plan=${conversation.collected_plan}` : null,
    conversation.collected_people != null ? `personas=${conversation.collected_people}` : null,
    conversation.collected_date ? `fecha=${conversation.collected_date}` : null,
    conversation.collected_transport_need ? `transporte=${conversation.collected_transport_need}` : null,
    conversation.price_given_at ? 'precio ya entregado' : null,
    conversation.sales_phase ? `fase=${conversation.sales_phase}` : null,
    conversation.lead_pain ? `bloqueo=${conversation.lead_pain}` : null,
  ].filter((field): field is string => field !== null);
  return fields.length > 0 ? `historial local disponible; ${fields.join(' · ')}` : 'historial local disponible; datos previos limitados';
}

function hasQualifiedRetargetingContext(conversation: ConversationRow | null | undefined): boolean {
  return conversation?.collected_plan != null && conversation.collected_people != null;
}

/**
 * Marks lead as waiting on human validation. Bot keeps replying (payment facts,
 * clarifications). Does NOT set handed_off_at and does NOT open a live bridge —
 * agent must still run /chat to take exclusive control. Webhook notifies the
 * assigned bridge line on further inbound while mode stays human_pending.
 */
function enterHumanPending(repos: ProcessMessageInput['repos'], customerPhone: string): void {
  repos.conversation.setMode(customerPhone, 'human_pending');
  repos.conversation.setSalesPhase(customerPhone, 'closing');
}

const SPANISH_MONTH_INDEX: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

function extractPastExplicitDate(text: string, now = new Date()): string | null {
  const match = text.match(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})\b/i);
  if (!match) return null;
  const day = Number(match[1]);
  const month = SPANISH_MONTH_INDEX[match[2].toLowerCase()];
  const year = Number(match[3]);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(now);
  const current = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
  const candidateValue = year * 10_000 + month * 100 + day;
  const currentValue = current.year * 10_000 + current.month * 100 + current.day;
  return candidateValue < currentValue ? match[0] : null;
}

function isPhysicalRecoveryQuestion(message: string): boolean {
  return /\b(?:fractura|fracture|movilidad limitada|limitaci[oó]n(?: temporal)? de movilidad|limited mobility|riesgo de ca[ií]da|evitar ca[ií]das|fall risk|recuper[aá]ndo(?:me)? de (?:una? )?(?:fractura|lesi[oó]n|cirug[ií]a)|recovering from (?:a )?(?:fracture|injury|surgery)|recuperaci[oó]n de (?:una? )?(?:fractura|lesi[oó]n|cirug[ií]a))\b/i.test(message);
}

function safetyPolicyReply(skills: Skills, lang: 'es' | 'en', message: string): string | null {
  const reservationLeadTimeQuestion = /(?:con cu[aá]nt[oa].{0,50}(?:anticip|tiempo).{0,50}reserv|reserv.{0,50}(?:anticip|tiempo)|how far.{0,30}(?:ahead|advance).{0,30}book)/i.test(message);
  const physicalRecoveryQuestion = isPhysicalRecoveryQuestion(message);
  if (!reservationLeadTimeQuestion && !physicalRecoveryQuestion) return null;
  const intent = physicalRecoveryQuestion ? 'physical_recovery' : 'reservation_lead_time';
  const questions = getCommonQuestions(getActiveExperience(skills));
  return questions.find(question => question.lang === lang && question.intent === intent)?.answer ?? null;
}

function matchExperienceFromReply(message: string, skills: Skills, allowPositional: boolean): ActiveExperience | null {
  const norm = normalizeForKeywordMatch(message);
  const trimmed = message.trim().slice(0, 80);
  for (const exp of getExperiences(skills)) {
    const normalizedName = normalizeForKeywordMatch(exp.name);
    if (normalizedName.length > 3 && norm.includes(normalizedName)) return exp;
    const expWords = exp.name.toLowerCase().split(/\s+/);
    const matchCount = expWords.filter(w => w.length > 3 && norm.includes(w)).length;
    if (matchCount >= 2) return exp;
    // Single-letter picks: "A", "B" etc. for positional listing
    const expIndex = getExperiences(skills).indexOf(exp);
    if (allowPositional && trimmed === String(expIndex + 1)) return exp;
    if (allowPositional && /^[a-z]$/i.test(trimmed)) {
      const letterIndex = trimmed.toUpperCase().charCodeAt(0) - 65;
      if (letterIndex === expIndex) return exp;
    }
  }
  return null;
}

/** True when inclusions is the only (or primary) ask — not a multi-fact dump. */
/** Deterministic inclusions package — LLM must not omit core package facts. */
function extractFutureMonthConstraint(text: string): string | null {
  const match = text.match(/\b(?:despu[eé]s de|after)\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
  return match ? match[0] : null;
}

function getSystemErrorRetry(lang: 'es' | 'en' | null): string {
  return getSkills().fallbackReplies[lang ?? 'es'].systemErrorRetry;
}

const INTERNAL_SENTINELS = new Set(['undefined', 'null', 'none']);

function sanitizeCollectedFields(fields: Record<string, unknown>, internalDatePending: string): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith('_')) continue;
    if (k === 'fecha' && typeof v === 'string' && (v === 'tentative_unknown' || v.startsWith('_relative_ordinal_'))) {
      safe[k] = internalDatePending;
      continue;
    }
    if (typeof v === 'string' && (INTERNAL_SENTINELS.has(v) || v.startsWith('_relative_ordinal_'))) continue;
    safe[k] = v;
  }
  if (fields.dateStatus === 'deferred' || fields.dateStatus === 'options_offered') {
    safe.fecha = internalDatePending;
    safe.dateStatus = fields.dateStatus;
    safe.dateNote = fields.dateStatus === 'options_offered'
      ? 'Date already discussed; options were offered. Do NOT re-ask for a tentative date.'
      : 'Customer has no fixed date yet (deferred). Do NOT re-ask for a tentative date.';
  } else if (typeof fields.dateStatus === 'string') {
    safe.dateStatus = fields.dateStatus;
  }
  return safe;
}

type SalesPhase = 'greeting' | 'discovery' | 'value' | 'pricing' | 'objection' | 'closing';

function inferSalesPhase(merged: MergedQualification, priceGiven: boolean, replyText: string, customerMessage: string, currentScore: number, isFirstContact: boolean): SalesPhase {
  if (isFirstContact) return 'greeting';
  const norm = customerMessage.toLowerCase().trim();
  const isObjectionCustomer = /caro|expen|consultar|pensar|lo hablo|lo miro|dud|[^n]o estoy segur|no s[eé]|not sure/i.test(norm);
  if (priceGiven && isObjectionCustomer) return 'objection';
  if (priceGiven || replyMentionsPrice(replyText)) {
    const fullyQualified = merged.nombre && merged.personas != null && merged.fecha != null && merged.transporte != null;
    if (fullyQualified) return 'closing';
    return 'pricing';
  }
  const hasDesire = merged.personas != null || (merged.plan != null && currentScore >= 15) || (merged.nombre != null && merged.personas != null);
  if (hasDesire) return 'value';
  return 'discovery';
}

const PAIN_OPTION_PATTERNS: Array<{ pain: LeadPain; patterns: RegExp }> = [
  { pain: 'price', patterns: /\b(precio|caro|costoso|vale mucho|dinero|plata|presupuesto|expensive|money|budget|afford|too much|costly)\b|^\s*1\s*$/i },
  { pain: 'date_time', patterns: /\b(fecha|fechas|cuando voy|calendario|disponibilidad|disponible|agenda|date|timing|schedule|availability)\b|^\s*2\s*$/i },
  { pain: 'security', patterns: /\b(seguridad|seguro|peligro|riesgo|miedo|claustro|safety|safe|dangerous|danger|risk|afraid|scared|secure)\b|^\s*3\s*$/i },
  { pain: 'logistics_4x4', patterns: /\b(transporte|carro|vehiculo|4x4|llegar|llegada|ruta|logistica|transport|vehicle|car|route|driving|drive|4wd)\b|^\s*4\s*$/i },
  { pain: 'experience_clarity', patterns: /\b(entender|experiencia como|como es la|que incluye|no entiendo|no se como|understand|how it works|what.s included|what does|clarity|not sure what)\b|^\s*5\s*$/i },
  { pain: 'partner_group', patterns: /\b(consultar|lo hablo|lo pienso|pareja|esposo|esposa|novia|novio|amigo|familia|consult|partner|spouse|friend|family|someone|discuss)\b|^\s*6\s*$/i },
];

export function detectLeadPain(message: string): LeadPain | null {
  const norm = message.toLowerCase().trim();
  for (const entry of PAIN_OPTION_PATTERNS) {
    if (entry.patterns.test(norm)) return entry.pain;
  }
  return null;
}

function normalizeForKeywordMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Collapse newlines/tabs/repeated spaces. WhatsApp users split a stop request
    // across lines ("No me\nEnvíes más esto"), and a raw newline defeats every
    // multi-word keyword, silently turning an opt-out into a normal sales turn.
    .replace(/\s+/g, ' ')
    .trim();
}

function isPriceDateOrReservationMessage(text: string): boolean {
  const norm = normalizeForKeywordMatch(text);
  return /\b(?:precio|precios|cuanto|cuanta|cuantas|cuantos|vale|valor|costo|cuesta|fecha|fechas|disponible|disponibilidad|cupo|cupos|agenda|agendar|reservar|reserva|reservacion|separar|pagar|pago|deposito|abono|nequi|price|prices|cost|fee|date|dates|available|availability|schedule|book|booking|reserve|reservation|pay|payment|deposit)\b/i.test(norm)
    || norm.includes('how much')
    || norm.includes('mercado pago');
}

/**
 * Did this inbound mean "I am still in this conversation"?
 *
 * Used only to decide whether a *pending* consent ask was premature and should be
 * deferred so it can be asked again after the new silence.
 *
 * ORDERING DEPENDENCY: this deliberately does not test for opt-out phrasings,
 * because `isOptOutMessage` intercepts and returns earlier in `processMessageCore`.
 * If the deferral is ever moved above that intercept, a customer sending "no me
 * escribas más" would have their consent ask re-armed instead of revoked.
 *
 * This deliberately does NOT require sales content. The previous gate scored the
 * message and demanded a keyword or a signal, which silently failed for every
 * bare answer to the bot's own question — `scoreMessage` returns 0 signals for
 * "juan", "ok", "listo", "2" and even "suena bien". A customer who answers "juan"
 * to "¿me confirmas el nombre?" has plainly re-opened the 24h window, but the
 * subscription stayed `pending` forever, so no second ask and no recurring
 * template could ever follow.
 *
 * Only genuinely terminal or off-topic inbound is excluded: an explicit farewell,
 * a soft close ("muy caro", "lo pienso") and a job enquiry must not earn another
 * permission prompt. The once-per-session cap still lives in the repository.
 */
function isConsentAskContinuation(text: string): boolean {
  if (normalizeForKeywordMatch(text).length === 0) return false;
  return !isExplicitCustomerFarewell(text)
    && !isSoftCloseMessage(text)
    && !isNonSalesInquiry(text);
}

function isExplicitCustomerFarewell(text: string): boolean {
  const normalized = normalizeForKeywordMatch(text)
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:(?:gracias|thanks)\s+)?(?:adios|chao|hasta luego|bye|goodbye|see you)(?:\s+(?:gracias|thanks))?$/.test(normalized);
}

// A stop request is honoured even when it targets one kind of message ("no me
// envíes más esto"): the compliant failure mode is to stop everything, never to
// keep sending because the phrasing was narrow.
const OPT_OUT_KEYWORDS_ES = ['detener', 'cancelar mensajes', 'no me escriban', 'no me escribas', 'basta', 'suficiente', 'dejen de escribirme', 'deja de escribirme', 'deja de escribir', 'dejen de escribir', 'no me contacten', 'no me contacte', 'no me contactes', 'sacame de la lista', 'sacame de tus mensajes', 'no quiero recibir mensajes', 'no quiero mas mensajes', 'borra mis datos', 'eliminame', 'eliminame de la lista', 'no me vuelvan a escribir', 'no me vuelvas a escribir', 'no me manden mas mensajes', 'no me mandes mas mensajes', 'dejen de molestar', 'deja de molestarme', 'no me molestes', 'dejame en paz', 'paren', 'bloqueo', 'reporto', 'no me escriban mas', 'no me escribas mas',
  // "enviar" family — the most common way to refuse the follow-up itself.
  'no me envies mas', 'no me envie mas', 'no me envien mas', 'no envies mas', 'no enviar mas',
  'no me mandes mas', 'no me manden mas', 'no me mande mas',
  // "already stop" / "stop doing it" phrasings.
  'ya no me escribas', 'ya no me escriban', 'ya no me envies', 'ya no me manden',
  'no me escriba mas', 'no me sigas escribiendo', 'no me sigan escribiendo',
  'para de escribirme', 'paren de escribirme', 'no quiero recibir mas'];
const OPT_OUT_KEYWORDS_EN = ['stop', 'unsubscribe', 'no more messages', 'remove me', 'do not contact me', 'take me off', 'take me off the list', 'please stop', 'enough', "i'm done", 'i am done', 'unsubscribe me', 'do not text', 'do not message', 'stop messaging', 'leave me alone', 'do not disturb', 'block', 'report spam'];
const ALL_OPT_OUT_KEYWORDS = [...OPT_OUT_KEYWORDS_ES, ...OPT_OUT_KEYWORDS_EN];

/**
 * "no me mandes más fotos" scopes the request to one kind of content, not to the
 * conversation. Silencing the whole thread there loses a live lead, so these
 * clauses are removed before the stop-keyword match runs. Anything that remains is
 * still evaluated, so "no me mandes más fotos ni mensajes, basta" is a real opt-out.
 */
const MEDIA_SCOPED_STOP = /\b(?:ya\s+)?no\s+(?:me\s+)?(?:mandes|manden|mande|envies|envie|envien|sigas mandando|sigas enviando)\s+mas\s+(?:fotos?|imagenes?|videos?|audios?|stickers?|notas de voz|mensajes de voz)\b/g;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keywords match on word boundaries, never as bare substrings. `basta` sits inside
 * `bastante`, `paren` inside `parentesco`/`aparentemente`, and `bloqueo` inside
 * `desbloqueo`, so a plain `includes()` opted out live leads on ordinary sales
 * messages ("bastante interesado") and set the permanent `last_opt_out_at`
 * compliance flag, after which the bot goes silent for good.
 * Built once: these are module-level constants.
 */
const OPT_OUT_PATTERNS: readonly RegExp[] = ALL_OPT_OUT_KEYWORDS
  .map(keyword => new RegExp(`\\b${escapeRegExp(keyword)}\\b`));

/**
 * Bare standalone stop phrases that are also ambiguous in isolation, so they are
 * matched ONLY as a whole message after punctuation is stripped — never with a
 * `\b...\b` regex. Adding `no mas` to the keyword list would also fire inside
 * "no mas de 5 personas" (a group-size answer) and permanently silence a live lead
 * with `last_opt_out_at` set. `ya no` and `para` are deliberately excluded: "¿les
 * interesa el 15?" → "ya no" means not-that-date, and `para` collides with
 * "para 2 personas".
 */
const OPT_OUT_STANDALONE_PHRASES: ReadonlySet<string> = new Set([
  'no mas',
  'no mas por favor',
  'no mas porfa',
  'no mas gracias',
  'no mas mensajes',
  'no mas nada',
  'ya no mas',
  'no more',
  'no more please',
  'no more thanks',
]);

/** Same word-boundary safety as the keywords, but only as the ENTIRE message. */
function isStandaloneOptOut(message: string): boolean {
  const normalized = normalizeForKeywordMatch(message)
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return OPT_OUT_STANDALONE_PHRASES.has(normalized);
}

export function isOptOutMessage(message: string): boolean {
  const normalized = normalizeForKeywordMatch(message);
  const unscoped = normalized.replace(MEDIA_SCOPED_STOP, ' ');
  return OPT_OUT_PATTERNS.some(pattern => pattern.test(unscoped))
    || isStandaloneOptOut(message);
}

export const llmClient = new DeepSeekLlmClient(true);

function isPriceQuestion(text: string): boolean {
  const norm = normalizeForKeywordMatch(text);
  if (/\bvale\s+la\s+pena\b/.test(norm)
    && !/\b(?:precio|precios|valor|costo|cuesta|cuestan|price|prices|cost|costs|cuanto|how much)\b/.test(norm)) {
    return false;
  }
  // Capacity / group-size questions are not price questions.
  if (/\b(?:permite|capacidad|maximo|maximum|tamano|group size|cupo maximo)\b/.test(norm)
    && !/\b(?:precio|precios|vale|valor|costo|cuesta|price|cost|cuanto|how much)\b/.test(norm)) {
    return false;
  }
  if (norm.includes('how much')) return true;
  const tokens = new Set(norm.split(/[^a-z0-9]+/).filter(Boolean));
  if (['precio', 'precios', 'valor', 'costo', 'cuesta', 'cuestan', 'price', 'prices', 'cost', 'costs', 'presupuesto', 'presupuestos'].some(t => tokens.has(t))) return true;
  // Colloquial "vale" (OK/agreed) is not a price word on its own.
  // Only treat it as price when paired with a price carrier.
  if (tokens.has('vale')) {
    if (tokens.has('cuanto') || /\b(?:cuanto|cual|que)\s+vale\b/.test(norm)) return true;
    if (/\bvale\s+(?:el|la|lo|\$?\d|unos?|como)\b/.test(norm)) return true;
    if (/\bvale\s+(?:el\s+)?(?:plan|tour|paquete|experiencia|viaje)\b/.test(norm)) return true;
  }
  if (tokens.has('cuanto') && !/\bcuanto\s+(dura|tiempo|personas|people)\b/.test(norm)) return true;
  if (tokens.has('total') && (
    tokens.has('exacto') || tokens.has('exact') || tokens.has('paquete') || tokens.has('package')
    || tokens.has('cuanto') || /\bpara\s+(?:los\s+)?\d+\b/.test(norm)
  )) return true;
  return /\b(?:cual es el|what is the|whats the) total\b/.test(norm);
}

// Numbers from calculator; package copy from fallback-replies (value before number).
/** First full price after explicit ask once party size is known (date does not gate base price). */
// Known template placeholders used across fallback-replies.json and prompts.
// Matched with single OR double braces so an LLM emitting `{planName}` is also
// caught. Kept explicit (not `[a-zA-Z]+`) so legitimate `{word}` copy — e.g.
// "usa el codigo {promo}" — is never treated as a leak. `plan` matches
// planName/planDuration/planSummary/planTotal via prefix.
const KNOWN_TEMPLATE_TOKENS = /\{\{?(?:addonsTotal|age|agentName|continuation|count|couplePrice|coupleTotal|currency|date|dateClause|dates|deposit|depositAmount|displayNumber|duration|experienceName|experienceSummary|individualPrice|instagramUrl|itinerarySummary|label|maxGroupSize|methods|month|name|paymentUrl|people|peopleClause|plan[A-Za-z]*|plans|price|priceLine|soloTotal|startingPrice|statusClause|summary|total|transportTotal|unit|window|windowClause)\}?\}/;

/** Internal state sentinels that must never surface to a customer. */
const INTERNAL_SENTINEL_LEAK = /\btentative_unknown\b|_relative_ordinal_[a-z0-9_]+/i;
/**
 * The skill files use SQUARE-bracket placeholders ([TOTAL], [N], [PLAN]…) while
 * KNOWN_TEMPLATE_TOKENS above only covers curly braces, so an unsubstituted
 * skill placeholder used to reach customers verbatim — e.g. "el plan queda en
 * [TOTAL]" whenever the pricing figure was unavailable.
 */
const SKILL_PLACEHOLDER_LEAK = /\[[A-Z][A-Z_]*\]/;
/**
 * Reply is moving the customer to payment: asking for the deposit, naming a
 * payment method, or declaring the booking settled.
 */
const MOVES_TO_PAYMENT = /\banticipo\b|\bdep[oó]sito\b|\babono\b|\bnequi\b|\bmercado\s*pago\b|\bpara\s+confirmar\b|\bqued[oó]\s+confirmad|\bya\s+qued[oó]\b|\bdeposit\b|\bdown\s+payment\b/i;
const COP_AMOUNT = /(?:\$\s*|COP\s*)?(\d{1,3}(?:[.,]\d{3})+|\d{6,})(?:\s*(?:COP|pesos))?/gi;

export type HardSafetyReason =
  | 'prompt_leak'
  | 'payment_detail_leak'
  | 'false_reservation_claim'
  | 'price_without_pricing'
  | 'template_token_leak'
  | 'internal_sentinel_leak'
  | 'skill_placeholder_leak'
  | 'payment_without_date'
  | 'entry_marker_leak'
  /** `[[FOTOS` syntax survived stripping — a malformed marker, not a prompt leak. */
  | 'media_marker_malformed'
  /** Well-formed marker the engine could not honour: no reply text left, or no photos resolved. */
  | 'media_marker_unhonoured';

/**
 * Post-LLM safety verdict. Returns a reason when the model's reply must not go out
 * as-is. This never edits model text — the engine either sends it verbatim, swaps
 * a curated non-echoing fallback, or suppresses entirely.
 */
export function hardSafetyFail(
  reply: string,
  pricingAvailable: boolean,
  /** A concrete travel date the team could actually hold. Defaults true to keep existing callers unchanged. */
  hasConfirmedDate = true,
): HardSafetyReason | null {
  if (containsPromptLeakOrPolicyViolation(reply)) return 'prompt_leak';
  if (containsPaymentDetailLeak(reply)) return 'payment_detail_leak';
  if (containsFalseReservationClaim(reply)) return 'false_reservation_claim';
  if (!pricingAvailable && replyMentionsPrice(reply)) return 'price_without_pricing';
  if (KNOWN_TEMPLATE_TOKENS.test(reply)) return 'template_token_leak';
  if (INTERNAL_SENTINEL_LEAK.test(reply)) return 'internal_sentinel_leak';
  if (containsMediaMarkerSyntax(reply)) return 'media_marker_malformed';
  if (SKILL_PLACEHOLDER_LEAK.test(reply)) return 'skill_placeholder_leak';
  // Never take a deposit for a trip with no date. Observed in production: the
  // bot invented "esa fecha" in a follow-up, the customer said "Si", and the
  // next reply asked for a 15% deposit on a booking nobody could hold.
  if (!hasConfirmedDate && MOVES_TO_PAYMENT.test(reply)) return 'payment_without_date';
  if (containsInternalEntryMarker(reply)) return 'entry_marker_leak';
  return null;
}

function extractCopAmounts(reply: string): number[] {
  return [...reply.matchAll(COP_AMOUNT)]
    .map(match => Number.parseInt(match[1].replace(/[.,]/g, ''), 10))
    .filter(amount => Number.isFinite(amount) && amount >= 100_000);
}

/**
 * Diagnostic only (log-only rollout): never edits, gates, or suppresses the reply.
 * Returns the unaccounted-for COP figures so the behaviour is unit-testable.
 */
export function logQuoteMismatch(
  reply: string,
  exp: ActiveExperience,
  merged: MergedQualification,
  phone: string,
  depositPercent: number,
): number[] {
  if (typeof merged.personas !== 'number' || !isPricingAvailable(exp)) return [];

  const quote = calculatePriceQuote(exp, {
    planId: typeof merged.plan === 'string' ? merged.plan : undefined,
    people: merged.personas,
    transportNeed: typeof merged.transporte === 'string' ? merged.transporte as TransportNeed : undefined,
  });
  if (!quote) return [];

  // Every figure the model may legitimately quote for this state: package totals,
  // catalog unit prices, and the deposit derived from either total (same formula as
  // buildCloseReply). Anything else is a figure we cannot account for.
  const totals = [quote.planTotal, ...(quote.total == null ? [] : [quote.total])];
  const allowed = new Set<number>([
    ...totals,
    ...totals.map(total => Math.round(total * depositPercent / 100)),
    quote.addonsTotal,
    ...(quote.transportTotal == null ? [] : [quote.transportTotal]),
    ...exp.pricing.items.flatMap(item => [item.pricePerPerson, item.couplePrice]),
  ].filter((amount): amount is number => amount != null));
  const mentioned = extractCopAmounts(reply);
  const unexpected = mentioned.filter(amount => !allowed.has(amount));
  if (unexpected.length > 0) {
    logger.warn({
      phone,
      people: quote.people,
      planId: quote.planId,
      expectedTotal: quote.total ?? quote.planTotal,
      mentioned: mentioned.slice(0, 10),
      unexpected: unexpected.slice(0, 10),
    }, '[BOT] LLM quote differs from deterministic pricing calculation');
  }
  return unexpected;
}

/** True when any substitute copy risks echoing the blocked content. */
function isEchoRiskSafetyFail(reason: HardSafetyReason): boolean {
  // A skill placeholder is our own un-substituted token, not echoed customer or
  // injected content, so the curated fallback is safe to send: the customer gets
  // a graceful reply instead of silence, and the owner is alerted either way.
  return reason === 'prompt_leak' || reason === 'payment_detail_leak' || reason === 'entry_marker_leak';
}

/** Passthrough for deterministic fallbacks — do not append sales CTAs. */
function ensureAdvanceQuestion(
  reply: string,
  _fb: FallbackReplies['es'],
  _merged: MergedQualification,
): string {
  return reply.trim();
}

function instagramUrl(skills: Skills): string {
  return skills.andeanScapes.business.socialLinks?.instagram ?? '';
}

function countRecentStartsWith(
  recentMessages: RecentMessage[],
  texts: string[],
  prefixLen: number,
): number {
  return recentMessages
    .filter(msg => msg.role === 'assistant')
    .slice(-prefixLen)
    .filter(msg => texts.some(text => msg.content.startsWith(text)))
    .length;
}

/** Infer outbound date-status action from assistant reply text. */
function detectOutboundDateAction(reply: string, merged: MergedQualification): OutboundDateAction | undefined {
  if (!reply.trim()) return undefined;
  if (isDateAskQuestion(reply) && (merged.dateStatus === 'unasked' || merged.dateStatus == null || merged.dateStatus === 'asked')) {
    return 'asked';
  }
  if (/\b(?:fechas?\s+disponibles|pr[oó]ximas\s+fechas|opciones\s+disponibles|available\s+dates|published\s+dates)\b/i.test(reply)
    && (merged.dateStatus === 'deferred' || merged.dateStatus === 'asked' || merged.dateStatus === 'options_offered' || merged.dateStatus === 'unasked' || merged.dateStatus == null)) {
    // Only mark options when reply actually lists or offers options, not a pure date ask.
    if (!/\bfecha tentativa en mente\b/i.test(reply) || /\bopciones|disponibles|publicadas\b/i.test(reply)) {
      if (/\b(?:muestre|mostrar|revisar|compar|list|opciones|disponibles|publicadas)\b/i.test(reply)) {
        return merged.dateStatus === 'deferred' || merged.dateStatus === 'options_offered' || /\bopciones|disponibles|publicadas\b/i.test(reply)
          ? 'options_offered'
          : 'asked';
      }
    }
  }
  return undefined;
}

type CloseKind = 'closing' | 'pending_owner';

function formatMethods(names: string[], lang: 'es' | 'en'): string {
  if (names.length === 0) return lang === 'es' ? 'metodo disponible' : 'available method';
  if (names.length === 1) return names[0];
  const joiner = lang === 'es' ? ' o ' : ' or ';
  return names.slice(0, -1).join(', ') + joiner + names[names.length - 1];
}

function displayDate(fecha: unknown, lang: 'es' | 'en'): string {
  if (typeof fecha === 'string' && fecha.trim() && !fecha.startsWith('_') && fecha !== 'tentative_unknown') {
    return fecha;
  }
  return lang === 'es' ? 'esa fecha' : 'that date';
}

function displayName(nombre: unknown, lang: 'es' | 'en'): string {
  if (typeof nombre === 'string' && nombre.trim()) return nombre.trim();
  return lang === 'es' ? 'Hola' : 'Hi';
}

function availabilityEntryForDate(skills: Skills, fecha: unknown, planId?: string | null): { status: string } | null {
  if (typeof fecha !== 'string') return null;
  const normalized = normalizeForKeywordMatch(fecha);
  const explicitYear = normalized.match(/\b(20\d{2})\b/)?.[1];
  const experience = getActiveExperience(skills);
  return getFutureAvailableDatesForPlan(skills, experience, planId).find(entry => {
    if (normalized === entry.date) return true;
    const date = new Date(`${entry.date}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return false;
    if (explicitYear && date.getUTCFullYear() !== Number(explicitYear)) return false;
    const day = String(date.getUTCDate());
    const month = new Intl.DateTimeFormat('es-CO', { month: 'long', timeZone: 'UTC' }).format(date);
    return new RegExp(`\\b${day}\\b`).test(normalized) && normalized.includes(normalizeForKeywordMatch(month));
  }) ?? null;
}

/** Day+month (or ISO) required before reservation-close CTA; month-only is not enough. */
function selectedDateFromAvailabilityReply(
  message: string,
  lastAssistantQuestion: string | null,
  skills: Skills,
  planId?: string | null,
): string | null {
  if (!lastAssistantQuestion || !/^(?:s[ií]|sip|si claro|claro|dale|listo|perfecto|de una|por supuesto)(?:\b|$|[\s,!.])/i.test(message.trim())) return null;
  if (!/(?:fecha|fin de semana|les sirve|te sirve|available|date|weekend)/i.test(lastAssistantQuestion)) return null;

  const assistantNorm = normalizeForKeywordMatch(lastAssistantQuestion);
  const messageNorm = normalizeForKeywordMatch(message);
  const selectedDay = messageNorm.match(/\b(?:el\s+)?([1-9]|[12]\d|3[01])\b/)?.[1];
  const experience = getActiveExperience(skills);
  const candidates = getFutureAvailableDatesForPlan(skills, experience, planId).filter(entry => {
    const date = new Date(`${entry.date}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return false;
    const day = String(date.getUTCDate());
    const monthEs = normalizeForKeywordMatch(new Intl.DateTimeFormat('es-CO', { month: 'long', timeZone: 'UTC' }).format(date));
    const monthEn = normalizeForKeywordMatch(new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(date));
    // Only dates actually offered in the last assistant turn.
    if (!new RegExp(`\\b${day}\\b`).test(assistantNorm)) return false;
    if (!assistantNorm.includes(monthEs) && !assistantNorm.includes(monthEn)) return false;
    if (selectedDay && day !== selectedDay) return false;
    const monthInMessage = MONTH_NAMES.find(m => messageNorm.includes(m));
    if (monthInMessage && monthEs !== monthInMessage && monthEn !== monthInMessage) return false;
    return true;
  });
  if (candidates.length !== 1) return null;

  const date = new Date(`${candidates[0].date}T12:00:00Z`);
  return new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
}

function buildCloseReply(
  skills: Skills,
  lang: 'es' | 'en',
  merged: MergedQualification,
  kind: CloseKind,
  facts: PublicPaymentFacts,
): string {
  const fb = skills.fallbackReplies[lang];
  const planId = typeof merged.plan === 'string' ? merged.plan : null;
  const availability = availabilityEntryForDate(skills, merged.fecha, planId);
  const template =
    kind === 'pending_owner' ? fb.reservationPendingOwner
    : availability?.status === 'limited' ? fb.reservationClosingLimited
    : fb.reservationClosing;

  let priceLine = '';
  if (typeof merged.personas === 'number') {
    const quote = calculatePriceQuote(getActiveExperience(skills), {
      planId: typeof merged.plan === 'string' ? merged.plan : undefined,
      people: merged.personas,
      transportNeed: typeof merged.transporte === 'string' ? merged.transporte as TransportNeed : undefined,
    });
    if (quote) {
      const total = quote.requiresTransportConfirmation ? quote.planTotal : (quote.total ?? quote.planTotal);
      const depositAmount = Math.round(total * facts.depositPercent / 100);
      priceLine = fb.closeDepositPriceLine
        .replace('{{total}}', formatCop(total))
        .replaceAll('{{currency}}', quote.currency)
        .replace('{{deposit}}', String(facts.depositPercent))
        .replace('{{depositAmount}}', formatCop(depositAmount));
      if (quote.requiresTransportConfirmation) {
        priceLine += fb.quoteTransportConfirm;
      }
    }
  }

  return template
    .replaceAll('{{name}}', displayName(merged.nombre, lang))
    .replaceAll('{{summary}}', qualificationSummary(merged, lang, fb))
    .replaceAll('{{date}}', displayDate(merged.fecha, lang))
    .replaceAll('{{deposit}}', String(facts.depositPercent))
    .replaceAll('{{methods}}', formatMethods(facts.methodNames, lang))
    .replace('{{priceLine}}', priceLine);
}

function buildCloseAck(skills: Skills, lang: 'es' | 'en', merged: MergedQualification): string {
  const fb = skills.fallbackReplies[lang];
  return fb.reservationPendingAck
    .replaceAll('{{name}}', displayName(merged.nombre, lang))
    .replaceAll('{{date}}', displayDate(merged.fecha, lang));
}

type CloseStage = 'none' | 'closing_offered' | 'pending_sent';

function inferCloseStage(recentMessages: RecentMessage[]): CloseStage {
  const pendingSentAnchors = [
    /estoy validando disponibilidad/i,
    /I am validating availability/i,
  ];
  for (const msg of recentMessages) {
    if (msg.role !== 'assistant') continue;
    if (pendingSentAnchors.some(r => r.test(msg.content))) return 'pending_sent';
  }
  for (const msg of recentMessages) {
    if (msg.role !== 'assistant') continue;
    // Shared with reservation-intent close-CTA detection — do not fork the list.
    if (matchesCloseCtaQuestion(msg.content)) return 'closing_offered';
  }
  return 'none';
}

function persistCollectedFromLlmTurn(repos: ProcessMessageInput['repos'], phone: string, turn: LlmTurn): void {
  const f = turn.collected_fields;
  const dbFields: Record<string, unknown> = {};
  if (f.name != null) {
    const nameStr = String(f.name).trim();
    const nameLower = nameStr.toLowerCase();
    if (nameLower !== env.OWNER_NAME.toLowerCase().trim() && nameLower !== env.PARTNER_NAME.toLowerCase().trim()) {
      dbFields.collected_name = nameStr;
    }
  }
  if (f.plan != null) dbFields.collected_plan = f.plan;
  if (f.people != null) dbFields.collected_people = f.people;
  if (f.date != null) dbFields.collected_date = f.date;
  if (f.transport_need != null) dbFields.collected_transport_need = f.transport_need;
  if (f.pet != null) dbFields.collected_pet = f.pet;
  if (Object.keys(dbFields).length > 0) repos.conversation.upsert(phone, dbFields);
  // sales_phase and lead intent are engine/analyzer-owned; plain reply output
  // must never overwrite either state field.
}

function buildMergedQualification(dbFields: Record<string, unknown>, llmTurn: LlmTurn | null): MergedQualification {
  return {
    nombre: dbFields.nombre ?? llmTurn?.collected_fields.name,
    plan: dbFields.plan ?? llmTurn?.collected_fields.plan,
    personas: dbFields.personas ?? llmTurn?.collected_fields.people,
    fecha: dbFields.fecha ?? llmTurn?.collected_fields.date,
    dateStatus: buildDbQualification(dbFields).dateStatus,
    transporte: dbFields.transporte ?? llmTurn?.collected_fields.transport_need,
    mascota: dbFields.mascota ?? llmTurn?.collected_fields.pet,
  };
}

function hasAnyQualificationData(q: MergedQualification): boolean {
  return q.nombre != null || q.plan != null || q.personas != null || q.fecha != null || q.transporte != null;
}

function activateHumanFallback(repos: ProcessMessageInput['repos'], customerPhone: string): void {
  repos.conversation.setHandedOff(customerPhone);
  const line = assignLine(repos, customerPhone);
  if (!line) return;
  repos.conversation.setMode(customerPhone, isReferralLine(line) ? 'referred' : 'bridge_active');
}

export function buildHandedOffReply(repos: ProcessMessageInput['repos'], customerPhone: string, message: string, skills: Skills = getSkills()): string {
  const fb = skills.fallbackReplies[resolveLanguage(repos, customerPhone, message)];
  const norm = message.toLowerCase().trim();
  const looksTypo = norm.length <= 15 && /^[a-záéíóúñ\s]{1,15}$/.test(norm) && !/^(?:si|no|ok|gracias|thanks|vale|listo|hola|hello|hi|buenas|bye|chao|adios|perfecto|excelente|genial|great|excellent)$/i.test(norm);
  const looksQuestion = /\?$|^(?:como|donde|cuando|cuanto|que|qu[eé]|what|how|where|when|por qu[eé]|why)\b/i.test(norm);
  const looksThanks = /\b(gracias|thank|vale|perfecto|excelente|genial|ok|listo|great|excellent|bye|chao|adios)\b/i.test(norm);
  if (looksTypo) return fb.handedOffTypo ?? fb.handedOffVariant0;
  if (looksQuestion) return fb.handedOffQuestion ?? fb.handedOffVariant0;
  if (looksThanks) return fb.handedOffThanks ?? fb.handedOffVariant1;
  const idx = Math.floor(Date.now() / 1000) % 2;
  return idx === 0 ? fb.handedOffVariant0 : fb.handedOffVariant1;
}

export async function processMessage(input: ProcessMessageInput): Promise<ProcessMessageOutput> {
  const output = await processMessageCore(input);
  return withConversationState(input.repos, input.customerPhone, output);
}

async function processMessageCore(input: ProcessMessageInput): Promise<ProcessMessageOutput> {
  const { repos, customerPhone, message, messageId, storeInbound = true, consentAcceptedThisTurn = false, consentDeclinedThisTurn = false } = input;
  let followupReopenedThisTurn = input.followupReopenedThisTurn ?? false;

  // Persist the customer's inbound message for audit/transcript. No-op when the
  // caller already stored it (storeInbound === false), so early-return guards
  // and the main flow share one code path without double-writing.
  const persistInbound = (): void => {
    if (!storeInbound) return;
    repos.message.addMessage({
      whatsapp_message_id: messageId, customer_phone: customerPhone, direction: 'inbound',
      message_type: 'text', body: message, created_at: new Date().toISOString(), raw_json: null,
    });
  };

  if (repos.isPaused() && !isOptOutMessage(message)) {
    return { reply: '', shouldSendReply: false, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  try {
  const isNewConversation = repos.message.getLastInboundAt(customerPhone) === null;
  if (isNewConversation) {
    // Lifecycle changes (removed/inactive products) must apply before the first
    // reply. DynamicDataService has a bounded fetch timeout and retains last-known
    // good data on failure.
    await refreshSkills(true);
  } else {
    await refreshSkills(false);
  }
  let skills = getSkills();
  const multipleExperiences = hasMultipleExperiences(skills);

  const lang = resolveLanguage(repos, customerPhone, message);
  const normalized = message.toLowerCase().trim();

  const storedConversation = repos.conversation.getByPhone(customerPhone);
  const storedMarker = storedConversation?.entry_marker
    ? parseEntryMarker(`${storedConversation.entry_marker} `)
    : null;
  const previousInbound = repos.message.getLastInboundBodies(customerPhone, 2)
    .map(item => item.body)
    .filter((body): body is string => typeof body === 'string');
  const entryMarker = storedMarker ?? findEntryMarker(message, previousInbound);
  if (entryMarker && !storedMarker) {
    repos.conversation.upsert(customerPhone, {
      entry_marker: entryMarker.code,
      entry_temperature: entryMarker.temperature,
      entry_marker_at: new Date().toISOString(),
    });
  }

  if (isAdcodeNoise(message)) {
    return { reply: '', shouldSendReply: false, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  // Single read reused by the opt-out, reopen and consent-answer branches below.
  // Consent is durable, so no ordinary-inbound path mutates status between this read
  // and its uses; only the opt-out branch below writes, and it re-reads nothing.
  const followupSubscription = repos.followupSubscription.getByPhone(customerPhone);
  const operatorBlocked = followupSubscription?.status === 'revoked'
    && followupSubscription.revoke_source === 'operator';

  if (isOptOutMessage(message)) {
    // Opt-out, follow-up revocation and the operator-granted template opt-in commit
    // together: a partial write would leave an active subscription (or a stale
    // operator grant) able to keep templating a customer who asked us to stop.
    // `revoke()` preserves an existing operator provenance, so a stop phrase can
    // never downgrade `/block` into a reopenable customer opt-out.
    // A repeat stop phrase must not earn a second confirmation: we already told this
    // customer we would stop, so replying again is precisely the automated messaging
    // they refused. It also covers a retraction that still contains the keyword
    // ("no era stop, era para parar y pensar"), which used to re-confirm the opt-out.
    // The writes below stay idempotent, so a repeat still repairs partial state.
    // The message that triggered a permanent compliance action IS the evidence for
    // it, so it is persisted before any state write and regardless of whether the
    // confirmation is suppressed below. Without this the row was dropped entirely:
    // live 2026-09-04 a customer stop phrase set `opt_out_at` and sent the
    // confirmation while leaving NO inbound row, so the transcript showed the bot
    // opting the lead out unprompted and nothing recorded what they had asked for.
    persistInbound();
    const alreadyOptedOut = repos.optOut.isOptedOut(customerPhone);
    repos.runInTransaction(() => {
      if (!alreadyOptedOut) repos.optOut.setOptOut(customerPhone);
      repos.followupSubscription.ensureExists(customerPhone);
      repos.followupSubscription.revoke(customerPhone, 'customer_opt_out');
      repos.followupConsent.revokeConsent(customerPhone);
      // Only the FIRST stop request appends: a repeat is the same refusal restated,
      // and the ledger must count refusals, not inbound messages.
      if (!alreadyOptedOut) {
        repos.followupConsentGrant.record({
          customer_phone: customerPhone,
          decision: 'revoke',
          decided_at: new Date().toISOString(),
          inbound_message_id: messageId ?? null,
          source: 'customer_opt_out',
          app_version: env.APP_VERSION,
        });
      }
    });
    // An operator block stays silent even here: confirming would be a reply to a
    // customer the operator muted. The state above is still recorded for compliance.
    if (operatorBlocked || alreadyOptedOut) {
      return { reply: '', shouldSendReply: false, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
    return { reply: skills.fallbackReplies[lang].optOutConfirmation, shouldSendReply: true, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  if (repos.optOut.isOptedOut(customerPhone)) {
    // Silence is the default for every opted-out customer, including operator
    // `/block` (`revoke_source='operator'`) and any state we cannot attribute.
    // The ONLY exception is a customer returning after THEIR OWN stop request:
    // they started this conversation, so answering it is not an automated message.
    const reopenable = followupSubscription?.status === 'revoked'
      && followupSubscription.revoke_source === 'customer_opt_out';
    if (!reopenable) {
      // Silent, but still recorded: an operator reading the thread must be able to
      // see that this customer wrote while muted. Dropping it left the same
      // transcript hole as the opt-out branch above.
      persistInbound();
      return { reply: '', shouldSendReply: false, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
    // Reopening clears only the ACTIVE suppression flag; `last_opt_out_at` keeps the
    // compliance record, and consent stays revoked, so no template/recurring send
    // becomes eligible. Only a fresh "sí" to a later permission ask can restore it.
    repos.runInTransaction(() => {
      repos.optOut.clearOptOut(customerPhone);
      repos.followupSubscription.reopenAfterCustomerInbound(customerPhone);
    });
    followupReopenedThisTurn = true;
    logger.info({ phone: customerPhone }, '[FOLLOWUP] new customer inbound reopened consent opportunity');
  }

  // A repeated bare "sí" seconds after consent activated is the same answer sent
  // twice, not re-engagement. We just log it and move on; the consent is durable
  // and will not be revoked by ordinary conversation turns.
  const duplicateConsentEcho = isDuplicateConsentEcho(
    repos.followupSubscription.getByPhone(customerPhone),
    message,
    env.FOLLOWUP_CONSENT_DUPLICATE_GRACE_SECONDS,
  );
  if (duplicateConsentEcho) {
    logger.info({ phone: customerPhone }, '[FOLLOWUP] duplicate consent echo — consent remains active');
  }

  const handedOffRow = repos.conversation.getHandedOffAt(customerPhone);
  if (handedOffRow) {
    return { reply: buildHandedOffReply(repos, customerPhone, message, skills), shouldSendReply: true, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendGalleryImages: false, shouldSendOwnerImage: false, shouldSendImage: false, priceJustGiven: false };
  }

  // Terminal state: a booked (converted) lead gets no bot reply. Placed after
  // opt-out handling so a post-sale "stop" still registers for compliance.
  // Live bridge and post-handoff forwarding take precedence upstream in the
  // webhook route, so this only fires for booked leads still in `bot` mode.
  if (repos.conversation.getBookedAt(customerPhone)) {
    persistInbound();
    return { reply: '', shouldSendReply: false, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  let softClosedAt = repos.conversation.getSoftClosedAt(customerPhone);

  const isFirstContact = isNewConversation;

  persistInbound();

  // A customer who keeps talking instead of answering the permission question
  // re-opens the 24h window, so the ask was premature: defer it and let it be
  // asked again after this new silence. The repository persists the
  // once-per-session cap; ambiguity on the second ask stays pending forever.
  if (
    storeInbound
    && followupSubscription?.status === 'pending'
    && !consentAcceptedThisTurn
    && !consentDeclinedThisTurn
    && classifyConsentReply(message) === 'ambiguous'
    && isConsentAskContinuation(message)
    && repos.followupSubscription.deferPendingAskAfterCustomerInbound(customerPhone)
  ) {
    logger.info({ phone: customerPhone }, '[FOLLOWUP] pending consent ask deferred once after customer continuation');
  }

  // Catalog outage/empty payload guard. Intercept before non-null registry callers.
  if (getExperiences(skills).length === 0) {
    logger.warn({ phone: customerPhone }, '[BOT] product catalog unavailable');
    return {
      reply: skills.fallbackReplies[lang].dynamicDataUnavailable,
      shouldSendReply: true,
      leadScore: repos.conversation.getLeadScore(customerPhone),
      usedAi: false,
      shouldAlertOwner: true,
      ownerAlertType: 'dynamic_pricing_unavailable',
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  // ── Multi-experience selection (deterministic) ────────────────────────
  // The bot never assumes an experience when multiple exist. First contact
  // lists them all; subsequent replies that match an experience name store
  // the selection so subsequent prompts have the right data.
  let experienceSwitched = false;
  if (multipleExperiences) {
    let selectedId = repos.conversation.getSelectedExperienceId(customerPhone);
    if (!selectedId) {
      const collectedPlan = repos.conversation.getCollectedPlan(customerPhone);
      const matchingExperiences = collectedPlan
        ? getExperiences(skills).filter(experience => getPlans(experience).some(plan => plan.id === collectedPlan))
        : [];
      if (matchingExperiences.length === 1) {
        selectedId = matchingExperiences[0].id;
        repos.conversation.setSelectedExperienceId(customerPhone, selectedId);
      }
    }
    const matchedExp = matchExperienceFromReply(message, skills, selectedId == null);
    if (matchedExp) {
      if (matchedExp.id !== selectedId) {
        experienceSwitched = selectedId != null;
        repos.conversation.setSelectedExperienceId(customerPhone, matchedExp.id);
        repos.conversation.resetExperienceSalesState(customerPhone);
        softClosedAt = null;
      }
      const normalizedMessage = normalizeForKeywordMatch(message);
      const normalizedName = normalizeForKeywordMatch(matchedExp.name);
      const isChoiceOnly = /^\s*(?:\d+|[a-z])\s*$/i.test(message) || normalizedMessage === normalizedName;
      if (isChoiceOnly) {
        return {
          reply: skills.fallbackReplies[lang].experienceSelected.replace('{{name}}', matchedExp.name),
          shouldSendReply: true, leadScore: 5, usedAi: false,
          shouldAlertOwner: false, shouldSendOwnerImage: false,
          shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false,
        };
      }
    } else if (!selectedId) {
        const list = getExperiences(skills)
          .map((exp, i) => {
            const firstSentence = exp.shortDescription.split(/\.(?:\s|$)/, 1)[0].trim();
            const tagline = firstSentence.length > 90 ? firstSentence.slice(0, 87) + '...' : firstSentence;
            return `  ${i + 1}. ${exp.name}\n     ${tagline}`;
          })
          .join('\n\n');
        return {
          reply: skills.fallbackReplies[lang].multiExperienceIntro.replace('{{experiences}}', list),
          shouldSendReply: true, leadScore: 0, usedAi: false,
          shouldAlertOwner: false, shouldSendOwnerImage: false,
          shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false,
        };
    }
  }
  const selectedExperienceId = repos.conversation.getSelectedExperienceId(customerPhone);
  if (selectedExperienceId && !getExperiences(skills).some(exp => exp.id === selectedExperienceId)) {
    repos.conversation.clearSelectedExperienceId(customerPhone);
    repos.conversation.resetExperienceSalesState(customerPhone);
    activateHumanFallback(repos, customerPhone);
    return {
      reply: skills.fallbackReplies[lang].experienceInactive,
      shouldSendReply: true,
      leadScore: repos.conversation.getLeadScore(customerPhone),
      usedAi: false,
      shouldAlertOwner: true,
      ownerAlertType: 'dynamic_pricing_unavailable',
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }
  skills = scopeSkillsToExperience(skills, selectedExperienceId);
  const activeExperience = getActiveExperience(skills);

  // Inactive experience guard: if the experience is inactive, we cannot maintain
  // context of a plan that is no longer in the source of truth. Hand off to team.
  if (activeExperience.status === 'inactive') {
    persistInbound();
    activateHumanFallback(repos, customerPhone);
    const fb = skills.fallbackReplies[lang];
    return {
      reply: fb.experienceInactive,
      shouldSendReply: true,
      leadScore: repos.conversation.getLeadScore(customerPhone),
      usedAi: false,
      shouldAlertOwner: true,
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  const storedPlan = repos.conversation.getCollectedPlan(customerPhone);
  if (storedPlan && !getPlans(activeExperience).some(plan => plan.id === storedPlan)) {
    repos.conversation.resetExperienceSalesState(customerPhone);
    activateHumanFallback(repos, customerPhone);
    return {
      reply: skills.fallbackReplies[lang].planUnavailable,
      shouldSendReply: true,
      leadScore: repos.conversation.getLeadScore(customerPhone),
      usedAi: false,
      shouldAlertOwner: true,
      ownerAlertType: 'dynamic_pricing_unavailable',
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  const futureWindow = extractFutureMonthConstraint(message);
  const deferredSafetyReply = safetyPolicyReply(skills, lang, message);
  const safetyOverrideReply = deferredSafetyReply
    ?? (futureWindow ? skills.fallbackReplies[lang].futureDateValidation.replace('{{window}}', futureWindow) : null);
  const hasSafetyOverride = safetyOverrideReply !== null;

  const pastDate = extractPastExplicitDate(message);
  if (pastDate && !hasSafetyOverride) {
    return {
      reply: skills.fallbackReplies[lang].pastDateReply.replace('{{date}}', pastDate),
      shouldSendReply: true, leadScore: repos.conversation.getLeadScore(customerPhone), usedAi: false,
      shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false,
      shouldSendImage: false, priceJustGiven: false,
    };
  }

  if (!hasSafetyOverride && detectsWrongServiceNatureOnly(message)) {
    if (!softClosedAt) repos.conversation.setSoftClosed(customerPhone);
    return {
      reply: skills.fallbackReplies[lang].wrongServiceNatureOnly,
      shouldSendReply: true,
      leadScore: repos.conversation.getLeadScore(customerPhone),
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  if (!hasSafetyOverride && detectsOrganizerContactShare(message)) {
    const organizerScore = Math.max(repos.conversation.getLeadScore(customerPhone), skills.salesStrategy.hotLeadThreshold);
    repos.conversation.upsert(customerPhone, { lead_score: organizerScore });
    return {
      reply: skills.fallbackReplies[lang].organizerContactReceived,
      shouldSendReply: true,
      leadScore: organizerScore,
      usedAi: false,
      shouldAlertOwner: true,
      ownerAlertType: 'organizer_contact',
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  const bookingFields = extractBookingFields(message, activeExperience);
  if (futureWindow) {
    delete bookingFields.collected_date;
    delete bookingFields._relative_date_token;
  }
  const contextFields = contextAwareExtract(message, repos, customerPhone, bookingFields, activeExperience);
  if (!contextFields.collected_date) {
    const selectedPlan = typeof contextFields.collected_plan === 'string'
      ? contextFields.collected_plan
      : storedPlan;
    const selectedDate = selectedDateFromAvailabilityReply(
      message,
      getLastAssistantQuestion(repos, customerPhone),
      skills,
      selectedPlan,
    );
    if (selectedDate) contextFields.collected_date = selectedDate;
  }
  if (futureWindow) {
    delete contextFields.collected_date;
    delete contextFields._relative_date_token;
  }
  const dateDeferredFlag = contextFields._date_deferred === true;
  const dateOptionsRequested = contextFields._date_options_requested === true;
  delete contextFields._date_deferred;
  delete contextFields._date_options_requested;
  delete contextFields._relative_date_token;

  // Persist non-date fields first; date transitions are atomic via repo helpers.
  const { collected_date: extractedDate, ...nonDateContext } = contextFields as Record<string, unknown> & { collected_date?: unknown };
  const revisedChildCount = typeof contextFields.collected_children === 'number'
    && storedConversation?.collected_children != null
    && storedConversation.collected_children !== contextFields.collected_children
    && contextFields.collected_child_ages_json == null;
  if (revisedChildCount) repos.conversation.clearCollectedChildAges(customerPhone);
  repos.conversation.upsert(customerPhone, {
    language: lang,
    ...nonDateContext,
  });
  if (futureWindow) {
    repos.conversation.setCollectedDateWindow(customerPhone, futureWindow);
  } else if (typeof extractedDate === 'string' && extractedDate.trim() && extractedDate !== 'tentative_unknown' && !extractedDate.startsWith('_')) {
    repos.conversation.setSelectedDate(customerPhone, extractedDate);
  } else if (dateDeferredFlag) {
    if (dateOptionsRequested) repos.conversation.setDateOptionsOffered(customerPhone);
    else repos.conversation.setDateDeferred(customerPhone);
  }
  const activeDateWindow = futureWindow ?? repos.conversation.getCollectedDateWindow(customerPhone);
  const introducedLargeGroup = typeof contextFields.collected_people === 'number'
    && contextFields.collected_people > skills.salesStrategy.maxGroupSizePerDate;

  const rawCollected = getCollectedFields(repos, customerPhone);
  const richCollected = reconstructFromHistory(repos, customerPhone, rawCollected, activeExperience);
  const missingFromDb: Record<string, unknown> = {};
  if (!rawCollected.nombre && richCollected.nombre) missingFromDb.collected_name = richCollected.nombre;
  if (!rawCollected.personas && richCollected.personas) missingFromDb.collected_people = richCollected.personas;
  if (!activeDateWindow && !rawCollected.fecha && richCollected.fecha) missingFromDb.collected_date = richCollected.fecha;
  if (!rawCollected.transporte && richCollected.transporte) missingFromDb.collected_transport_need = richCollected.transporte;
  if (!rawCollected.mascota && richCollected.mascota) missingFromDb.collected_pet = richCollected.mascota;
  if (rawCollected.adultos == null && typeof richCollected.adultos === 'number') missingFromDb.collected_adults = richCollected.adultos;
  if (rawCollected.ninos == null && typeof richCollected.ninos === 'number') missingFromDb.collected_children = richCollected.ninos;
  if (rawCollected.edadesNinos == null && Array.isArray(richCollected.edadesNinos)) {
    missingFromDb.collected_child_ages_json = JSON.stringify(richCollected.edadesNinos);
  }
  if (!rawCollected.origen && richCollected.origen) missingFromDb.collected_travel_origin = richCollected.origen;
  if (!experienceSwitched && richCollected.plan && richCollected.plan !== rawCollected.plan) missingFromDb.collected_plan = richCollected.plan;
  if (Object.keys(missingFromDb).length > 0) repos.conversation.upsert(customerPhone, missingFromDb);

  const collectedFields = reconstructFromHistory(repos, customerPhone, getCollectedFields(repos, customerPhone), activeExperience);
  if (experienceSwitched && typeof contextFields.collected_plan !== 'string') delete collectedFields.plan;
  if (activeDateWindow) delete collectedFields.fecha;
  const dateSelectedThisTurn = typeof extractedDate === 'string'
    && extractedDate.trim() !== ''
    && availabilityEntryForDate(
      skills,
      extractedDate,
      typeof collectedFields.plan === 'string' ? collectedFields.plan : storedPlan,
    ) !== null;
  const dbQualification = buildDbQualification(collectedFields);
  const recentMessages = repos.message.getRecentMessages(customerPhone, 21).filter((_, i, arr) => i < arr.length - 1);
  // Find the last user turn with content (skip photo-only turns).
  const previousCustomerIndex = recentMessages.findLastIndex(item => item.role === 'user' && item.content.trim().length > 0);
  const messagesAfterPreviousCustomer = previousCustomerIndex >= 0
    ? recentMessages.slice(previousCustomerIndex + 1)
    : [];
  const previousCustomerMessage = messagesAfterPreviousCustomer.length > 0
    && messagesAfterPreviousCustomer.at(-1)?.messageType === 'text'
    && messagesAfterPreviousCustomer.slice(0, -1).every(item => item.role === 'assistant' && item.messageType === 'image')
    ? recentMessages[previousCustomerIndex]?.content ?? null
    : null;
  const galleryContinuationRequest = isGalleryContinuationRequest(message)
    && previousCustomerMessage != null
    && isGalleryRequest(previousCustomerMessage);

  const regexScore = scoreMessage(normalized, skills);

  // ── Pain detection (proactive, not just during follow-up) ─────────────────
  // Persist only explicit blockers. Generic requests for price, dates, transport,
  // or a couple plan are normal intent signals, not customer pain.
  const existingPain = repos.conversation.getLeadPain(customerPhone);
  const detectedPain = detectProactiveLeadPain(message);
  if (detectedPain && detectedPain !== existingPain) {
    repos.conversation.setLeadPain(customerPhone, detectedPain, message.slice(0, 200));
  }
  // ──────────────────────────────────────────────────────────────────────────
  const currentScore = repos.conversation.getLeadScore(customerPhone);
  const customerContext = extractCustomerContext(message);
  const fallbackOutput = (reply: string, extra?: Partial<ProcessMessageOutput>): ProcessMessageOutput => {
    const finalReply = ensureAdvanceQuestion(reply, skills.fallbackReplies[lang], dbQualification);
    const outboundDateAction = extra?.outboundDateAction ?? detectOutboundDateAction(finalReply, dbQualification);
    return {
      reply: finalReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
      ...extra,
      outboundDateAction,
    };
  };
  if (!hasSafetyOverride && /\b(?:precio|valor|cuesta).{0,50}\bdepende.{0,50}\bfecha|\bdepende.{0,50}\bfecha/i.test(message)) {
    return fallbackOutput(skills.fallbackReplies[lang].priceDependsOnGroup);
  }
  if (!hasSafetyOverride && customerContext.childAges?.[0] != null) {
    return fallbackOutput(skills.fallbackReplies[lang].childSuitabilityBoundary.replace('{{age}}', String(customerContext.childAges[0])));
  }

  if (!hasSafetyOverride && isSoftCloseMessage(message)) {
    // Price objections with qualification data are recoverable: let the LLM
    // handle them instead of hard-closing with the IG soft-close.
    const hasQualData = dbQualification.personas != null || dbQualification.fecha != null || dbQualification.nombre != null;
    const isPriceObj = /por ese precio no|por ese valor no|muy caro|tan caro|por qu[eé]\s+(?:tan\s+)?caro|porque\s+(?:tan\s+)?caro|esta caro|algo caro|me parece caro|carisimo|se sale del presupuesto|fuera de presupuesto|no me alcanza|consultarlo|lo consulto|lo hablo|lo pienso|consultar/i.test(normalized);
    if (hasQualData && isPriceObj && !softClosedAt) {
      // Don't soft-close — let the objection fall through to the LLM for handling.
    } else {
      if (!softClosedAt) repos.conversation.upsert(customerPhone, { soft_closed_at: new Date().toISOString() });
      const declineScoreAlert = currentScore >= skills.salesStrategy.hotLeadThreshold;
      return { reply: skills.fallbackReplies[lang].softCloseReply.replace('{{instagramUrl}}', instagramUrl(skills)), shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: declineScoreAlert, ownerAlertType: declineScoreAlert ? 'decline_review' : undefined, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
  }

  // A bare yes/no answering the follow-up permission question carries NO buying
  // information. The ask ends in a question ("¿te parece si te escribo más
  // adelante?") that the soft reservation-question patterns match on "te parece",
  // so a bare "Ok" used to be read as a close-CTA confirmation and paged the owner
  // at the urgent threshold. Anything with real sales content classifies as
  // `ambiguous` and keeps the normal sales path.
  const consentAnswerTurn = consentAcceptedThisTurn
    || consentDeclinedThisTurn
    || (followupSubscription?.status === 'pending'
      && classifyConsentReply(message) !== 'ambiguous');

  // The permission ask is not a sales question: on a permission-answer turn it must
  // not seed reservation/gallery/date inference from the previous assistant turn.
  const lastAssistantQuestion = consentAnswerTurn ? null : getLastAssistantQuestion(repos, customerPhone);
  const conversationMode = repos.conversation.getMode(customerPhone);

  // Soft-close reopen: explicit gallery requests bypass the soft-close timeout.
  const galleryRequestedForReopen = isGalleryRequest(message)
    || galleryContinuationRequest
    || isGalleryConfirmation(message, lastAssistantQuestion);

  const largeGroupPeople = typeof dbQualification.personas === 'number' ? dbQualification.personas : null;
  const largeGroupNeedsEscalate = largeGroupPeople != null
    && largeGroupPeople > skills.salesStrategy.maxGroupSizePerDate
    && !isReviewPause(message)
    && (introducedLargeGroup || isPriceQuestion(message) || detectsAvailabilityConfirmRequest(message));
  if (!hasSafetyOverride && largeGroupNeedsEscalate) {
    enterHumanPending(repos, customerPhone);
    const escalateScore = Math.max(currentScore, skills.salesStrategy.urgentLeadThreshold);
    repos.conversation.upsert(customerPhone, { lead_score: escalateScore });
    return {
      reply: skills.fallbackReplies[lang].largeGroupEscalate.replace('{{people}}', String(largeGroupPeople)),
      shouldSendReply: true,
      leadScore: escalateScore,
      usedAi: false,
      shouldAlertOwner: true,
      ownerAlertType: 'large_group',
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  if (!hasSafetyOverride && conversationMode === 'human_pending' && isPaymentMethodsQuestion(message)) {
    const facts = getPublicPaymentFacts(skills);
    const reply = skills.fallbackReplies[lang].humanPendingPaymentAck
      .replaceAll('{{methods}}', formatMethods(facts.methodNames, lang))
      .replaceAll('{{deposit}}', String(facts.depositPercent))
      .replaceAll('{{date}}', displayDate(dbQualification.fecha, lang));
    return {
      reply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: true,
      ownerAlertType: 'reservation_handoff',
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  let isReEngagement = false;
  if (softClosedAt) {
    if (hasSafetyOverride || isReEngagementMessage(message, entryMarker?.temperature) || galleryRequestedForReopen) {
      isReEngagement = true;
      repos.conversation.clearSoftClosed(customerPhone);
    } else {
      return { reply: '', shouldSendReply: false, leadScore: currentScore, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
  }

  // Explicit customer request for photos bypasses the once-per-customer dedup:
  // if they ask again, we honor it. Only automatic nudges are deduped.
  // Skills v2: let LLM answer photo requests; no forced galleryIntro dump.

  const preLimitPriceRow = repos.conversation.getPriceGivenAt(customerPhone);
  const preLimitHandoffAllowed = isQualificationComplete(dbQualification) && !!preLimitPriceRow
    && isReservationIntentOrConfirmation(message, lastAssistantQuestion);

  const preLimitReservationIntent = !!preLimitPriceRow && isReservationIntentOrConfirmation(message, lastAssistantQuestion);

  const limits = checkTimeWindow(repos, customerPhone);
  if (limits.isLimited) {
    logger.warn({ phone: customerPhone, reason: limits.reason }, '[BOT] message limit reached');
    if (safetyOverrideReply) {
      return { reply: safetyOverrideReply, shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: true, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
    // Alert-only under limit: never auto-mute. Only /chat silences the bot.
    if (preLimitHandoffAllowed || preLimitReservationIntent) {
      const overrideScore = Math.max(currentScore, skills.salesStrategy.urgentLeadThreshold);
      repos.conversation.upsert(customerPhone, { lead_score: overrideScore });
      const preLimitCloseStage = inferCloseStage(recentMessages);
      let closing: string;
      if (preLimitHandoffAllowed) {
        if (preLimitCloseStage === 'pending_sent') {
          closing = buildCloseAck(skills, lang, dbQualification);
        } else {
          const kind: CloseKind = preLimitCloseStage === 'closing_offered' ? 'pending_owner' : 'closing';
          closing = buildCloseReply(skills, lang, dbQualification, kind, getPublicPaymentFacts(skills));
        }
      } else {
        closing = skills.fallbackReplies[lang].aiFailureQualified;
      }
      return { reply: closing, shouldSendReply: true, leadScore: overrideScore, usedAi: false, shouldAlertOwner: true, ownerAlertType: 'reservation_handoff', shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
    if (currentScore >= skills.salesStrategy.hotLeadThreshold || (!!preLimitPriceRow && currentScore >= 20)) {
      return { reply: skills.fallbackReplies[lang].messageLimitHandoff, shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: true, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
    const fb = skills.fallbackReplies[lang];
    const recentLimitReplies = countRecentStartsWith(recentMessages, [fb.messageLimitReached, fb.messageLimitHandoff], 12);
    if (recentLimitReplies >= 2) {
      // Already sent two limit-guard replies to this customer in this window.
      // Sending more would only increase the outbound count and perpetuate the
      // loop. Stop replying and alert owner so a human can take over.
      return { reply: '', shouldSendReply: false, leadScore: currentScore, usedAi: false, shouldAlertOwner: true, ownerAlertType: 'limit_loop', shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
    return { reply: fb.messageLimitReached, shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: true, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  const budget = checkBudget(repos, customerPhone);
  if (!budget.aiAllowed) {
    logger.warn({ reason: budget.reason }, '[AI] budget blocked');
    void reportAiBudgetBlocked(budget.reason ?? 'unknown');
    if (safetyOverrideReply) {
      return { reply: safetyOverrideReply, shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: true, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
    const fallbackScore = preLimitReservationIntent
      ? Math.max(currentScore, skills.salesStrategy.urgentLeadThreshold)
      : currentScore;
    if (preLimitReservationIntent) {
      repos.conversation.upsert(customerPhone, { lead_score: fallbackScore });
      repos.conversation.setLeadIntent(customerPhone, 'ready_to_book');
    }
    activateHumanFallback(repos, customerPhone);
    return {
      reply: skills.fallbackReplies[lang].aiBudgetExhausted,
      shouldSendReply: true,
      leadScore: fallbackScore,
      usedAi: false,
      shouldAlertOwner: true,
      ownerAlertType: preLimitReservationIntent ? 'reservation_handoff' : undefined,
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  if (!isDynamicDataFresh() && isPriceDateOrReservationMessage(message)) {
    logger.warn({ phone: customerPhone }, '[BOT] dynamic data unavailable — blocking price/date reply');
    return {
      reply: skills.fallbackReplies[lang].dynamicDataUnavailable,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: true,
      ownerAlertType: 'dynamic_pricing_unavailable',
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  const salesPhase = repos.conversation.getSalesPhase(customerPhone);
  const safeCollected = sanitizeCollectedFields(collectedFields, skills.fallbackReplies[lang].internalDatePending);
  if (activeDateWindow) safeCollected.datePreference = activeDateWindow;
  const priorContext = entryMarker?.temperature === 'retargeting'
    ? isNewConversation || !hasQualifiedRetargetingContext(storedConversation)
      ? 'sin historial local; no inventes familiaridad ni conversaciones anteriores'
      : storedConversation
        ? formatEntryPriorContext(storedConversation)
        : 'sin historial local; no inventes familiaridad ni conversaciones anteriores'
    : null;
  const knownPain = repos.conversation.getLeadPain(customerPhone);
  const explicitCloseCtaConfirmation = isExplicitCloseCtaConfirmation(message, lastAssistantQuestion);
  const closeCtaAcceptedThisTurn = repos.conversation.getPriceGivenAt(customerPhone) != null
    && isConfirmedDate(collectedFields.fecha)
    && explicitCloseCtaConfirmation;
  // Only our own replies: an emoji the CUSTOMER used is not a glyph we spent, and
  // banning it would shrink the palette for no reason. Reuses `recentMessages`, so
  // no extra query.
  const usedEmojis = [...new Set(
    recentMessages
      .filter(m => m.role === 'assistant')
      .flatMap(m => extractEmojis(m.content)),
  )];
  const resolvedExperienceId = selectedExperienceId ?? activeExperience.id;
  const galleryPreferredSiteId = typeof safeCollected.plan === 'string'
    ? getPlans(activeExperience).find(plan => plan.id === safeCollected.plan)?.siteId
    : undefined;
  const directGalleryRequestThemes = isGalleryRequest(message)
    ? detectRequestedGalleryThemes(skills, message, resolvedExperienceId, galleryPreferredSiteId)
    : [];
  const galleryRequestThemes = directGalleryRequestThemes.length > 0
    ? directGalleryRequestThemes
    : galleryContinuationRequest && previousCustomerMessage
      ? detectRequestedGalleryThemes(skills, previousCustomerMessage, resolvedExperienceId, galleryPreferredSiteId)
      : [];
  const galleryImagesRemaining = remainingGalleryImageBudget(repos, customerPhone);
  const promptInput = {
    skills,
    lang,
    collectedFields: safeCollected,
    salesPhase: salesPhase ?? undefined,
    customerContext: extractCustomerContext(message),
    selectedExperienceId: resolvedExperienceId,
    entryMarker,
    priorContext,
    leadPain: knownPain,
    priceGiven: repos.conversation.getPriceGivenAt(customerPhone) != null,
    latestCustomerMessage: message,
    dateSelectedThisTurn,
    closeCtaAcceptedThisTurn,
    consentAcceptedThisTurn,
    followupReopenedThisTurn,
    usedEmojis,
    galleryShown: hasShownLlmGallery(repos, customerPhone),
    galleryRequestThemes,
    galleryImagesRemaining,
  };
  const systemPrompt = buildSystemPrompt(promptInput);
  const llmHistory = recentMessages.map(m => ({ role: m.role, content: m.content }));

  let replyUsageRecorded = false;
  const llmResult = await llmClient.complete({
    systemPrompt,
    message,
    history: llmHistory,
    lang,
    onAttempt: attempt => {
      replyUsageRecorded = true;
      const cost = estimateDeepSeekCost(attempt.tokens.prompt, attempt.tokens.completion);
      repos.aiUsage.recordUsage({ phone: customerPhone, model: env.DEEPSEEK_MODEL, promptTokens: attempt.tokens.prompt, completionTokens: attempt.tokens.completion, cachedTokens: 0, estimatedCost: cost, purpose: 'reply', success: attempt.success, errorType: attempt.success ? null : 'completion_failed' });
    },
  });

  if (!llmResult) {
    logger.warn('[LLM] DeepSeek call failed, sending minimal fallback');
    const fieldCount = [collectedFields?.nombre, collectedFields?.personas, collectedFields?.fecha].filter(v => v != null).length;
    const isNearClosing = fieldCount >= 3;
    const fallbackText: string = safetyOverrideReply
      ?? (isNearClosing
        ? skills.fallbackReplies[lang].aiFailureQualified
        : (collectedFields?.nombre
          ? (skills.fallbackReplies[lang].llmFailureWarm?.replace('{{name}}', String(collectedFields.nombre)) ?? skills.fallbackReplies[lang].aiFailureQualified)
          : skills.fallbackReplies[lang].aiFailureQualified));
    const failureReservationIntent = !!preLimitPriceRow
      && isReservationIntentOrConfirmation(message, lastAssistantQuestion);
    const failureScore = failureReservationIntent
      ? Math.max(currentScore, skills.salesStrategy.urgentLeadThreshold)
      : currentScore;
    if (failureReservationIntent) {
      repos.conversation.upsert(customerPhone, { lead_score: failureScore });
      repos.conversation.setLeadIntent(customerPhone, 'ready_to_book');
      enterHumanPending(repos, customerPhone);
    }
    return {
      reply: fallbackText, shouldSendReply: true,
      leadScore: failureScore, usedAi: true,
      shouldAlertOwner: failureReservationIntent || hasAnyQualificationData(dbQualification),
      ownerAlertType: failureReservationIntent ? 'reservation_handoff' : undefined,
      shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false,
    };
  }

  let llmTurn = llmResult.turn;
  const initialParsedMedia = parseMediaMarker(llmTurn.reply);
  const initialVisibleReply = initialParsedMedia?.text ?? llmTurn.reply.trim();
  const advanceQuestionRequired = !consentAnswerTurn
    && !closeCtaAcceptedThisTurn
    && !isReviewPause(message)
    && !isSoftCloseMessage(message)
    && !isExplicitCustomerFarewell(message)
    && !containsHandoffPhrase(llmTurn.reply);
  const advanceQuestionCorrectionNeeded = advanceQuestionRequired
    && !initialVisibleReply.trimEnd().endsWith('?');
  const galleryCorrectionNeeded = env.MEDIA_MARKER_RETRY_ENABLED
    && (isGalleryRequest(message) || galleryContinuationRequest)
    && !isFirstContact
    && galleryRequestThemes.length > 0
    && galleryImagesRemaining > 0
    && !containsMediaMarkerSyntax(llmTurn.reply);
  if (
    (advanceQuestionCorrectionNeeded || galleryCorrectionNeeded)
    && checkBudget(repos, customerPhone).aiAllowed
  ) {
    logger.warn({
      phone: customerPhone,
      missingQuestion: advanceQuestionCorrectionNeeded,
      missingMediaMarker: galleryCorrectionNeeded,
      themes: galleryCorrectionNeeded ? galleryRequestThemes : undefined,
    }, '[LLM] retrying incomplete active reply');
    const retryResult = await llmClient.complete({
      systemPrompt: buildSystemPrompt({
        ...promptInput,
        galleryRetryInstruction: galleryCorrectionNeeded,
        advanceQuestionRetryInstruction: advanceQuestionCorrectionNeeded,
      }),
      message,
      history: llmHistory,
      lang,
      onAttempt: attempt => {
        const cost = estimateDeepSeekCost(attempt.tokens.prompt, attempt.tokens.completion);
        repos.aiUsage.recordUsage({ phone: customerPhone, model: env.DEEPSEEK_MODEL, promptTokens: attempt.tokens.prompt, completionTokens: attempt.tokens.completion, cachedTokens: 0, estimatedCost: cost, purpose: 'reply', success: attempt.success, errorType: attempt.success ? null : 'completion_failed' });
      },
    });
    if (retryResult) llmTurn = retryResult.turn;
  }
  if (!replyUsageRecorded) {
    const estimatedCost = estimateDeepSeekCost(llmResult.tokens.prompt, llmResult.tokens.completion);
    repos.aiUsage.recordUsage({ phone: customerPhone, model: env.DEEPSEEK_MODEL, promptTokens: llmResult.tokens.prompt, completionTokens: llmResult.tokens.completion, cachedTokens: 0, estimatedCost, purpose: 'reply', success: true });
  }
  if (activeDateWindow) llmTurn.collected_fields.date = null;
  persistCollectedFromLlmTurn(repos, customerPhone, llmTurn);
  const authoritativeBookingFields = { ...bookingFields };
  if (authoritativeBookingFields._relative_date_token) {
    delete authoritativeBookingFields.collected_date;
    delete authoritativeBookingFields._relative_date_token;
  }
  if (Object.keys(authoritativeBookingFields).length > 0) {
    repos.conversation.upsert(customerPhone, authoritativeBookingFields);
  }
  if (activeDateWindow) repos.conversation.clearCollectedDate(customerPhone);

  const updatedCollected = reconstructFromHistory(repos, customerPhone, getCollectedFields(repos, customerPhone), activeExperience);
  if (activeDateWindow) delete updatedCollected.fecha;
  let merged = buildMergedQualification(updatedCollected, llmTurn);
  // ── LLM-powered lead analysis (separate scoring call) ───────────────────
  // Gated behind the budget guard: the analyzer is a second DeepSeek call, so
  // it must respect daily/monthly USD budgets and per-customer/global call caps.
  // The reply call already recorded its usage row, so re-checking here reflects
  // the just-consumed budget. When budget is tight we skip analysis (score
  // unchanged) rather than overspend.
  const prePriceRow = repos.conversation.getPriceGivenAt(customerPhone);
  const analysis = await runLeadAnalysis(repos, {
    customerPhone,
    latestMessage: message,
    history: recentMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    currentScore,
    salesPhase,
    collectedFields: safeCollected as Record<string, unknown>,
    priceGiven: !!prePriceRow,
    isFollowUpReply: false,
    isPainQuestionReply: false,
    lastAssistantQuestion,
    lang,
  });

  let llmLeadInput: LlmLeadInput;
  if (analysis) {
    llmLeadInput = {
      intent: analysis.intent,
      scoreDelta: analysis.scoreDelta,
      confidence: analysis.confidence,
      buyingSignals: analysis.buyingSignals,
      blockers: analysis.blockers,
    };
  } else {
    logger.warn({ phone: customerPhone }, '[LEAD_ANALYZER] unavailable — using conservative deterministic fallback');
    llmLeadInput = {
      intent: 'curious',
      scoreDelta: 0,
      confidence: 0,
      buyingSignals: [],
      blockers: [],
    };
  }
  const computedHybrid = analysis
    ? computeHybridScore(currentScore, llmLeadInput, regexScore.score, isReEngagement, skills.salesStrategy.hotLeadThreshold)
    : {
        score: computeAnalyzerFallbackScore(
          currentScore,
          regexScore.score,
          isReEngagement,
          skills.salesStrategy.hotLeadThreshold,
        ),
        intent: storedConversation?.lead_intent ?? 'curious',
        isHot: false,
      };
  const scoredHybrid = conversationMode === 'human_pending'
    ? { ...computedHybrid, score: Math.max(currentScore, computedHybrid.score) }
    : computedHybrid;
  // Answering the permission question is not buying behaviour: freeze the score in
  // both directions. Saying "Ok" to a future message is not interest, and saying
  // "No" to it is not a sales objection either. Real interest still scores normally
  // on the next turn (e.g. when they reply to a template asking about dates).
  const hybrid = consentAnswerTurn
    ? { ...scoredHybrid, score: currentScore, isHot: false }
    : scoredHybrid;
  repos.conversation.upsert(customerPhone, { lead_score: hybrid.score });
  if (analysis && !consentAnswerTurn && !(conversationMode === 'human_pending' && storedConversation?.lead_intent === 'ready_to_book')) {
    repos.conversation.setLeadIntent(customerPhone, analysis.intent);
  }

  // ── Determine whether this lead should bridge / alert owner ──────────────
  // Primary gate: analyzer confirms real booking readiness at/above threshold.
  const analyzerReadyToBook = analysis?.intent === 'ready_to_book' && analysis.reservationReadiness === 'strong';
  const analyzerWarmAfterPrice = analysis?.afterPriceInterest === true && analysis.reservationReadiness === 'medium';
  const shouldBridgeByScore = hybrid.score >= env.BRIDGE_SCORE_THRESHOLD && (analyzerReadyToBook || analyzerWarmAfterPrice);
  // Safety fallback: when the analyzer is unavailable (HTTP/timeout/invalid JSON
  // or budget-skipped) we must not silently drop a booking-ready lead. If the
  // deterministic signals are unambiguous — full qualification, price already
  // shown, and explicit reservation intent — bridge as before.
  const analyzerUnavailable = analysis === null;
  // ─────────────────────────────────────────────────────────────────────────

  const rawReplyText = llmTurn.reply || '';
  const finalVisibleReply = parseMediaMarker(rawReplyText)?.text ?? rawReplyText.trim();
  const persistentMissingQuestion = advanceQuestionRequired
    && !finalVisibleReply.trimEnd().endsWith('?');
  const persistentMissingExplicitMarker = galleryCorrectionNeeded
    && !containsMediaMarkerSyntax(rawReplyText);
  if (persistentMissingQuestion) {
    logger.warn({ phone: customerPhone, replyLen: finalVisibleReply.length }, '[REPLY_QUESTION] active reply still missing final question after correction');
  }
  if (persistentMissingExplicitMarker) {
    logger.warn({ phone: customerPhone, themes: galleryRequestThemes }, '[MEDIA_REQUEST] explicit photo request still missing marker after correction');
  }
  const persistentUnmarkedPhotoPromise = galleryRequestThemes.length > 0
    && hasUnmarkedPhotoPromise(rawReplyText);
  // Holdable date only (day-level). Month-only must not unlock deposit CTAs.
  const holdableBeforeSafety = typeof merged.fecha === 'string' && isConfirmedDate(merged.fecha);
  const paymentSafeReply = holdableBeforeSafety
    ? rawReplyText
    : stripPaymentMoveWithoutDate(rawReplyText);
  const movesToPayment = MOVES_TO_PAYMENT.test(paymentSafeReply);
  const mentionsPrice = replyMentionsPrice(paymentSafeReply);
  // Strip-only guard on price/payment/close turns. Does not rewrite sales copy.
  const replyText = stripEmojisOnPaymentClose(paymentSafeReply, { movesToPayment, mentionsPrice });

  const quoteQualification = { ...merged };

  // ── Plan inference from customer message ────────────────────────────────
  if (merged.plan == null) {
    const userPlan = detectPlan(message, activeExperience);
    if (userPlan) {
      repos.conversation.upsert(customerPhone, { collected_plan: userPlan });
      merged = { ...merged, plan: userPlan };
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  if (!replyText.trim()) {
    const fallbackText = collectedFields?.nombre
      ? (skills.fallbackReplies[lang].llmFailureWarm?.replace('{{name}}', String(collectedFields.nombre)) ?? skills.fallbackReplies[lang].aiFailureQualified)
      : skills.fallbackReplies[lang].aiFailureQualified;
    return {
      reply: fallbackText, shouldSendReply: true,
      leadScore: hybrid.score, usedAi: true, shouldAlertOwner: hasAnyQualificationData(dbQualification),
      shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false,
    };
  }

  // ── Media marker extraction (LLM-driven photo sends) ──────────────────────
  // Parse `[[FOTOS:theme]]`, resolve to gallery category ids, build the photo list.
  //
  // Ops state (images switched off, bridge takeover) cancels only the PHOTOS: the
  // marker is stripped and the model's text still goes out verbatim. Treating it
  // as a model failure would mean flipping SEND_IMAGES_ENABLED silently converts
  // every photo-request turn into a failure fallback plus an owner alert.
  // Only a marker the engine cannot honour at all — nothing left to say, or
  // themes that resolve to no photos — counts as a model error, because the copy
  // was written on the promise of images that will not arrive.
  const mediaMarkerParsed = parseMediaMarker(replyText);
  const strippedReplyText = mediaMarkerParsed?.text ?? replyText;
  const mediaSendsAllowed = conversationMode !== 'bridge_active'
    && env.SEND_IMAGES_ENABLED
    && galleryImagesRemaining > 0;
  const mediaMarkerBlockedByOps = conversationMode === 'bridge_active'
    || !env.SEND_IMAGES_ENABLED
    || galleryImagesRemaining <= 0;
  const selectedPlanSiteId = typeof merged.plan === 'string'
    ? activeExperience.plans.find(plan => plan.id === merged.plan)?.siteId
    : undefined;
  let requestedGalleryImageUrls: string[] = [];
  let mediaMarkerUnresolved = false;

  if (mediaMarkerParsed) {
    if (!mediaMarkerParsed.atEnd) {
      logger.warn(
        { phone: customerPhone, themes: mediaMarkerParsed.requestedThemes },
        '[MEDIA] marker was not at the end of the reply — stripped in place',
      );
    }
    if (!mediaSendsAllowed) {
      logger.info(
        { phone: customerPhone, mode: conversationMode, imagesEnabled: env.SEND_IMAGES_ENABLED },
        '[MEDIA] marker stripped — photo sends unavailable this turn, text sent unchanged',
      );
    } else {
      const resolvedThemes = resolveMediaThemes(
        skills,
        mediaMarkerParsed.requestedThemes,
        activeExperience.id,
        selectedPlanSiteId,
      );
      const selectedImages = resolvedThemes.length > 0
        ? selectBalancedByCategory(
          repos,
          customerPhone,
          getGalleryImages(skills, activeExperience.id),
          resolvedThemes,
          Math.min(galleryImageLimit(), galleryImagesRemaining),
        )
        : [];
      requestedGalleryImageUrls = selectedImages.map((image) => image.url);
      mediaMarkerUnresolved = requestedGalleryImageUrls.length === 0;
      if (requestedGalleryImageUrls.length > 0) {
        logger.info(
          { phone: customerPhone, themes: resolvedThemes.map(theme => theme.type), count: requestedGalleryImageUrls.length },
          '[MEDIA] LLM requested photos — delivering from gallery',
        );
      }
    }
  }

  // ── Hard safety gate ─────────────────────────────────────────────────────
  // Model text is never rewritten. Outcomes:
  //   * price_without_pricing → curated priceUnavailable (CDN-outage path too)
  //   * prompt_leak / payment_detail_leak → suppress (empty); substitute risks echo
  //   * false_reservation / template / sentinel → non-echoing aiFailureQualified
  const exp = getActiveExperience(skills);
  logQuoteMismatch(strippedReplyText, exp, quoteQualification, customerPhone, getPublicPaymentFacts(skills).depositPercent);
  logEmojiStyle(rawReplyText, {
    phone: customerPhone,
    salesPhase: salesPhase ?? undefined,
    mentionsPrice: replyMentionsPrice(rawReplyText),
    movesToPayment,
  });
  logReplyStyle(strippedReplyText, {
    phone: customerPhone,
    salesPhase: salesPhase ?? undefined,
  });
  // isConfirmedDate rejects the sentinels ('tentative_unknown', '_'-prefixed),
  // so a deferred or month-only lead correctly counts as having no holdable date.
  const hasHoldableDate = typeof merged.fecha === 'string' && isConfirmedDate(merged.fecha);
  // `hardSafetyFail` runs FIRST and wins. A marker problem must never outrank a
  // leak: `prompt_leak` / `payment_detail_leak` are echo-risk reasons that have to
  // suppress the turn entirely, and short-circuiting on the marker would downgrade
  // them to a curated fallback send.
  const unhonourableMediaMarker = mediaMarkerParsed != null
    && (!strippedReplyText || (mediaMarkerUnresolved && !mediaMarkerBlockedByOps));
  const safetyFailReason = hardSafetyFail(strippedReplyText, isPricingAvailable(exp), hasHoldableDate)
    ?? (unhonourableMediaMarker ? 'media_marker_unhonoured' : null);
  if (safetyFailReason === 'price_without_pricing') {
    logger.warn({ phone: customerPhone }, '[BOT] LLM priced while pricing unavailable — curated fallback sent');
    const fallbackText = typeof merged.personas === 'number'
      ? skills.fallbackReplies[lang].priceUnavailableKnownGroup
        .replace('{{people}}', String(merged.personas))
        .replace('{{dateClause}}', merged.fecha ? ` para ${displayDate(merged.fecha, lang)}` : '')
      : skills.fallbackReplies[lang].priceUnavailable;
    return {
      reply: fallbackText, shouldSendReply: true,
      leadScore: hybrid.score, usedAi: true, shouldAlertOwner: true,
      ownerAlertType: 'dynamic_pricing_unavailable',
      shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false,
    };
  }
  if (safetyFailReason) {
    const echoRisk = isEchoRiskSafetyFail(safetyFailReason);
    logger.warn({ phone: customerPhone, reason: safetyFailReason, echoRisk }, '[BOT] hard safety block');
    const ownerAlertType = safetyFailReason === 'payment_detail_leak'
      || safetyFailReason === 'false_reservation_claim'
      || safetyFailReason === 'payment_without_date'
      ? 'unsafe_reservation_blocked'
      : 'policy_violation_blocked';
    if (echoRisk) {
      return {
        reply: '', shouldSendReply: false,
        leadScore: hybrid.score, usedAi: true, shouldAlertOwner: true, ownerAlertType,
        shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false,
      };
    }
    return {
      reply: skills.fallbackReplies[lang].aiFailureQualified, shouldSendReply: true,
      leadScore: hybrid.score, usedAi: true, shouldAlertOwner: true, ownerAlertType,
      shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false,
    };
  }
  // Soft unsafe-reservation phrasing (e.g. "te confirmo disponibilidad") is a known
  // false-positive of the broad predicate: keep text, suppress AUTOMATIC media, log
  // only. Explicitly requested photos still ship — see the media block below.
  const softUnsafePhrasing = containsUnsafeReservationClaim(strippedReplyText);
  if (softUnsafePhrasing) {
    logger.info({ phone: customerPhone }, '[BOT] soft unsafe-reservation phrasing kept — automatic media suppressed');
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Ops state only — never mutates reply text ────────────────────────────
  // Mark price_given / pricePresented only when at least one booking signal exists
  // (plan/date/transport/people), so a first-turn price mention cannot unlock
  // handoff/hot-lead paths on its own.
  const initialPriceMentioned = replyMentionsPrice(strippedReplyText);
  const msgPriceFields = extractBookingFields(message, exp);
  const priceContextSignals = [
    merged.plan, merged.fecha, merged.transporte, merged.personas,
    msgPriceFields.collected_people, msgPriceFields.collected_date, msgPriceFields.collected_transport_need,
  ].filter(v => v != null).length;
  const legalPrice = priceContextSignals >= 1 || isConfirmedDate(merged.fecha) || merged.transporte != null;
  const initialPriceJustGiven = initialPriceMentioned && legalPrice;
  const pricePresented = !!(initialPriceJustGiven || prePriceRow);

  if (initialPriceMentioned && !prePriceRow) {
    if (legalPrice) {
      repos.conversation.upsert(customerPhone, { price_given_at: new Date().toISOString() });
    } else {
      logger.info({ phone: customerPhone, fieldCount: priceContextSignals }, '[BOT] price mentioned — price_given deferred (insufficient qualification)');
    }
  }

  // ── Phase progression (inferred, not LLM-dependent) ──────────────────────
  // The LLM runs in plain-text mode so the structured sales_phase field always
  // defaults to "discovery". Infer the real phase from conversation state so
  // the next turn's prompt context includes the correct phase.
  const inferredPhase = inferSalesPhase(merged, pricePresented, strippedReplyText, message, currentScore, isFirstContact);
  if (inferredPhase && inferredPhase !== salesPhase) {
    repos.conversation.setSalesPhase(customerPhone, inferredPhase);
  }
  // ──────────────────────────────────────────────────────────────────────────

  let needsHumanEffective = false;
  let finalScore = hybrid.score;

  const qComplete = isQualificationComplete(merged);
  const reservationIntent = !consentAnswerTurn && isReservationIntentOrConfirmation(message, lastAssistantQuestion);
  const recentReservation = recentMessages
    .filter(m => m.role === 'user')
    .slice(-6)
    .some(m => detectsReservationIntent(m.content));
  // Trust the LLM's structured booking signal instead of growing regex coverage.
  // The model already classifies booking readiness; this catches phrasings the
  // deterministic patterns miss (e.g. confirming the bot's own soft-close question).
  const llmReadyToBook = llmTurn.action === 'handoff' || llmTurn.lead.intent === 'ready_to_book';

  const paymentQ = isPaymentMethodsQuestion(message);
  const rawAvailabilityConfirm = detectsAvailabilityConfirmRequest(message);
  const currentCloseBlocker = consentAnswerTurn
    || isReservationIntentNegated(message)
    || isReviewPause(message)
    || isSoftCloseMessage(message)
    || analysis?.intent === 'not_interested';
  const availabilityConfirm = !currentCloseBlocker && rawAvailabilityConfirm;
  const currentDateProgress = bookingFields.collected_date != null
    || contextFields.collected_date != null
    || activeDateWindow != null;
  const continuesRecentReservation = recentReservation && currentDateProgress;
  const closeIntent = !currentCloseBlocker
    && (reservationIntent || continuesRecentReservation || llmReadyToBook || availabilityConfirm);
  if (reservationIntent || availabilityConfirm) {
    repos.conversation.setLeadIntent(customerPhone, 'ready_to_book');
  }
  const hasConfirmedDate = isConfirmedDate(merged.fecha);
  const hasCoreBooking = merged.personas != null && hasConfirmedDate;

  const deterministicBridgeFallback = analyzerUnavailable && closeIntent;
  const strongAvailabilityConfirm = availabilityConfirm
    && hasCoreBooking
    && (merged.plan != null || pricePresented || qComplete);
  // Hard close-CTA consent only ("¿la iniciamos?" / validation start + short
  // affirmation). Soft interest questions ("¿te suena?", "¿te interesa?") stay on
  // the qComplete / score-bridge gates so discovery "Si" does not page the owner
  // without name/transport. Plan and party size may be absent when the model inferred
  // them, but a recorded quote and confirmed date are required before a short
  // affirmation can page the owner.
  const explicitCloseCtaConsent = pricePresented && hasConfirmedDate && closeCtaAcceptedThisTurn;
  const canEnterHumanPending = (qComplete && pricePresented && (shouldBridgeByScore || deterministicBridgeFallback))
      || strongAvailabilityConfirm
      || (reservationIntent && !explicitCloseCtaConfirmation && pricePresented && !hasConfirmedDate)
      || (reservationIntent && qComplete && pricePresented)
      || explicitCloseCtaConsent;

  // `hasSafetyOverride` is not re-checked here: a safety override returns pre-LLM,
  // so this path only runs for normal LLM turns.
  if (paymentQ && (pricePresented || conversationMode === 'human_pending')) {
    needsHumanEffective = true;
    finalScore = Math.max(hybrid.score, skills.salesStrategy.urgentLeadThreshold);
    repos.conversation.upsert(customerPhone, { lead_score: finalScore });
  } else if (canEnterHumanPending && hasPublicPaymentFacts(skills)) {
    needsHumanEffective = true;
    finalScore = Math.max(hybrid.score, skills.salesStrategy.urgentLeadThreshold);
    repos.conversation.upsert(customerPhone, { lead_score: finalScore });
    logger.info({
      phone: customerPhone,
      score: finalScore,
      intent: analysis?.intent,
      readiness: analysis?.reservationReadiness,
      fallback: deterministicBridgeFallback,
      availabilityConfirm: strongAvailabilityConfirm,
      explicitCloseCtaConsent,
      skillsV2: true,
    }, '[BOT] reservation human_pending flagged (LLM reply kept)');
  }

  if (needsHumanEffective) enterHumanPending(repos, customerPhone);

  merged = { ...merged, dateStatus: repos.conversation.getDateStatus(customerPhone) };

  const finalPriceJustGiven = legalPrice && replyMentionsPrice(strippedReplyText);
  if (finalPriceJustGiven && !prePriceRow) repos.conversation.upsert(customerPhone, { price_given_at: new Date().toISOString() });
  const outputPriceJustGiven = !needsHumanEffective && finalPriceJustGiven;

  // Plan image flag only — deepseek-llm-client plain-text mode hardcodes img=false,
  // so this stays false until structured img returns. Not a live media path today.
  const shouldSendImage = !softUnsafePhrasing && llmTurn.img;
  // TODO(sales-strategy): owner intro image intentionally disabled pending team review.
  const mediaReplyFailure = persistentUnmarkedPhotoPromise || persistentMissingExplicitMarker;
  const shouldAlertOwner = needsHumanEffective || (hybrid.isHot && pricePresented) || mediaReplyFailure;
  const ownerAlertType = mediaReplyFailure
    ? 'media_marker_unhonoured'
    : needsHumanEffective ? 'reservation_handoff' : 'hot_lead';

  // Explicitly requested photos ship even on a handoff or soft-unsafe turn. Those
  // guards exist to keep UNSOLICITED sales media off a sensitive reply — but the
  // customer asked for these, and the model wrote the reply on the promise of them,
  // so dropping them silently is a broken promise. Observed live: a photo request
  // arriving on the close turn delivered the text ("te comparto unas del
  // hospedaje…") and zero photos, because the close had flipped needsHumanEffective.
  // The automatic contextual image below still honours both guards.
  if (requestedGalleryImageUrls.length > 0 && (softUnsafePhrasing || needsHumanEffective)) {
    logger.info({
      phone: customerPhone,
      count: requestedGalleryImageUrls.length,
      softUnsafePhrasing,
      handoff: needsHumanEffective,
    }, '[MEDIA] requested photos kept on a guarded turn — the customer asked for them');
  }

  // Automatic contextual media remains a single reply-carrying image. Explicit
  // gallery requests take priority to avoid a media flood.
  const contextualImagesAllowed = !isNewConversation
    && !softUnsafePhrasing
    && !outputPriceJustGiven
    && !needsHumanEffective
    && requestedGalleryImageUrls.length === 0;
  const contextualImage = contextualImagesAllowed
    ? selectContextualImage(
      skills,
      repos,
      customerPhone,
      strippedReplyText,
      activeExperience.id,
      selectedPlanSiteId,
      entryMarker,
    ).image
    : null;

  if (isTruncatedReply(strippedReplyText)) {
    logger.warn({ phone: customerPhone, replyLen: strippedReplyText.length }, '[LLM] reply may be truncated');
  }
  diagnosticMediaReply(strippedReplyText, requestedGalleryImageUrls.length, customerPhone);

  return {
    reply: strippedReplyText, shouldSendReply: true,
    leadScore: finalScore, usedAi: true,
    shouldAlertOwner, ownerAlertType, shouldSendImage,
    shouldSendOwnerImage: false,
    shouldSendGalleryImages: requestedGalleryImageUrls.length > 0,
    requestedGalleryImages: requestedGalleryImageUrls.length > 0 ? requestedGalleryImageUrls : undefined,
    contextualImage: contextualImage ? { url: contextualImage.url } : undefined,
    priceJustGiven: outputPriceJustGiven,
    reservationReady: closeIntent && hasCoreBooking && pricePresented,
    mediaPlanId: typeof merged.plan === 'string' ? merged.plan : null,
    outboundDateAction: detectOutboundDateAction(strippedReplyText, merged),
    bookingIntent: !!needsHumanEffective || (paymentQ && pricePresented),
    handoffCreated: false,
    leadLifecycle: needsHumanEffective ? 'human_pending' : undefined,
    suppressGenericFollowups: needsHumanEffective,
  };
  } catch (err) {
    logSystemError('process_message', 'error', err, {
      phone: customerPhone,
    });
    const lang = repos.conversation.getLanguage(customerPhone);
    const currentScore = repos.conversation.getLeadScore(customerPhone);
    return {
      reply: getSystemErrorRetry(lang),
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }
}
