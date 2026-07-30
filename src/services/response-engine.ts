import { getSkills, refreshSkills, isDynamicDataFresh, type Skills, type FallbackReplies } from './skill-loader.js';
import { logger } from '../config/logger.js';
import { logSystemError } from './error-logger.js';
import { hasGalleryNudge } from './media-service.js';
import { env } from '../config/env.js';
import { scoreMessage, computeHybridScore, type LlmLeadInput } from './lead-scoring.js';
import { checkTimeWindow } from './time-window-policy.js';
import { checkBudget } from './budget-guard.js';
import { reportAiBudgetBlocked } from './whatsapp-operational-health.js';
import { buildSystemPrompt } from './deepseek-client.js';
import { extractCustomerContext } from './customer-context.js';
import { DeepSeekLlmClient } from './llm/deepseek-llm-client.js';
import { analyzeLead, type LeadAnalysis } from './lead-analyzer.js';
import type { LlmTurn } from './llm/llm-client.js';
import type { MergedQualification, OutboundDateAction, ProcessMessageInput, ProcessMessageOutput } from './types.js';
import { getActiveExperience, getCommonQuestions, getFutureAvailableDates, getPlans, getPricingItems, getShortDescription, hasPublicPaymentFacts, isPricingAvailable, getPublicPaymentFacts, hasMultipleExperiences, getExperiences, scopeSkillsToExperience } from './product-registry.js';
import type { ActiveExperience, PublicPaymentFacts } from './product-registry.js';
import { calculatePriceQuote, formatCop, getStartingPrice, type PriceQuote, type TransportNeed } from './pricing-calculator.js';
import {
  extractBookingFields,
  contextAwareExtract,
  reconstructFromHistory,
  buildDbQualification,
  getCollectedFields,
  resolveLanguage,
  isConfirmedDate,
  isQualificationComplete,
  nextQualificationQuestion,
  extractStandaloneName,
  detectPlan,
  isAmbiguousPartyComparison,
  isExplicitDateDeferral,
  isUncertainDateAnswer,
  isDateAskQuestion,
  isDateOptionsRequest,
  PET_KEYWORDS,
} from './qualification-engine.js';
import {
  isSoftCloseMessage,
  isAdcodeNoise,
  isReEngagementMessage,
  isReviewPause,
  isPartnerConsultPause,
  isCustomerFollowUpPromise,
  getLastAssistantQuestion,
  detectsReservationIntent,
  detectsAvailabilityConfirmRequest,
  detectsOrganizerContactShare,
  detectsWrongServiceNatureOnly,
  isReservationIntentOrConfirmation,
  replyMentionsPrice,
  containsHandoffPhrase,
  stripHandoffPhrases,
  containsUnsafeReservationClaim,
  containsPromptLeakOrPolicyViolation,
  isTruncatedReply,
  isGalleryRequest,
  isGalleryConfirmation,
  stripSelfIntro,
  detectProactiveLeadPain,
  isPaymentMethodsQuestion,
  hasActionableUserQuestion,
  qualificationSummary,
  peopleLabel,
  stripAssumedDatePhrases,
  stripAssumedExperienceClaims,
  containsClosingDelay,
} from './reply-guard.js';

import { assignLine, isReferralLine } from './lead-routing.js';
import { normalizeText } from './language-service.js';
import { enrichReply } from './reply-enrichment.js';
import { INPUT_COST_PER_TOKEN, MONTH_NAMES, MS_72H, OUTPUT_COST_PER_TOKEN, SCORE_GALLERY_TRIGGER_THRESHOLD } from './constants.js';
import type { RecentMessage, LeadPain } from '../db/repositories/types.js';

export {
  detectsReservationIntent,
  isReservationIntentOrConfirmation,
  replyMentionsPrice,
  containsHandoffPhrase,
  stripHandoffPhrases,
  isTruncatedReply,
};

export type { ProcessMessageInput, ProcessMessageOutput };

function isAmbiguousTransportRequest(message: string): boolean {
  if (!/\b(?:transporte|transport|recoger|pickup)\b/i.test(message)) return false;
  return !/\b(?:bus|publico|public|privado|private|carro propio|moto|own transport|own car)\b/i.test(message);
}

function isTransportPriceInquiry(message: string): boolean {
  return /\b(?:transporte|transport)\b/i.test(message)
    && (/\b(?:cu[aá]nto|qu[eé]\s+vale|valor|precio|cost|how much)\b/i.test(message)
      || /^\s*(?:y|and)\s+(?:el\s+)?(?:transporte|transport)\b/i.test(message));
}

function wasAskedTransport(lastAssistantQuestion: string | null): boolean {
  return lastAssistantQuestion != null
    && /transporte propio|necesitan desde|vas (?:con|en)|por su cuenta|own transport|pickup|Bogot[aá]|llegar desde|how (?:are you|will you) (?:getting|coming)/i.test(lastAssistantQuestion);
}

function hasExplicitOwnTransport(message: string): boolean {
  return /\b(?:carro|moto|veh[ií]culo|propio|own|driv(?:e|ing))\b/i.test(message);
}

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

/**
 * Marks lead as waiting on human validation. Bot keeps replying (payment facts,
 * clarifications). Does NOT set handed_off_at and does NOT open a live bridge —
 * agent must still run /bridge to take exclusive control. Webhook notifies the
 * assigned bridge line on further inbound while mode stays human_pending.
 */
function enterHumanPending(repos: ProcessMessageInput['repos'], customerPhone: string): void {
  repos.conversation.setMode(customerPhone, 'human_pending');
  repos.conversation.setSalesPhase(customerPhone, 'closing');
}

const MAX_INBOUND_CHARS = 1500;
const SPANISH_MONTH_INDEX: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const ENGLISH_MONTH_INDEX: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
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

function factualPolicyReply(skills: Skills, lang: 'es' | 'en', message: string): string | null {
  if (isPhysicalRecoveryQuestion(message)) return null;
  const emeraldQuestion = /(?:esmerald.{0,80}(?:encontr|hall|qued|llev|garant|segur)|(?:encontr|hall|qued|llev|garant|segur).{0,80}esmerald)/i.test(message);
  const mineQuestion = /(?:mina.{0,80}(?:la uni[oó]n|activa|siempre)|(?:la uni[oó]n|activa|siempre).{0,80}mina)/i.test(message);
  if (!emeraldQuestion && !mineQuestion) return null;
  const questions = getCommonQuestions(getActiveExperience(skills));
  const intents = [emeraldQuestion ? 'emerald' : null, mineQuestion ? 'mine_assignment' : null].filter((intent): intent is string => intent !== null);
  const answers = intents.map(intent => questions.find(question => question.lang === lang && question.intent === intent)?.answer).filter((answer): answer is string => Boolean(answer));
  return answers.length > 0 ? answers.join('\n\n') : null;
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

function isInclusionsQuestion(message: string, lang: 'es' | 'en'): boolean {
  const norm = normalizeForKeywordMatch(message);
  if (lang === 'es') return /\bque incluye\b|\bque trae\b|\bque viene incluido\b/.test(norm);
  return /\bwhat(?:'s| is) included\b|\bwhat does it include\b/.test(norm);
}

/** True when inclusions is the only (or primary) ask — not a multi-fact dump. */
function isStandaloneInclusionsQuestion(message: string, lang: 'es' | 'en'): boolean {
  if (!isInclusionsQuestion(message, lang)) return false;
  const questionMarks = (message.match(/\?/g) ?? []).length;
  if (questionMarks >= 2) return false;
  const norm = normalizeForKeywordMatch(message);
  if (/\b(?:cuatro|varias|varios|tambien|and also|as well)\b/.test(norm)) return false;
  if (/\b(?:edad|dura|duracion|mascota|pet|precio|fecha|cuanto)\b/.test(norm)
    && !/\bque incluye\b|\bwhat(?:'s| is) included\b/.test(norm)) return false;
  // Multi-topic list: "dura X, qué incluye, edad, mascotas"
  if (/\b(?:dura|edad|mascota|pet).{0,80}\b(?:incluye|include)/.test(norm)
    || /\b(?:incluye|include).{0,80}\b(?:dura|edad|mascota|pet)/.test(norm)) {
    return false;
  }
  return true;
}

function isAvailabilityRecommendQuestion(message: string): boolean {
  const norm = normalizeForKeywordMatch(message);
  if (detectsAvailabilityConfirmRequest(message)) return false;
  if (isPriceQuestion(message)) return false;
  // Only force validation language when the customer asks for a recommendation
  // (not when listing known dates from Business Context is appropriate).
  return (
    /\b(?:que|cual)\s+fecha\s+(?:me\s+)?recomiend/i.test(norm)
    || /\brecomiend\w*\s+(?:una\s+)?fecha/i.test(norm)
    || /\bfecha\s+(?:me\s+)?recomiend/i.test(norm)
    || /\bfecha\s+(?:mejor|ideal|buena)\b/i.test(norm)
    || /\bwhich\s+date\s+(?:do\s+you\s+)?recommend/i.test(norm)
    || /\brecommend\s+a\s+date/i.test(norm)
  );
}

/** Deterministic inclusions package — LLM must not omit core package facts. */
function buildInclusionsReply(skills: Skills, lang: 'es' | 'en'): string {
  return skills.fallbackReplies[lang].inclusionsPackageReply;
}

function buildAvailabilityListReply(skills: Skills, lang: 'es' | 'en'): string | null {
  const dates = getFutureAvailableDates(getActiveExperience(skills))
    .map(item => new Date(`${item.date}T12:00:00Z`))
    .filter(date => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())
    .map(date => new Intl.DateTimeFormat(lang === 'es' ? 'es-CO' : 'en-US', {
      day: 'numeric', month: 'long', timeZone: 'UTC',
    }).format(date));
  if (dates.length === 0) return null;
  const separator = lang === 'es' ? ' y ' : ' and ';
  const list = dates.length === 1
    ? dates[0]
    : `${dates.slice(0, -1).join(', ')}${separator}${dates.at(-1)}`;
  return skills.fallbackReplies[lang].availabilityListReply.replace('{{dates}}', list);
}

function needsPlanBeforeDates(skills: Skills, plan: unknown, qual: { priceGiven: boolean }): boolean {
  if (typeof plan === 'string' && plan.length > 0) return false;
  if (getPlans(getActiveExperience(skills)).length <= 1) return false;
  return qual.priceGiven;
}

function buildAvailabilityRecommendReply(
  skills: Skills,
  lang: 'es' | 'en',
  merged: MergedQualification,
  message: string,
): string {
  const month = MONTH_NAMES.find(m => normalizeForKeywordMatch(message).includes(m));
  const windowClause = month
    ? (lang === 'es' ? ` para ${month}` : ` for ${month}`)
    : (typeof merged.fecha === 'string' && merged.fecha
      ? (lang === 'es' ? ` para ${merged.fecha}` : ` for ${merged.fecha}`)
      : '');
  const peopleClause = typeof merged.personas === 'number'
    ? (lang === 'es' ? ` para ${merged.personas} personas` : ` for ${merged.personas} people`)
    : '';
  return skills.fallbackReplies[lang].availabilityRecommendReply
    .replace('{{windowClause}}', windowClause)
    .replace('{{peopleClause}}', peopleClause);
}

function isAvailabilityLookupQuestion(message: string): boolean {
  return /\b(?:fecha|fechas|disponib\w*|cupos?|date|dates|availability|available|spots?)\b/i.test(normalizeForKeywordMatch(message));
}

function isDirectAvailabilityListQuestion(message: string): boolean {
  const normalized = normalizeForKeywordMatch(message);
  const monthAlt = MONTH_NAMES.join('|');
  const monthOrYear = new RegExp(`\\b(?:${monthAlt}|[12]\\d{3})\\b`);
  const windowPhrase = /\b(?:finales?\s+de|principios?\s+de|late|end\s+of|beginning\s+of)\b/;
  // Exclude date-window prefix (e.g. "finales de agosto que fechas tienen?") —
  // those go through the late-month availability path.
  const qIdx = normalized.search(/\b(?:que|cuales?)\s+fechas\b/);
  if (qIdx > 0) {
    const before = normalized.slice(0, qIdx);
    if (monthOrYear.test(before) || windowPhrase.test(before)) return false;
  }
  const matches = /\b(?:que|cuales?)\s+fechas\s+(?:tienen|tienes|tenias|hay|estan)\s+disponibles?\b/.test(normalized)
    || /\b(?:que|cuales?)\s+fechas\s+(?:existen|manejan|ofrecen|tienes)(?:\s+ahora)?\b/.test(normalized)
    || /\b(?:que|cuales?)\s+fechas\s+(?:hay|tienen|existen)\s+ahora\b/.test(normalized)
    || /\b(?:que|cuales?)\s+fechas\b.{0,30}\b(?:disponib\w*|publicad\w*|abiert\w+|cupos?)\b/.test(normalized)
    || (/\bfechas?\s+(?:disponibles?|publicadas?)\b/.test(normalized)
      && /\b(?:que|cuales?|muestrame|ensename|dime|quiero\s+(?:saber|ver|conocer))\b/.test(normalized))
    || /\b(?:what|which)\s+dates\s+(?:are|do you have|exist|are there)\s+available\b/.test(normalized)
    || /\bwhat\s+dates\s+do you have\s*\??$/.test(normalized);
  // Month window after the ask → late-month path, not full catalog dump.
  const monthSuffix = new RegExp(`\\b(?:para|en|durante|in|for|on|during)\\s+(?:${monthAlt})\\b`);
  if (matches && (monthSuffix.test(normalized) || (windowPhrase.test(normalized) && monthOrYear.test(normalized)))) {
    return false;
  }
  return matches;
}

function isPlanListQuestion(message: string): boolean {
  const normalized = normalizeForKeywordMatch(message);
  return /\b(?:que\s+planes|qu[eé]\s+planes|cuales\s+planes|qu[eé]\s+experiencias|qu[eé]\s+tipo\s+de\s+planes|qu[eé]\s+opciones\s+de\s+plan|que\s+opciones\s+de\s+experiencia)\b/i.test(normalized)
    || /\b(?:ofrecen|tienen|hay|manejan)\s*$/i.test(normalized) && /\b(?:que\s+planes|qu[eé]\s+planes|cuales\s+planes)\b/i.test(normalized)
    || /\b(?:what\s+plans|which\s+plans|what\s+experiences|what\s+kind\s+of\s+plans)\b/i.test(normalized)
    || /\b(?:do\s+you\s+(?:offer|have))\s*$/i.test(normalized) && /\b(?:what\s+plans|which\s+plans)\b/i.test(normalized);
}

function buildPlansListReply(skills: Skills, lang: 'es' | 'en'): string {
  const exp = getActiveExperience(skills);
  const plans = getPlans(exp);
  if (plans.length === 0) return skills.fallbackReplies[lang].plansListReply.replace('{{plans}}', lang === 'es' ? 'Consulta con el equipo para más detalles.' : 'Check with the team for more details.');
  const separator = lang === 'es' ? '\n' : '\n';
  const list = plans.map(p => `${p.name} (${p.duration}): ${p.shortDescription}`).join(separator);
  return skills.fallbackReplies[lang].plansListReply.replace('{{plans}}', list);
}

function buildLateMonthAvailabilityReply(skills: Skills, lang: 'es' | 'en', message: string): string | null {
  const normalized = normalizeForKeywordMatch(message);
  const match = normalized.match(/\b(?:finales\s+de|late|end\s+of)\s+(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i);
  if (!match) return null;

  const monthName = match[1].toLowerCase();
  const month = SPANISH_MONTH_INDEX[monthName] ?? ENGLISH_MONTH_INDEX[monthName];
  if (!month) return null;

  const exp = getActiveExperience(skills);
  const monthDates = getFutureAvailableDates(exp)
    .map(item => ({ item, date: new Date(`${item.date}T12:00:00Z`) }))
    .filter(({ date }) => date.getUTCMonth() + 1 === month);
  const explicitYear = normalized.match(/\b(20\d{2})\b/)?.[1];
  const targetYear = explicitYear ? Number(explicitYear) : Math.min(...monthDates.map(({ date }) => date.getUTCFullYear()));
  const listed = monthDates.filter(({ date }) => date.getUTCFullYear() === targetYear);
  if (listed.some(({ date }) => date.getUTCDate() >= 21)) return null;

  const fb = skills.fallbackReplies[lang];
  const localizedMonth = new Intl.DateTimeFormat(lang === 'es' ? 'es-CO' : 'en-US', {
    month: 'long', timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, month - 1, 1)));
  const yearClause = explicitYear ? ` ${explicitYear}` : '';
  const window = lang === 'es' ? `finales de ${localizedMonth}${yearClause}` : `late ${localizedMonth}${yearClause}`;
  const closest = listed.sort((a, b) => b.date.getUTCDate() - a.date.getUTCDate())[0];
  if (!closest) return fb.availabilityWindowNoMatch.replace('{{window}}', window);

  const date = new Intl.DateTimeFormat(lang === 'es' ? 'es-CO' : 'en-US', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  }).format(closest.date);
  const statusClause = closest.item.status === 'limited' ? fb.availabilityLimitedClause : '';
  return fb.availabilityWindowNoMatchClosest
    .replace('{{window}}', window)
    .replace('{{date}}', date)
    .replace('{{statusClause}}', statusClause);
}

function replyMissingCoreInclusion(normReply: string): boolean {
  return !/\balojamiento|lodging\b/.test(normReply)
    || !/\b3 comidas|3 meals|comidas completas\b/.test(normReply)
    || !/\bequipo|equipment|casco|botas\b/.test(normReply)
    || !/\bguia|acompanamiento|guide\b/.test(normReply);
}

function ensureRequestedInclusionCoverage(reply: string, message: string, skills: Skills, lang: 'es' | 'en'): string {
  if (!isInclusionsQuestion(message, lang)) return reply;
  if (isStandaloneInclusionsQuestion(message, lang)) return buildInclusionsReply(skills, lang);
  // Multi-fact answers: append i18n pad if core package facts are missing.
  if (!replyMissingCoreInclusion(normalizeForKeywordMatch(reply))) return reply;
  return `${reply.trim()} ${skills.fallbackReplies[lang].inclusionsPadSuffix}`;
}

function extractFutureMonthConstraint(text: string): string | null {
  const match = text.match(/\b(?:despu[eé]s de|after)\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
  return match ? match[0] : null;
}

function buildPartyComparisonReply(skills: Skills, lang: 'es' | 'en', planId?: string | null): string {
  const exp = getActiveExperience(skills);
  if (!isPricingAvailable(exp)) return skills.fallbackReplies[lang].partyComparisonUnavailable;
  const plans = getPlans(exp);
  const resolvedPlan = typeof planId === 'string' ? plans.find(plan => plan.id === planId) : undefined;
  if (!resolvedPlan) {
    return skills.fallbackReplies[lang].partyComparisonNeedsPlan
      .replace('{{plans}}', plans.map(plan => `${plan.name} (${plan.duration})`).join(', '));
  }
  const solo = calculatePriceQuote(exp, { planId: resolvedPlan.id, people: 1, transportNeed: 'own' });
  const couple = calculatePriceQuote(exp, { planId: resolvedPlan.id, people: 2, transportNeed: 'own' });
  if (!solo || !couple) return skills.fallbackReplies[lang].partyComparisonUnavailable;
  return skills.fallbackReplies[lang].partyComparisonQuote
    .replace('{{soloTotal}}', formatCop(solo.planTotal))
    .replace('{{coupleTotal}}', formatCop(couple.planTotal))
    .replace('{{currency}}', solo.currency);
}

function shouldAutoSendGallery(currentScore: number, isExplicitRequest: boolean): boolean {
  if (isExplicitRequest) return true;
  return currentScore >= SCORE_GALLERY_TRIGGER_THRESHOLD;
}

/** Only strip interrogative re-asks (must include ¿ or ?), never narrative statements. */
function stripReaskedQuestions(reply: string, merged: MergedQualification): string {
  let result = reply;

  if (merged.nombre) {
    result = result.replace(
      /(?:¿\s*)?(?:c[oó]mo\s+te\s+llamas|c[uú]al\s+es\s+tu\s+nombre|con\s+qui[eé]n\s+tengo\s+el\s+gusto|what'?s\s+your\s+name|what\s+is\s+your\s+name|may\s+i\s+ask\s+your\s+name)[^?¿]*\?/gi,
      '',
    );
  }

  if (merged.personas != null) {
    result = result.replace(
      /(?:¿\s*)?(?:para\s+cu[aá]ntas\s+personas|cu[aá]ntas\s+personas|vienes?\s+solo\s+o|la\s+experiencia\s+ser[ií]a\s+para\s+ti\s+solo|how\s+many\s+people|is\s+the\s+experience\s+for\s+you\s+alone|for\s+you\s+alone,?\s+as\s+a\s+couple)[^?¿]*\?/gi,
      '',
    );
  }

  if (merged.fecha != null) {
    // Confirmed or deferred: strip dry date-ask questions only.
    result = result.replace(
      /(?:¿\s*)?(?:qu[eé]\s+fecha|(?:tienes?|tienen)\s+(?:alguna\s+)?fecha|alguna\s+fecha|fecha\s+tentativa|fecha\s+en\s+mente|fecha\s+pensada|fecha\s+aproximada|para\s+qu[eé]\s+fecha|cu[aá]ndo\s+(?:quieres|quieren|te\s+gustar[ií]a)\s+ir|todav[ií]a\s+est[aá]s\s+explorando|what\s+date|do\s+you\s+have\s+a\s+date|date\s+in\s+mind|when\s+would\s+you\s+like\s+to\s+go|fecha\s+est[aá]s\s+considerando)[^?¿]*\?/gi,
      '',
    );
  }

  if (merged.transporte != null) {
    result = result.replace(
      /(?:¿\s*)?(?:tienes?|tienen|vienes?|vienen|are\s+you\s+arriving|do\s+you\s+have|do\s+you\s+need|how\s+would\s+you)?[^.!?¿\n]*\b(?:transporte\s+propio|carro\s+propio|por\s+tu\s+cuenta|necesitan\s+transporte|necesitas\s+transporte|own\s+transport|need\s+transport|how\s+would\s+you\s+get\s+there|c[oó]mo\s+llegar)[^?¿]*\?/gi,
      '',
    );
  }

  result = result.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return result;
}

function enforceMicroQuestionFirstContact(reply: string, isFirstContact: boolean, lang: 'es' | 'en'): string {
  if (!isFirstContact) return reply;

  const namePattern = /(?:¿?(?:c[oó]mo\s+te\s+llamas|c[uú]al\s+es\s+tu\s+nombre|con\s+qui[eé]n\s+tengo\s+el\s+gusto|what'?s\s+your\s+name|what\s+is\s+your\s+name|may\s+i\s+ask\s+your\s+name)[?¿]?\s*)/gi;

  if (namePattern.test(reply)) {
    const cleaned = reply.replace(namePattern, '').replace(/\n{3,}/g, '\n\n').trim();
    const question = lang === 'en'
      ? 'Would the experience be for you alone, as a couple, or for a group?'
      : '¿La experiencia sería para ti solo, en pareja o para un grupo?';
    return cleaned + '\n\n' + question;
  }

  return reply;
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

function buildPainSystemPromptSuffix(pain: LeadPain, lang: 'es' | 'en'): string {
  const painLabels: Record<LeadPain, { es: string; en: string }> = {
    price: { es: 'PRECIO', en: 'PRICE' },
    date_time: { es: 'FECHA / TIEMPO', en: 'DATE / TIMING' },
    security: { es: 'SEGURIDAD', en: 'SAFETY' },
    logistics_4x4: { es: 'TRANSPORTE / 4X4', en: 'TRANSPORT / 4X4' },
    experience_clarity: { es: 'ENTENDER LA EXPERIENCIA', en: 'UNDERSTANDING THE EXPERIENCE' },
    partner_group: { es: 'CONSULTARLO CON ALGUIEN', en: 'CHECKING WITH SOMEONE' },
    not_interested: { es: 'NO INTERESADO', en: 'NOT INTERESTED' },
    other: { es: 'OTRO', en: 'OTHER' },
  };
  const label = painLabels[pain][lang];
  if (lang === 'en') {
    return `\nKNOWN LEAD PAIN: ${label}\nThe customer already revealed their main blocker. Respond DIRECTLY to this concern using only facts from the Business Context. Do NOT ask basic qualification questions (people, date, transport) in this reply. Reframe the value specifically for this blocker. End with ONE soft next step related to this concern.`;
  }
  return `\nDOLOR CONOCIDO DEL LEAD: ${label}\nEl cliente ya revelo su bloqueante principal. Responde DIRECTAMENTE a esta preocupacion usando solo hechos del Business Context. NO hagas preguntas basicas de cualificacion (personas, fecha, transporte) en este mensaje. Enmarca el valor segun este bloqueante especifico. Termina con UNA pregunta suave de avance relacionada a esta preocupacion.`;
}

// Maps a detected pain to its deterministic reply template. Used when the LLM
// path is unavailable (budget blocked or LLM failure) so a pain-question reply
// still gets a grounded, pain-specific answer instead of a generic fallback.
const PAIN_TEMPLATE_KEY: Partial<Record<LeadPain, keyof FallbackReplies['es']>> = {
  price: 'painReplyPrice',
  date_time: 'painReplyDateTime',
  security: 'painReplySecurity',
  logistics_4x4: 'painReplyLogistics',
  experience_clarity: 'painReplyExperienceClarity',
  partner_group: 'painReplyPartnerGroup',
};

function getPainFallbackReply(pain: LeadPain, lang: 'es' | 'en'): string | null {
  const key = PAIN_TEMPLATE_KEY[pain];
  return key ? getSkills().fallbackReplies[lang][key] ?? null : null;
}

// Pains where auto-sending the gallery after a pain reply would feel pushy.
// A security/price/consult/not-interested answer is an objection, not buying
// re-engagement, so we keep those turns image-free.
const NON_REENGAGEMENT_PAINS: ReadonlySet<LeadPain> = new Set<LeadPain>([
  'price', 'security', 'partner_group', 'not_interested',
]);

function normalizeForKeywordMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isPriceDateOrReservationMessage(text: string): boolean {
  const norm = normalizeForKeywordMatch(text);
  return /\b(?:precio|precios|cuanto|cuanta|cuantas|cuantos|vale|valor|costo|cuesta|fecha|fechas|disponible|disponibilidad|cupo|cupos|agenda|agendar|reservar|reserva|reservacion|separar|pagar|pago|deposito|abono|nequi|price|prices|cost|fee|date|dates|available|availability|schedule|book|booking|reserve|reservation|pay|payment|deposit)\b/i.test(norm)
    || norm.includes('how much')
    || norm.includes('mercado pago');
}

const OPT_OUT_KEYWORDS_ES = ['detener', 'cancelar mensajes', 'no me escriban', 'basta', 'suficiente', 'dejen de escribirme', 'no me contacten', 'no me contacte', 'sacame de la lista', 'no quiero recibir mensajes', 'no quiero mas mensajes', 'borra mis datos', 'eliminame', 'eliminame de la lista', 'no me vuelvan a escribir', 'no me manden mas mensajes', 'dejen de molestar', 'paren', 'bloqueo', 'reporto'];
const OPT_OUT_KEYWORDS_EN = ['stop', 'unsubscribe', 'no more messages', 'remove me', 'do not contact me', 'take me off', 'take me off the list', 'please stop', 'enough', "i'm done", 'i am done', 'unsubscribe me', 'do not text', 'do not message', 'stop messaging', 'leave me alone', 'do not disturb', 'block', 'report spam'];
const ALL_OPT_OUT_KEYWORDS = [...OPT_OUT_KEYWORDS_ES, ...OPT_OUT_KEYWORDS_EN];

export function isOptOutMessage(message: string): boolean {
  const normalized = message.toLowerCase().trim();
  return ALL_OPT_OUT_KEYWORDS.some(keyword => normalized.includes(keyword));
}

export const llmClient = new DeepSeekLlmClient(true);

function getPlanPricing(planId: string | undefined | null, skills: Skills): { individualPrice: number | null; couplePrice: number | null; planName: string; duration: string } {
  const exp = getActiveExperience(skills);
  const plans = getPlans(exp);
  if (!plans.length) return { individualPrice: null, couplePrice: null, planName: 'plan', duration: 'plan' };
  const selectedPlan = planId ? plans.find(p => p.id === planId) : plans[0];
  if (!selectedPlan) return { individualPrice: null, couplePrice: null, planName: 'plan', duration: 'plan' };
  const pricingItems = getPricingItems(exp);
  const planPricingItems = pricingItems.filter(i => i.planId === selectedPlan.id);
  const individual = planPricingItems.find(i => i.pricePerPerson != null);
  const couple = planPricingItems.find(i => i.couplePrice != null);
  return {
    individualPrice: individual?.pricePerPerson ?? null,
    couplePrice: couple?.couplePrice ?? null,
    planName: selectedPlan.name,
    duration: selectedPlan.duration,
  };
}

function computePriceFollowUp(personas: unknown, planId: string | undefined | null, lang: 'es' | 'en', skills: Skills): string | undefined {
  const { individualPrice, couplePrice, duration } = getPlanPricing(planId, skills);
  if (individualPrice == null || couplePrice == null) return undefined;
  const fb = skills.fallbackReplies[lang];
  const quote = calculatePriceQuote(getActiveExperience(skills), { planId, people: personas });
  if (!quote) {
    return fb.priceFollowUpCatalog
      .replace('{{duration}}', duration)
      .replace('{{individualPrice}}', formatCop(individualPrice))
      .replace('{{couplePrice}}', formatCop(couplePrice));
  }
  const label = quote.people === 2
    ? fb.priceFollowUpLabelCouple
    : fb.priceFollowUpLabelPeople
      .replace('{{count}}', String(quote.people))
      .replace('{{unit}}', quote.people === 1 ? fb.priceFollowUpUnitPerson : fb.priceFollowUpUnitPeople);
  return fb.priceFollowUpCase
    .replace('{{label}}', label)
    .replace('{{planTotal}}', formatCop(quote.planTotal));
}

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

function wantsApiaryCattle(text: string): boolean {
  return /\b(apiari[oa]|abejas?|colmenas?|ganader[ií]a|ganadero|ganadera|cattle|bees?|apiary)\b/i.test(text);
}

type QuotePlan = ReturnType<typeof getPlans>[number];

function quotePlan(skills: Skills, planId: string): QuotePlan {
  const exp = getActiveExperience(skills);
  return getPlans(exp).find(plan => plan.id === planId) ?? getPlans(exp)[0];
}

function applyPlanTokens(text: string, plan: QuotePlan): string {
  return text
    .replaceAll('{{planName}}', plan.name)
    .replaceAll('{{planDuration}}', plan.duration)
    .replaceAll('{{planSummary}}', plan.shortDescription);
}

function quoteFitLine(people: number, plan: QuotePlan, fb: FallbackReplies['es']): string {
  const template = people === 1
    ? fb.quoteFitSolo
    : people === 2
      ? fb.quoteFitCouple
      : fb.quoteFitGroup.replace('{{people}}', String(people));
  return applyPlanTokens(template, plan);
}

// Numbers from calculator; package copy from fallback-replies (value before number).
function quoteCta(fb: FallbackReplies['es'], merged: Pick<MergedQualification, 'fecha' | 'transporte' | 'personas' | 'dateStatus'>): string {
  const status = merged.dateStatus;
  if (status === 'deferred' || status === 'options_offered' || isDeferredDate(merged.fecha, status)) {
    return merged.transporte != null ? fb.advanceQuestionDateOnly : fb.quoteNextStepDateDeferred;
  }
  if (status === 'window') return fb.advanceQuestionNextStep;
  if (!isConfirmedDate(merged.fecha)) {
    return merged.personas === 1 ? fb.quoteNextStepSolo : fb.quoteNextStep;
  }
  return fb.advanceQuestionNextStep;
}

function formatDeterministicQuoteReply(
  quote: PriceQuote,
  skills: Skills,
  lang: 'es' | 'en',
  merged: Pick<MergedQualification, 'fecha' | 'transporte' | 'personas'> = { fecha: null, transporte: null, personas: quote.people },
): string {
  const fb = skills.fallbackReplies[lang];
  const plan = quotePlan(skills, quote.planId);
  const fit = quoteFitLine(quote.people, plan, fb);
  const valueStack = applyPlanTokens(fb.quoteValueStack, plan);
  const anchor = applyPlanTokens(fb.quoteAnchor, plan);
  const baseTemplate = quote.people === 1 ? fb.quotePlanBaseSolo : fb.quotePlanBase;
  const base = baseTemplate
    .replace('{{people}}', peopleLabel(quote.people, lang))
    .replace('{{planTotal}}', formatCop(quote.planTotal))
    .replace('{{currency}}', quote.currency);
  const nextStep = quoteCta(fb, { ...merged, personas: merged.personas ?? quote.people });

  const addon = quote.addonsTotal > 0
    ? fb.quoteAddons.replace('{{addonsTotal}}', formatCop(quote.addonsTotal)).replace('{{currency}}', quote.currency)
    : '';

  if (quote.requiresTransportConfirmation) {
    return `${fit} ${valueStack} ${anchor} ${base}${addon}${fb.quoteTransportConfirm} ${nextStep}`.trim();
  }
  const transport = quote.transportTotal != null
    ? fb.quoteTransport.replace('{{transportTotal}}', formatCop(quote.transportTotal)).replace('{{currency}}', quote.currency)
    : '';
  const total = fb.quoteTotal
    .replace('{{total}}', formatCop(quote.total ?? quote.planTotal))
    .replace('{{currency}}', quote.currency);

  const totalLine = quote.total != null && quote.total !== quote.planTotal
    ? total
    : '';
  return `${fit} ${valueStack} ${anchor} ${base}${addon}${transport}${totalLine} ${nextStep}`.trim();
}

function frameDeterministicQuote(_llmReply: string, quoteReply: string, _fb: FallbackReplies['es']): string {
  // Package is self-contained (fit + value + number + CTA). Avoid stitching bare LLM fragments.
  return quoteReply;
}

/** First full price after explicit ask once party size is known (date does not gate base price). */
function canPresentFirstPrice(message: string, merged: MergedQualification): boolean {
  if (typeof merged.personas !== 'number') return false;
  if (isPriceQuestion(message)) {
    const msgFields = extractBookingFields(message);
    const mergedExtra = [merged.plan, merged.fecha, merged.transporte].filter(v => v != null).length;
    const msgExtra = [msgFields.collected_people, msgFields.collected_date, msgFields.collected_transport_need]
      .filter(v => v != null).length;
    return (mergedExtra + msgExtra + 1) >= 2;
  }
  if (/\bvale\s+la\s+pena\b/i.test(normalizeForKeywordMatch(message))) return false;
  if (isQualificationComplete(merged)) return false;
  return isConfirmedDate(merged.fecha) || merged.transporte != null;
}

// Known template placeholders used across fallback-replies.json and prompts.
// Matched with single OR double braces so an LLM emitting `{planName}` is also
// scrubbed. Kept explicit (not `[a-zA-Z]+`) so legitimate `{word}` copy is never
// deleted. `plan` matches planName/planDuration/planSummary/planTotal via prefix.
const KNOWN_TEMPLATE_TOKENS = /\{\{?(?:addonsTotal|age|agentName|continuation|count|couplePrice|coupleTotal|currency|date|dateClause|dates|deposit|depositAmount|displayNumber|duration|experienceName|experienceSummary|individualPrice|instagramUrl|itinerarySummary|label|maxGroupSize|methods|month|name|paymentUrl|people|peopleClause|plan[A-Za-z]*|plans|price|priceLine|soloTotal|startingPrice|statusClause|summary|total|transportTotal|unit|window|windowClause)\}?\}/g;

function scrubInternalLeakTokens(reply: string, internalDatePending: string): string {
  return reply
    .replace(KNOWN_TEMPLATE_TOKENS, '')
    .replace(/\btentative_unknown\b/gi, internalDatePending)
    .replace(/_relative_ordinal_[a-z0-9_]+/gi, internalDatePending);
}

/** Final safety net: drop any known placeholder that survived substitution. */
function stripUnsubstitutedTokens(reply: string): string {
  return reply.replace(KNOWN_TEMPLATE_TOKENS, '').replace(/\s{2,}/g, ' ').trim();
}

/** Strip COP-format price numbers from reply text when price gating blocks them. */
function stripPriceText(text: string): string {
  return text
    .replace(/\$?\s*\d{1,3}(?:[.,]\d{3})+\s*(?:COP|pesos)?/gi, '')
    .replace(/\b\d{4,}\s*(?:COP|pesos)\b/gi, '')
    .replace(/\b\d{2,3}\s*mil\b(?:\s*(?:COP|pesos))?/gi, '')
    .replace(/\b\d\s*mill[oó]n\b(?:\s*(?:COP|pesos))?/gi, '')
    .replace(/\b(?:cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos)(?:\s+(?:veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)(?:\s+y\s+\w+)?)?\s+mil(?:\s+(?:COP|pesos))?\b/gi, '')
    .replace(/\b(?:un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\s+mill[oó]n(?:es)?(?:\s+(?:COP|pesos))?\b/gi, '')
    .replace(/\b(?:one|two|three|four|five|six|seven|eight|nine)\s+(?:hundred(?:\s+(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety))?\s+thousand|million)(?:\s+(?:COP|pesos))?\b/gi, '')
    .replace(/\bcuesta\b.{0,40}\$?\s*\d{1,3}(?:[.,]\d{3})+/gi, '')
    .replace(/\b(?:precio|price|valor|costo|total)\s+(?:es\b|ser[ií]a\b|de\b|desde\b)\s+\$?\s*\d{1,3}(?:[.,]\d{3})+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildPriceGateTeaser(skills: Skills, lang: 'es' | 'en', planId: string | null | undefined): string | null {
  const exp = getActiveExperience(skills);
  const plan = planId ? getPlans(exp).find(p => p.id === planId) : undefined;
  const startingPrice = getStartingPrice(exp, plan?.id);
  if (!startingPrice) return null;
  const startingPlan = getPlans(exp).find(candidate => candidate.id === startingPrice.planId);
  if (!startingPlan) return null;
  // Only used when party size is missing — never imply date changes base price.
  return applyPlanTokens(skills.fallbackReplies[lang].priceGateTeaser, startingPlan)
    .replace('{{startingPrice}}', formatCop(startingPrice.amount))
    .replace('{{currency}}', startingPrice.currency);
}

function isPriceRequestContinuation(recentMessages: RecentMessage[], peopleFromCurrentMessage: unknown): boolean {
  if (typeof peopleFromCurrentMessage !== 'number') return false;
  const lastCustomerMessage = [...recentMessages].reverse().find(message => message.role === 'user');
  return lastCustomerMessage != null && isPriceQuestion(lastCustomerMessage.content);
}

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

type CloseKind = 'closing' | 'payment_methods' | 'pending_owner' | 'soft_hold';

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

function availabilityEntryForDate(skills: Skills, fecha: unknown): { status: string } | null {
  if (typeof fecha !== 'string') return null;
  const normalized = normalizeForKeywordMatch(fecha);
  const explicitYear = normalized.match(/\b(20\d{2})\b/)?.[1];
  return getFutureAvailableDates(getActiveExperience(skills)).find(entry => {
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
function isExactBookingDate(value: unknown): boolean {
  if (!isConfirmedDate(value)) return false;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return true;
  const norm = normalizeForKeywordMatch(text);
  const hasDay = /\b([1-9]|[12]\d|3[01])\b/.test(norm);
  const hasMonth = /\b(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(norm);
  return hasDay && hasMonth;
}

function selectedDateFromAvailabilityReply(
  message: string,
  lastAssistantQuestion: string | null,
  skills: Skills,
): string | null {
  if (!lastAssistantQuestion || !/^(?:s[ií]|sip|si claro|claro|dale|listo|perfecto|de una|por supuesto)(?:\b|$|[\s,!.])/i.test(message.trim())) return null;
  if (!/(?:fecha|fin de semana|les sirve|te sirve|available|date|weekend)/i.test(lastAssistantQuestion)) return null;

  const assistantNorm = normalizeForKeywordMatch(lastAssistantQuestion);
  const messageNorm = normalizeForKeywordMatch(message);
  const selectedDay = messageNorm.match(/\b(?:el\s+)?([1-9]|[12]\d|3[01])\b/)?.[1];
  const candidates = getFutureAvailableDates(getActiveExperience(skills)).filter(entry => {
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
  const availability = availabilityEntryForDate(skills, merged.fecha);
  const template =
    kind === 'payment_methods' ? fb.paymentMethodsReply
    : kind === 'pending_owner' ? fb.reservationPendingOwner
    : kind === 'soft_hold' ? fb.reservationSoftHold
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

function buildReservationPolicyUnavailableReply(skills: Skills, lang: 'es' | 'en'): string {
  return skills.fallbackReplies[lang].reservationPolicyUnavailable;
}

type CloseStage = 'none' | 'closing_offered' | 'pending_sent';

function inferCloseStage(recentMessages: RecentMessage[]): CloseStage {
  const anchors: Record<'pending_sent' | 'closing_offered', RegExp[]> = {
    pending_sent: [
      /estoy validando disponibilidad/i,
      /I am validating availability/i,
    ],
    closing_offered: [
      /inicie esa validacion|inicie la validacion|quieres que inicie|quieres que la inicie/i,
      /separamos con anticipo|reserva se separa/i,
      /booking is held with|shall I start that validation|shall I start it|start it now/i,
      /validacion ahora|validation now|la inicie ahora/i,
    ],
  };
  for (const msg of recentMessages) {
    if (msg.role !== 'assistant') continue;
    if (anchors.pending_sent.some(r => r.test(msg.content))) return 'pending_sent';
  }
  for (const msg of recentMessages) {
    if (msg.role !== 'assistant') continue;
    if (anchors.closing_offered.some(r => r.test(msg.content))) return 'closing_offered';
  }
  return 'none';
}

function buildDeterministicQuote(
  message: string,
  merged: MergedQualification,
  lang: 'es' | 'en',
  skills: Skills,
  priceRequestContinuation: boolean = false,
): string | null {
  if (!isPriceQuestion(message) && !priceRequestContinuation) return null;
  if (/\b(?:ni[ñn]os?|ni[ñn]as?|children|kids?)\b/i.test(message)) return null;
  if (/\b(?:presupuestos?|ambos|dos\b|\d+\s*presupuestos?|comparar\s+(?:precios?|presupuestos?))\b/i.test(message)) return null;
  if (isExplicitDateDeferral(message)) return null;
  const exp = getActiveExperience(skills);
  if (!isPricingAvailable(exp)) return null;
  const quote = calculatePriceQuote(exp, {
    planId: typeof merged.plan === 'string' ? merged.plan : undefined,
    people: merged.personas,
    transportNeed: typeof merged.transporte === 'string' ? merged.transporte as TransportNeed : undefined,
    includeApiaryCattle: wantsApiaryCattle(message),
  });
  return quote ? formatDeterministicQuoteReply(quote, skills, lang, merged) : null;
}

function buildTransportPriceInquiryReply(
  message: string,
  merged: MergedQualification,
  skills: Skills,
  lang: 'es' | 'en',
): string | null {
  if (!isTransportPriceInquiry(message) || typeof merged.personas !== 'number') return null;
  const exp = getActiveExperience(skills);
  if (!isPricingAvailable(exp)) return null;
  const quote = calculatePriceQuote(exp, {
    planId: typeof merged.plan === 'string' ? merged.plan : undefined,
    people: merged.personas,
    transportNeed: 'from_bogota',
  });
  if (!quote?.transportTotal || quote.total == null) return null;
  return skills.fallbackReplies[lang].transportPriceInquiry
    .replace('{{transportTotal}}', formatCop(quote.transportTotal))
    .replace('{{total}}', formatCop(quote.total))
    .replace('{{people}}', peopleLabel(quote.people, lang))
    .replaceAll('{{currency}}', quote.currency);
}

function instagramUrl(skills: Skills): string {
  return skills.andeanScapes.business.socialLinks?.instagram ?? '';
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
  // sales_phase is engine-owned via inferSalesPhase — ignore LLM sales_phase.
  if (turn.lead.intent) repos.conversation.setLeadIntent(phone, turn.lead.intent);
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

/**
 * Counts how many recent assistant messages start with any of the given texts
 * (matched by prefix, so renamed/translated variants still work as long as the
 * prefix is stable). Used to rotate guard replies and to break response loops.
 */
function countRecentStartsWith(
  recentMessages: RecentMessage[],
  texts: string[],
  prefixLen: number,
): number {
  return recentMessages
    .filter(m => m.role === 'assistant')
    .filter(m => texts.some(t => m.content.startsWith(t.slice(0, prefixLen))))
    .length;
}

const NAME_ASK_PATTERN = /como te llamas|cual es tu nombre|con quien tengo|antes de seguir/i;
const STANDALONE_NAME_BLOCKLIST = /^(?:para|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|enero|febrero|marzo|abril)$/i;

function normalizeShort(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 25);
}

function isTransportNeed(value: unknown): value is TransportNeed {
  return value == null || value === 'own' || value === 'public_bus' || value === 'from_bogota' || value === 'yes';
}

function resolveNameFallback(merged: MergedQualification, message: string, recentMessages: RecentMessage[]): MergedQualification {
  if (merged.nombre) return merged;
  const trimmed = message.trim();
  // Only attempt name extraction for short messages that follow a recent name
  // question. This covers text+image sends where the image caption is the latest
  // outbound, without treating arbitrary short replies as names.
  if (trimmed.split(/\s+/).length > 2) return merged;
  const name = extractStandaloneName(trimmed);
  if (!name || STANDALONE_NAME_BLOCKLIST.test(name)) return merged;
  const nameLower = name.toLowerCase().trim();
  if (nameLower === env.OWNER_NAME.toLowerCase().trim() || nameLower === env.PARTNER_NAME.toLowerCase().trim()) return merged;
  const recentlyAskedName = recentMessages
    .filter(m => m.role === 'assistant')
    .slice(-4)
    .some(m => NAME_ASK_PATTERN.test(m.content));
  return recentlyAskedName ? { ...merged, nombre: name } : merged;
}

function inferPlanFromAssistantMessages(recentMessages: RecentMessage[], skills: Skills): string | null {
  const plans = getPlans(getActiveExperience(skills));
  if (!plans.length) return null;

  const planKeywords = new Map(plans.map(p => [p.id, p.keywords]));
  const assistantTexts = recentMessages
    .filter(m => m.role === 'assistant')
    .slice(-5)
    .map(m => normalizeText(m.content));

  let best: { id: string; score: number } | null = null;
  for (const [id, keywords] of planKeywords.entries()) {
    // Require at least 2 keyword matches across the recent assistant messages
    // to avoid false positives from qualifying questions (e.g. "descanso rural"
    // in askPlan matching the rural plan).
    const total = assistantTexts.reduce((s, text) =>
      s + keywords.reduce((ks, kw) => ks + (text.includes(normalizeText(kw)) ? 1 : 0), 0), 0);
    if (total >= 2 && (!best || total > best.score)) best = { id, score: total };
  }
  return best?.id ?? null;
}

function skipRepeated(candidate: string, recentMessages: RecentMessage[], merged: MergedQualification, fb: FallbackReplies['es']): string {
  const candidateNorm = normalizeShort(candidate);
  const lastAssistant = recentMessages
    .filter(m => m.role === 'assistant')
    .slice(-1)
    .map(m => normalizeShort(m.content));
  if (!lastAssistant.length || lastAssistant[0] !== candidateNorm) return candidate;

  if (merged.nombre == null) return fb.clarifyName;
  if (merged.plan == null) return fb.clarifyPlan;
  if (merged.personas == null) return fb.clarifyPeople;
  if (merged.fecha == null) return fb.clarifyDate;
  if (merged.transporte == null) return fb.clarifyTransport;
  return candidate;
}

function isLowInformationMessage(message: string): boolean {
  const normalized = normalizeForKeywordMatch(message);
  return /^[?¿]+$/.test(message.trim())
    || /^(?:ok|okay|dale|listo|bueno|gracias|thanks|hola|hello|hi|hey)$/.test(normalized);
}

const HOLDING_REPLY_NO_QUESTION = /\b(?:te escribo|te confirmo|quedo atento|en un momento|dejame validar|me encargo|no enviaremos|estoy validando|te respondo en breve|te escribo enseguida|te escribo en un toque|te contactar[aá]|i(?:'| wi)?ll (?:write|confirm|get back|handle|review)|i am already validating)\b/i;

const SOFT_CLOSE_REPLY_NO_QUESTION = /\b(?:sin problema|sin compromiso|abrazos?|cuando quieras retomarl[oa]|me escribes sin compromiso|aqu[ií] estoy|cuando gustes|un abrazos?|no hay problema|no te preocupes|cuando quieras|a tus [oó]rdenes|no problem|whenever you want|reach out any time|feel free to write|here for you|take care|no worries|anytime you like|when you feel like it)\b/i;

function isDeferredDate(fecha: unknown, dateStatus?: MergedQualification['dateStatus']): boolean {
  if (dateStatus === 'deferred' || dateStatus === 'options_offered') return true;
  return typeof fecha === 'string' && (fecha === 'tentative_unknown' || fecha.startsWith('_'));
}

/** Next unknown field only — never re-ask known people/date/transport/name. */
function pickAdvanceQuestion(fb: FallbackReplies['es'], merged: MergedQualification): string {
  const solo = merged.personas === 1;
  const status = merged.dateStatus;
  if (merged.personas == null) return fb.advanceQuestionPeople;
  if (merged.transporte == null) return solo ? fb.advanceQuestionTransportSolo : fb.advanceQuestionTransport;
  if (status === 'deferred') return fb.advanceQuestionDateOnly;
  if (status === 'options_offered') {
    return solo
      ? (fb.advanceQuestionDateOnly)
      : fb.advanceQuestionDateOnly;
  }
  if (status === 'window') return fb.advanceQuestionNextStep;
  if (status === 'unasked' || status == null || status === 'asked' || !isConfirmedDate(merged.fecha)) {
    if (isDeferredDate(merged.fecha, status)) return fb.advanceQuestionDateOnly;
    if (!isConfirmedDate(merged.fecha)) return solo ? fb.quoteNextStepSolo : fb.quoteNextStep;
  }
  if (merged.nombre == null) return solo ? fb.advanceQuestionNameSolo : fb.advanceQuestionName;
  return fb.advanceQuestionNextStep;
}

const INVITES_RESPONSE_WITHOUT_Q = /\b(?:cu[eé]ntame|dime|decime|contame|tell me|let me know|orientarte)\b/i;
const FACTUAL_NO_FORCE_CTA = /\b(?:el equipo (?:confirma|debe|valida)|the team (?:confirms|must|validates)|fractura|fracture|seguridad|safety|recuperando mi dinero|recovering my money|tenemos disponible|we have available)\b/i;

/** Sales replies should end with one advance question, except holds/soft-close/opt-out/factual answers. */
function ensureAdvanceQuestion(
  reply: string,
  fb: FallbackReplies['es'],
  merged: MergedQualification,
): string {
  const trimmed = stripReaskedQuestions(reply, merged).trim();
  if (!trimmed) return reply;
  if (HOLDING_REPLY_NO_QUESTION.test(trimmed)) return trimmed;
  if (SOFT_CLOSE_REPLY_NO_QUESTION.test(trimmed)) return trimmed;
  if (INVITES_RESPONSE_WITHOUT_Q.test(trimmed)) return trimmed;
  if (FACTUAL_NO_FORCE_CTA.test(trimmed)) return trimmed;
  if (/instagram\.com/i.test(trimmed)) return trimmed;
  if (/[?¿]/.test(trimmed)) return trimmed;
  const question = pickAdvanceQuestion(fb, merged);
  return question ? `${trimmed} ${question}`.trim() : trimmed;
}

export async function processMessage(input: ProcessMessageInput): Promise<ProcessMessageOutput> {
  const output = await processMessageCore(input);
  return withConversationState(input.repos, input.customerPhone, output);
}

async function processMessageCore(input: ProcessMessageInput): Promise<ProcessMessageOutput> {
  const { repos, customerPhone, message, messageId, storeInbound = true } = input;

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
    // New conversation: force a fresh fetch of bot-dynamic.json so team edits
    // (pricing/availability/images) apply without a container restart. Best-effort
    // and non-blocking so a slow/unreachable R2 never delays the first reply; the
    // updated cache is then served from the customer's next message onward.
    void refreshSkills(true);
  } else {
    await refreshSkills(false);
  }
  let skills = getSkills();
  const multipleExperiences = hasMultipleExperiences(skills);

  const lang = resolveLanguage(repos, customerPhone, message);
  const normalized = message.toLowerCase().trim();

  if (isAdcodeNoise(message)) {
    return { reply: '', shouldSendReply: false, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  if (repos.optOut.isOptedOut(customerPhone)) {
    return { reply: '', shouldSendReply: false, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  if (isOptOutMessage(message)) {
    if (!repos.optOut.isOptedOut(customerPhone)) repos.optOut.setOptOut(customerPhone);
    return { reply: skills.fallbackReplies[lang].optOutConfirmation, shouldSendReply: true, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
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
  skills = scopeSkillsToExperience(skills, selectedExperienceId);
  const activeExperience = getActiveExperience(skills);

  // ── Follow-up pain reply detection ──────────────────────────────────────
  // When the customer replies after receiving the pain-question follow-up,
  // classify their pain, store it, mark the event replied, bump score,
  // then let LLM reply with pain-specific context suffix.
  const latestFollowUpEvent = repos.followUpEvent.getLatestByPhone(customerPhone);
  const isPainQuestionReply =
    latestFollowUpEvent?.stage === 'pain_question' &&
    latestFollowUpEvent.status === 'sent';

  if (isPainQuestionReply) {
    const detectedPain = detectLeadPain(message);
    const scoreBeforePain = repos.conversation.getLeadScore(customerPhone);
    // Always mark the pain question replied so state stays consistent even when
    // the customer answers off-list; only persist lead_pain when we classify one.
    if (detectedPain) repos.conversation.setLeadPain(customerPhone, detectedPain, message.slice(0, 200));
    repos.conversation.incrementFollowUpReplyCount(customerPhone);
    repos.followUpEvent.markReplied(customerPhone, latestFollowUpEvent.sequenceNumber, scoreBeforePain, detectedPain);
  }
  // ────────────────────────────────────────────────────────────────────────

  // Mark replies to every automated nudge. Legacy pain-question events keep
  // their separate pain classification path above.
  const isAutomatedFollowUpReply = latestFollowUpEvent != null
    && latestFollowUpEvent.stage !== 'pain_question'
    && latestFollowUpEvent.status === 'sent';
  if (isAutomatedFollowUpReply) {
    const scoreNow = repos.conversation.getLeadScore(customerPhone);
    repos.followUpEvent.markReplied(customerPhone, latestFollowUpEvent.sequenceNumber, scoreNow, null);
    repos.conversation.incrementFollowUpReplyCount(customerPhone);
  }
  // ────────────────────────────────────────────────────────────────────────

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

  const policyReply = factualPolicyReply(skills, lang, message);
  if (policyReply && !hasSafetyOverride) {
    return {
      reply: policyReply, shouldSendReply: true, leadScore: repos.conversation.getLeadScore(customerPhone), usedAi: false,
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
    return {
      reply: skills.fallbackReplies[lang].organizerContactReceived,
      shouldSendReply: true,
      leadScore: Math.max(repos.conversation.getLeadScore(customerPhone), skills.salesStrategy.hotLeadThreshold),
      usedAi: false,
      shouldAlertOwner: true,
      ownerAlertType: 'organizer_contact',
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  const ambiguousPartyComparison = isAmbiguousPartyComparison(message);
  const bookingFields = extractBookingFields(message, activeExperience);
  if (futureWindow) {
    delete bookingFields.collected_date;
    delete bookingFields._relative_date_token;
  }
  const contextFields = contextAwareExtract(message, repos, customerPhone, bookingFields, activeExperience);
  if (!contextFields.collected_date) {
    const selectedDate = selectedDateFromAvailabilityReply(message, getLastAssistantQuestion(repos, customerPhone), skills);
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
  if (!experienceSwitched && richCollected.plan && richCollected.plan !== rawCollected.plan) missingFromDb.collected_plan = richCollected.plan;
  if (Object.keys(missingFromDb).length > 0) repos.conversation.upsert(customerPhone, missingFromDb);

  const collectedFields = reconstructFromHistory(repos, customerPhone, getCollectedFields(repos, customerPhone), activeExperience);
  if (experienceSwitched && typeof contextFields.collected_plan !== 'string') delete collectedFields.plan;
  if (activeDateWindow) delete collectedFields.fecha;
  const dbQualification = buildDbQualification(collectedFields);
  const recentMessages = repos.message.getRecentMessages(customerPhone, 21).filter((_, i, arr) => i < arr.length - 1);

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
  if (!hasSafetyOverride && !activeDateWindow && isStandaloneInclusionsQuestion(message, lang)) {
    return fallbackOutput(buildInclusionsReply(skills, lang));
  }
  if (!hasSafetyOverride && /\b(?:precio|valor|cuesta).{0,50}\bdepende.{0,50}\bfecha|\bdepende.{0,50}\bfecha/i.test(message)) {
    return fallbackOutput(skills.fallbackReplies[lang].priceDependsOnGroup);
  }
  if (!hasSafetyOverride && /\b(?:precios?|valores?).{0,40}\b(?:fechas?|disponibilidad)|\b(?:fechas?|disponibilidad).{0,40}\b(?:precios?|valores?)/i.test(message)
    && !/\b(?:mina|minera|minero|esmeralda|emerald|mining|chivor|hacienda|apicultura|ganader[ií]a)\b/i.test(message)
    && !isExplicitDateDeferral(message)) {
    return fallbackOutput(skills.fallbackReplies[lang].priceAndDatesIntro);
  }
  if (!hasSafetyOverride
    && /\b(?:el precio (?:nos |me )?sirve|the price works)\b/i.test(message)
    && isConfirmedDate(dbQualification.fecha)
    && hasPublicPaymentFacts(skills)) {
    const facts = getPublicPaymentFacts(skills);
    return {
      ...fallbackOutput(skills.fallbackReplies[lang].priceAcceptedReservation
        .replace('{{deposit}}', String(facts.depositPercent))
        .replace('{{date}}', displayDate(dbQualification.fecha, lang))),
      reservationReady: detectsReservationIntent(message),
    };
  }
  if (!hasSafetyOverride && customerContext.childAges?.[0] != null) {
    return fallbackOutput(skills.fallbackReplies[lang].childSuitabilityBoundary.replace('{{age}}', String(customerContext.childAges[0])));
  }
  if (!hasSafetyOverride
    && /\b(?:c[oó]mo\s+(?:hago|hacemos|hacer).{0,30}reserv)/i.test(message)
    && dbQualification.personas != null
    && isConfirmedDate(dbQualification.fecha)
    && hasPublicPaymentFacts(skills)) {
    const facts = getPublicPaymentFacts(skills);
    return {
      ...fallbackOutput(skills.fallbackReplies[lang].reservationImmediate.replace('{{deposit}}', String(facts.depositPercent))),
      reservationReady: true,
    };
  }
  if (!hasSafetyOverride && isPlanListQuestion(message)) {
    return fallbackOutput(buildPlansListReply(skills, lang));
  }
  {
    const dateStatusNow = repos.conversation.getDateStatus(customerPhone);
    const lastQForDate = getLastAssistantQuestion(repos, customerPhone);
    const otherExplicitQuestion = isPlanListQuestion(message)
      || isStandaloneInclusionsQuestion(message, lang)
      || hasActionableUserQuestion(message)
      || isPriceQuestion(message);
    const dateDeferredNow = !otherExplicitQuestion && (
      isExplicitDateDeferral(message)
      || ((dateStatusNow === 'asked' || isDateAskQuestion(lastQForDate)) && isUncertainDateAnswer(message))
    );
    if (!hasSafetyOverride && dateDeferredNow) {
      const optionsRequested = isDateOptionsRequest(message);
      if (optionsRequested) repos.conversation.setDateOptionsOffered(customerPhone);
      else repos.conversation.setDateDeferred(customerPhone);
      // refresh local qual snapshot for CTA selection
      dbQualification.dateStatus = repos.conversation.getDateStatus(customerPhone);
      dbQualification.fecha = 'tentative_unknown';
      if (optionsRequested) {
        if (needsPlanBeforeDates(skills, dbQualification.plan, { priceGiven: !!repos.conversation.getPriceGivenAt(customerPhone) })) {
          return fallbackOutput(buildPlansListReply(skills, lang), { outboundDateAction: undefined });
        }
        const availabilityReply = buildAvailabilityListReply(skills, lang);
        if (availabilityReply) return fallbackOutput(availabilityReply, { outboundDateAction: 'options_offered' });
      }
      return fallbackOutput(skills.fallbackReplies[lang].dateOptionsOffer, { outboundDateAction: 'options_offered' });
    }
    // Already deferred/options + thin ping ("?", "ok") → acknowledge without re-asking date.
    if (!hasSafetyOverride
      && (dateStatusNow === 'deferred' || dateStatusNow === 'options_offered' || isDeferredDate(dbQualification.fecha, dateStatusNow))
      && isLowInformationMessage(message)) {
      return fallbackOutput(skills.fallbackReplies[lang].dateDeferredAcknowledgement);
    }
  }
  if (!hasSafetyOverride && isDynamicDataFresh() && customerContext.transport === 'own_motorcycle' && dbQualification.personas != null && isConfirmedDate(dbQualification.fecha)) {
    const motoPrice = calculatePriceQuote(getActiveExperience(skills), {
      planId: typeof dbQualification.plan === 'string' ? dbQualification.plan : undefined,
      people: dbQualification.personas,
      transportNeed: isTransportNeed(dbQualification.transporte) ? dbQualification.transporte : undefined,
    });
    const motoPriceLine = motoPrice
      ? skills.fallbackReplies[lang].quoteTotal
        .replace('{{total}}', formatCop(motoPrice.total ?? motoPrice.planTotal))
        .replace('{{currency}}', motoPrice.currency).trimStart()
      : '';
    const motoBase = skills.fallbackReplies[lang].motorcycleContext
      .replace('{{people}}', String(dbQualification.personas))
      .replaceAll('{{date}}', displayDate(dbQualification.fecha, lang));
    const motoQuestionSuffix = skills.fallbackReplies[lang].motorcycleAvailabilityCta;
    const motoReply = motoBase.replace(/¿Revisamos un fin de semana de[^?]*\?/, motoQuestionSuffix);
    return fallbackOutput(motoPriceLine ? motoReply.replace('La ruta', `${motoPriceLine}La ruta`) : motoReply);
  }
  if (!hasSafetyOverride && /\b(?:todav[ií]a hay cupo|a[uú]n hay cupo|hay cupo)\b/i.test(message)) {
    const rawDate = customerContext.date ?? (isConfirmedDate(dbQualification.fecha) ? dbQualification.fecha : null);
    const date = rawDate ?? (lang === 'es' ? 'esa fecha' : 'that date');
    return fallbackOutput(skills.fallbackReplies[lang].availabilityVerification.replace('{{date}}', displayDate(date, lang)));
  }
  if (!hasSafetyOverride && /\b(?:por ese precio no|por ese valor no)\b/i.test(message)) {
    return fallbackOutput(
      dbQualification.personas === 1
        ? skills.fallbackReplies[lang].priceObjectionBusAlternative
        : skills.fallbackReplies[lang].priceObjectionAlternative,
    );
  }
  if (!hasSafetyOverride && dbQualification.personas === 1 && /\b(?:muy caro|demasiado caro)\b/i.test(message)) {
    return fallbackOutput(skills.fallbackReplies[lang].priceObjectionBusAlternative);
  }
  const transportPriceAskedAfterChoice = isTransportPriceInquiry(message)
    && wasAskedTransport(getLastAssistantQuestion(repos, customerPhone));
  if (!hasSafetyOverride && isDynamicDataFresh() && (dbQualification.transporte == null || (transportPriceAskedAfterChoice && !hasExplicitOwnTransport(message)))) {
    if (transportPriceAskedAfterChoice && dbQualification.transporte != null) {
      repos.conversation.clearCollectedTransport(customerPhone);
    }
    const transportPriceReply = buildTransportPriceInquiryReply(message, dbQualification, skills, lang);
    if (transportPriceReply) return fallbackOutput(transportPriceReply);
  }
  if (!hasSafetyOverride
    && dbQualification.transporte == null
    && !isPriceQuestion(message)
    && !detectsReservationIntent(message)
    && isAmbiguousTransportRequest(message)) {
    return {
      reply: skills.fallbackReplies[lang].clarifyTransportMode,
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
  // Single source of truth for gallery dedup: the gallery is offered at most once
  // per customer. Every automatic send path below reuses this flag so we never
  // spam the same gallery across decline/handoff/consult turns.
  const galleryAlreadyNudged = hasGalleryNudge(repos, customerPhone);

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

  const lastAssistantQuestion = getLastAssistantQuestion(repos, customerPhone);
  const conversationMode = repos.conversation.getMode(customerPhone);
  const galleryRequested = isGalleryRequest(message) || isGalleryConfirmation(message, lastAssistantQuestion);

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
  // Replying after a follow-up pain question counts as re-engagement — but only
  // when the revealed pain is not an objection. A price/security/consult answer
  // is a blocker, not buying intent, so forcing the re-engage score bump (and the
  // gallery auto-send it can trigger) would feel pushy.
  const painQuestionPain = isPainQuestionReply ? detectLeadPain(message) : null;
  if (isPainQuestionReply && !(painQuestionPain && NON_REENGAGEMENT_PAINS.has(painQuestionPain))) {
    isReEngagement = true;
  }
  if (softClosedAt) {
    if (hasSafetyOverride || isReEngagementMessage(message) || galleryRequested) {
      isReEngagement = true;
      repos.conversation.clearSoftClosed(customerPhone);
    } else {
      return { reply: '', shouldSendReply: false, leadScore: currentScore, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
  }

  // Explicit customer request for photos bypasses the once-per-customer dedup:
  // if they ask again, we honor it. Only automatic nudges are deduped.
  if (!hasSafetyOverride && galleryRequested) {
    const selectedPlan = getPlans(getActiveExperience(skills)).find(plan => plan.id === dbQualification.plan);
    const planDuration = selectedPlan?.duration ?? (lang === 'es' ? 'la experiencia' : 'experience');
    return { reply: skills.fallbackReplies[lang].galleryIntro.replace('{{planDuration}}', planDuration), shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: true, shouldSendImage: false, priceJustGiven: false };
  }

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
    // Alert-only under limit: never auto-mute. Only /bridge silences the bot.
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

  if (!hasSafetyOverride && preLimitPriceRow && isReviewPause(message) && !/[?¿]|\b(?:que|qué|como|cómo|cual|cuál|where|what|how)\b/i.test(message)) {
    if (isPartnerConsultPause(message) && /\b(?:consulto|consultarlo|consultar[eé]|lo consulto|lo consult[eé]|consult|consults?)\b/i.test(message) && !isCustomerFollowUpPromise(message)) {
      const pcName = typeof dbQualification.nombre === 'string' ? dbQualification.nombre.trim() : '';
      const pcPlan = getPlans(getActiveExperience(skills)).find(p => p.id === (typeof dbQualification.plan === 'string' ? dbQualification.plan : undefined));
      const pcExpSummary = pcPlan?.shortDescription ?? getShortDescription(getActiveExperience(skills));
      let pcPriceLine = '';
      if (typeof dbQualification.personas === 'number') {
        const pcQuote = calculatePriceQuote(getActiveExperience(skills), {
          planId: typeof dbQualification.plan === 'string' ? dbQualification.plan : undefined,
          people: dbQualification.personas,
          transportNeed: isTransportNeed(dbQualification.transporte) ? dbQualification.transporte : undefined,
        });
        if (pcQuote) {
          pcPriceLine = skills.fallbackReplies[lang].quoteTotal
            .replace('{{total}}', formatCop(pcQuote.total ?? pcQuote.planTotal))
            .replace('{{currency}}', pcQuote.currency)
            .trim();
        }
      }
      const pcFilled = skills.fallbackReplies[lang].partnerConsultSummary
        .replace('{{name}}', pcName)
        .replace('{{experienceSummary}}', pcExpSummary)
        .replace('{{priceLine}}', pcPriceLine);
      const pcReply = pcName ? pcFilled : pcFilled.replace(/^(\w+)\s+,/, '$1');
      return fallbackOutput(pcReply);
    }
    return { reply: skills.fallbackReplies[lang].reviewPauseAcknowledgement, shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  if (!hasSafetyOverride && preLimitPriceRow && isPartnerConsultPause(message) && !/[?¿]/.test(message)) {
    const name = typeof dbQualification.nombre === 'string' ? dbQualification.nombre.trim() : '';
    const plan = getPlans(getActiveExperience(skills)).find(p => p.id === (typeof dbQualification.plan === 'string' ? dbQualification.plan : undefined));
    const experienceSummary = plan?.shortDescription ?? getShortDescription(getActiveExperience(skills));
    let priceLine = '';
    if (typeof dbQualification.personas === 'number') {
      const priceQuote = calculatePriceQuote(getActiveExperience(skills), {
        planId: typeof dbQualification.plan === 'string' ? dbQualification.plan : undefined,
        people: dbQualification.personas,
        transportNeed: isTransportNeed(dbQualification.transporte) ? dbQualification.transporte : undefined,
      });
      if (priceQuote) {
        priceLine = lang === 'es'
          ? `Precio revisado: $ ${formatCop(priceQuote.total ?? priceQuote.planTotal)} COP.`
          : `Reviewed price: $ ${formatCop(priceQuote.total ?? priceQuote.planTotal)} COP.`;
      }
    }
    const filledReply = skills.fallbackReplies[lang].partnerConsultSummary
      .replace('{{name}}', name)
      .replace('{{experienceSummary}}', experienceSummary)
      .replace('{{priceLine}}', priceLine);
    // Template starts "Dale {{name}}, ..." — without a name, drop the dangling comma.
    const reply = name ? filledReply : filledReply.replace(/^(\w+)\s+,/, '$1');
    return fallbackOutput(reply);
  }

  const budget = checkBudget(repos, customerPhone);
  if (!budget.aiAllowed) {
    logger.warn({ reason: budget.reason }, '[AI] budget blocked');
    void reportAiBudgetBlocked(budget.reason ?? 'unknown');
    if (safetyOverrideReply) {
      return { reply: safetyOverrideReply, shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: true, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
    // A pain-question reply gets its grounded deterministic answer even when the
    // AI budget is exhausted, so the lead is not left with a generic holding message.
    const painFallback = isPainQuestionReply ? detectLeadPain(message) : null;
    const painReply = painFallback ? getPainFallbackReply(painFallback, lang) : null;
    if (painReply) {
      return { reply: painReply, shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: true, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
    activateHumanFallback(repos, customerPhone);
    return { reply: skills.fallbackReplies[lang].aiBudgetExhausted, shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: true, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
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

  if (!hasSafetyOverride && isDirectAvailabilityListQuestion(message)) {
    if (needsPlanBeforeDates(skills, dbQualification.plan, { priceGiven: !!repos.conversation.getPriceGivenAt(customerPhone) })) {
      return fallbackOutput(buildPlansListReply(skills, lang), { outboundDateAction: undefined });
    }
    const availabilityReply = buildAvailabilityListReply(skills, lang);
    if (availabilityReply) {
      return fallbackOutput(availabilityReply, { outboundDateAction: 'options_offered' });
    }
  }

  const salesPhase = repos.conversation.getSalesPhase(customerPhone);
  const safeCollected = sanitizeCollectedFields(collectedFields, skills.fallbackReplies[lang].internalDatePending);
  if (activeDateWindow) safeCollected.datePreference = activeDateWindow;
  const systemPrompt = buildSystemPrompt(skills, lang, safeCollected, salesPhase ?? undefined, extractCustomerContext(message), repos.conversation.getSelectedExperienceId(customerPhone));
  const llmHistory = recentMessages.map(m => ({ role: m.role, content: m.content }));
  const llmMessage = message.length > MAX_INBOUND_CHARS ? message.slice(0, MAX_INBOUND_CHARS) : message;

  // If this is a pain reply, inject pain-specific suffix so LLM responds precisely.
  const knownPain = isPainQuestionReply ? detectLeadPain(message) : repos.conversation.getLeadPain(customerPhone);
  const painSuffix = knownPain ? buildPainSystemPromptSuffix(knownPain, lang) : undefined;

  // ── Short numeric reply context hint ────────────────────────────────────
  // When the customer replies with a short number after a quant-question,
  // annotate the message so the LLM interprets it in context (group size,
  // date ordinal, plan option), not as hesitation.
  const isShortNumeric = /^\d{1,3}$/.test(llmMessage.trim());
  const lastAssistantMsg = recentMessages.filter(m => m.role === 'assistant').slice(-1)[0]?.content ?? '';
  const askedQuantity = /cu[aá]nt|how many|fecha|date|month|mes|plan|opci[oó]n|option|cu[aá]l|which/i.test(lastAssistantMsg);
  const enrichedMessage = isShortNumeric && askedQuantity
    ? `${llmMessage}\n\n[Context: The customer replied with a short number. Interpret it in context of the last assistant question. Do not assume hesitation or dismissal.]`
    : llmMessage;
  // ──────────────────────────────────────────────────────────────────────────

  let replyUsageRecorded = false;
  const llmResult = await llmClient.complete({
    systemPrompt,
    systemPromptSuffix: painSuffix,
    message: enrichedMessage,
    history: llmHistory,
    lang,
    onAttempt: attempt => {
      replyUsageRecorded = true;
      const cost = attempt.tokens.prompt * INPUT_COST_PER_TOKEN + attempt.tokens.completion * OUTPUT_COST_PER_TOKEN;
      repos.aiUsage.recordUsage({ phone: customerPhone, model: env.DEEPSEEK_MODEL, promptTokens: attempt.tokens.prompt, completionTokens: attempt.tokens.completion, cachedTokens: 0, estimatedCost: cost, purpose: 'reply', success: attempt.success, errorType: attempt.success ? null : 'completion_failed' });
    },
  });

  if (!llmResult) {
    logger.warn('[LLM] DeepSeek call failed, sending minimal fallback');
    const painFallback = isPainQuestionReply ? detectLeadPain(message) : null;
    const painReply = painFallback ? getPainFallbackReply(painFallback, lang) : null;
    const fieldCount = [collectedFields?.nombre, collectedFields?.personas, collectedFields?.fecha].filter(v => v != null).length;
    const isNearClosing = fieldCount >= 3;
    const fallbackText: string = safetyOverrideReply
      ?? painReply
      ?? (isNearClosing
        ? skills.fallbackReplies[lang].aiFailureQualified
        : (collectedFields?.nombre
          ? (skills.fallbackReplies[lang].llmFailureWarm?.replace('{{name}}', String(collectedFields.nombre)) ?? skills.fallbackReplies[lang].aiFailureQualified)
          : skills.fallbackReplies[lang].aiFailureQualified));
    return {
      reply: fallbackText, shouldSendReply: true,
      leadScore: currentScore, usedAi: true, shouldAlertOwner: hasAnyQualificationData(dbQualification),
      shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false,
    };
  }

  const llmTurn = llmResult.turn;
  if (!replyUsageRecorded) {
    const estimatedCost = llmResult.tokens.prompt * INPUT_COST_PER_TOKEN + llmResult.tokens.completion * OUTPUT_COST_PER_TOKEN;
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
  const deferredDateLowInformation = merged.fecha === 'tentative_unknown' && isLowInformationMessage(message);

  // ── LLM-powered lead analysis (separate scoring call) ───────────────────
  // Gated behind the budget guard: the analyzer is a second DeepSeek call, so
  // it must respect daily/monthly USD budgets and per-customer/global call caps.
  // The reply call already recorded its usage row, so re-checking here reflects
  // the just-consumed budget. When budget is tight we skip analysis (score
  // unchanged) rather than overspend.
  const prePriceRow = repos.conversation.getPriceGivenAt(customerPhone);
  const analysisBudget = checkBudget(repos, customerPhone);
  let analysis: LeadAnalysis | null = null;
  let analysisUsageRecorded = false;
  if (analysisBudget.aiAllowed) {
    analysis = await analyzeLead({
      latestMessage: message,
      history: recentMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      currentScore,
      salesPhase,
      collectedFields: safeCollected as Record<string, unknown>,
      priceGiven: !!prePriceRow,
      isFollowUpReply: isAutomatedFollowUpReply,
      isPainQuestionReply,
      lastAssistantQuestion,
      lang,
      onAttempt: attempt => {
        analysisUsageRecorded = true;
        const cost = attempt.tokens.prompt * INPUT_COST_PER_TOKEN + attempt.tokens.completion * OUTPUT_COST_PER_TOKEN;
        repos.aiUsage.recordUsage({ phone: customerPhone, model: env.DEEPSEEK_MODEL, promptTokens: attempt.tokens.prompt, completionTokens: attempt.tokens.completion, cachedTokens: 0, estimatedCost: cost, purpose: 'lead_analysis', success: attempt.success, errorType: attempt.success ? null : 'analysis_failed' });
      },
    });
    if (!analysisUsageRecorded) {
      const tokens = analysis
        ? { prompt: analysis.promptTokens, completion: analysis.completionTokens }
        : { prompt: 0, completion: 0 };
      const cost = tokens.prompt * INPUT_COST_PER_TOKEN + tokens.completion * OUTPUT_COST_PER_TOKEN;
      repos.aiUsage.recordUsage({ phone: customerPhone, model: env.DEEPSEEK_MODEL, promptTokens: tokens.prompt, completionTokens: tokens.completion, cachedTokens: 0, estimatedCost: cost, purpose: 'lead_analysis', success: analysis !== null, errorType: analysis ? null : 'analysis_failed' });
    }
  } else {
    logger.warn({ phone: customerPhone, reason: analysisBudget.reason }, '[LEAD_ANALYZER] skipped — budget guard');
  }

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
    logger.warn({ phone: customerPhone }, '[LEAD_ANALYZER] unavailable — keeping current score');
    llmLeadInput = {
      intent: 'curious',
      scoreDelta: 0,
      confidence: 0,
      buyingSignals: [],
      blockers: [],
    };
  }
  const hybrid = computeHybridScore(currentScore, llmLeadInput, regexScore.score, isReEngagement, skills.salesStrategy.hotLeadThreshold);
  repos.conversation.upsert(customerPhone, { lead_score: hybrid.score });
  if (analysis) repos.conversation.setLeadIntent(customerPhone, analysis.intent);

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

  let replyText = llmTurn.reply || '';
  replyText = stripHandoffPhrases(replyText);
  replyText = stripReaskedQuestions(replyText, merged);
  replyText = enforceMicroQuestionFirstContact(replyText, isFirstContact, lang);

  // ── Plan inference from customer message ────────────────────────────────
  // When the DB has no collected_plan but the customer's message clearly picks
  // one (ordinal, duration), persist it. Never infer plan from assistant text.
  if (merged.plan == null) {
    const userPlan = detectPlan(message, activeExperience);
    if (userPlan) {
      repos.conversation.upsert(customerPhone, { collected_plan: userPlan });
      merged = { ...merged, plan: userPlan };
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Self-intro guard ────────────────────────────────────────────────────
  // When the conversation already has qualification data, the LLM must NOT
  // re-introduce itself. Engine-level defense against prompt drift.
  const qualFieldCountForIntro = [merged.nombre, merged.personas, merged.fecha, merged.transporte].filter(v => v != null).length;
  if (qualFieldCountForIntro >= 2) {
    replyText = stripSelfIntro(replyText, qualFieldCountForIntro);
  }
  // ──────────────────────────────────────────────────────────────────────────

  const exp = getActiveExperience(skills);
  const pricingAvailable = isPricingAvailable(exp);
  if (
    !pricingAvailable
    && replyText.trim()
    && !containsPromptLeakOrPolicyViolation(replyText)
    && replyMentionsPrice(replyText)
  ) {
    replyText = typeof merged.personas === 'number'
      ? skills.fallbackReplies[lang].priceUnavailableKnownGroup
        .replace('{{people}}', String(merged.personas))
        .replace('{{dateClause}}', merged.fecha ? ` para ${displayDate(merged.fecha, lang)}` : '')
      : skills.fallbackReplies[lang].priceUnavailable;
    llmTurn.img = false;
  }
  const priceRequestContinuation = isPriceRequestContinuation(recentMessages, contextFields.collected_people);
  const priceUnlocked = !!prePriceRow || canPresentFirstPrice(message, merged) || priceRequestContinuation;

  let deterministicQuote: string | null = null;
  let usedStartingPriceTeaser = false;
  if (priceUnlocked) {
    deterministicQuote = buildDeterministicQuote(message, merged, lang, skills, priceRequestContinuation);

    // Calculator is source of truth. Always wrap numbers in the value package.
    // Skip override when price already given — re-engagement, not first present.
    if (!prePriceRow && !deterministicQuote && typeof merged.personas === 'number' && replyMentionsPrice(replyText) && pricingAvailable
      && !/\b(?:ni[ñn]os?|ni[ñn]as?|children|kids?)\b/i.test(message)
      && !/\b(?:presupuestos?|ambos|\d+\s*presupuestos?|comparar\s+(?:precios?|presupuestos?))\b/i.test(message)
      && !isExplicitDateDeferral(message)) {
      const priceOverrideQuote = calculatePriceQuote(exp, {
        planId: typeof merged.plan === 'string' ? merged.plan : undefined,
        people: merged.personas,
        transportNeed: isTransportNeed(merged.transporte) ? merged.transporte : undefined,
        includeApiaryCattle: wantsApiaryCattle(message),
      });
      if (priceOverrideQuote) deterministicQuote = formatDeterministicQuoteReply(priceOverrideQuote, skills, lang, merged);
    }
  } else if (isPriceQuestion(message) || replyMentionsPrice(replyText)) {
    // Group size is unknown: give a truthful starting value, then ask one question.
    const teaser = buildPriceGateTeaser(skills, lang, typeof merged.plan === 'string' ? merged.plan : undefined);
    if (teaser) {
      replyText = recentMessages.some(message => message.role === 'assistant' && message.content === teaser)
        ? skipRepeated(nextQualificationQuestion(merged, skills.fallbackReplies[lang]), recentMessages, merged, skills.fallbackReplies[lang])
        : teaser;
      usedStartingPriceTeaser = replyText === teaser;
    }
    llmTurn.img = false;
  }

  // Deterministic price gate: strip any price numbers the LLM may have produced
  // when the engine decided price should not be unlocked yet.
  if (!priceUnlocked && pricingAvailable && !usedStartingPriceTeaser) {
    replyText = stripPriceText(replyText);
  }

  const usedDeterministicQuote = deterministicQuote != null;
  if (deterministicQuote) {
    replyText = frameDeterministicQuote(replyText, deterministicQuote, skills.fallbackReplies[lang]);
    llmTurn.img = false;
    // Never invent collected_plan from catalog default — only customer/detectPlan may set it.
  }

  const lateMonthAvailabilityReply = buildLateMonthAvailabilityReply(skills, lang, message);
  if (safetyOverrideReply) {
    replyText = safetyOverrideReply;
    usedStartingPriceTeaser = false;
    llmTurn.img = false;
  } else if (ambiguousPartyComparison) {
    const knownPlan = getCollectedFields(repos, customerPhone).plan ?? merged.plan;
    replyText = buildPartyComparisonReply(skills, lang, typeof knownPlan === 'string' ? knownPlan : null);
    usedStartingPriceTeaser = false;
    llmTurn.img = false;
  } else if (isStandaloneInclusionsQuestion(message, lang)) {
    replyText = buildInclusionsReply(skills, lang);
    usedStartingPriceTeaser = false;
    llmTurn.img = false;
  } else if (isAvailabilityRecommendQuestion(message)) {
    replyText = buildAvailabilityRecommendReply(skills, lang, merged, message);
    usedStartingPriceTeaser = false;
    llmTurn.img = false;
  }

  replyText = ensureRequestedInclusionCoverage(replyText, message, skills, lang);

  replyText = scrubInternalLeakTokens(replyText, skills.fallbackReplies[lang].internalDatePending);

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

  const initialPriceJustGiven = !usedStartingPriceTeaser && replyMentionsPrice(replyText);

  // Only mark price as officially given when enough qualification exists.
  // Prevents the unlock chain where an LLM price leak at turn 1 unblocks
  // the deterministic quote gate at turn 3 with only 1 field.
  const priceQualFields = [merged.nombre, merged.plan, merged.personas, merged.fecha, merged.transporte]
    .filter(v => v != null).length;
  const msgPriceFields = extractBookingFields(message);
  const msgPriceExtra = [msgPriceFields.collected_people, msgPriceFields.collected_date, msgPriceFields.collected_transport_need]
    .filter(v => v != null).length;
  const mergedPriceExtra = [merged.plan, merged.fecha, merged.transporte].filter(v => v != null).length;
  const legalPrice = (mergedPriceExtra + msgPriceExtra) >= 1 || isConfirmedDate(merged.fecha) || merged.transporte != null;

  const pricePresented = !!((initialPriceJustGiven && legalPrice) || prePriceRow);

  if (initialPriceJustGiven && !prePriceRow) {
    if (legalPrice) {
      repos.conversation.upsert(customerPhone, { price_given_at: new Date().toISOString() });
    } else {
      // Price leaked through — strip it and don't mark as given.
      replyText = stripPriceText(replyText);
      logger.info({ phone: customerPhone, fieldCount: priceQualFields + msgPriceExtra + 1 }, '[BOT] price stripped — insufficient qualification');
    }
  }

  // ── Phase progression (inferred, not LLM-dependent) ──────────────────────
  // The LLM runs in plain-text mode so the structured sales_phase field always
  // defaults to "discovery". Infer the real phase from conversation state so
  // the next turn's prompt context includes the correct phase.
  const inferredPhase = inferSalesPhase(merged, pricePresented, replyText, message, currentScore, isFirstContact);
  if (inferredPhase && inferredPhase !== salesPhase) {
    repos.conversation.setSalesPhase(customerPhone, inferredPhase);
  }
  // ──────────────────────────────────────────────────────────────────────────

  let needsHumanEffective = false;
  let finalScore = hybrid.score;
  let shouldSendGallery = false;
  let unsafeReservationBlocked = false;
  let deflectionDueToPolicyLeak = false;

  const qComplete = isQualificationComplete(merged);
  const reservationIntent = isReservationIntentOrConfirmation(message, lastAssistantQuestion);
  const recentReservation = recentMessages
    .filter(m => m.role === 'user')
    .slice(-6)
    .some(m => detectsReservationIntent(m.content));
  // Trust the LLM's structured booking signal instead of growing regex coverage.
  // The model already classifies booking readiness; this catches phrasings the
  // deterministic patterns miss (e.g. confirming the bot's own soft-close question).
  const llmReadyToBook = llmTurn.action === 'handoff' || llmTurn.lead.intent === 'ready_to_book';

  const paymentQ = isPaymentMethodsQuestion(message);
  const availabilityConfirm = detectsAvailabilityConfirmRequest(message);
  const closeIntent = reservationIntent || recentReservation || llmReadyToBook || availabilityConfirm;
  if (reservationIntent || availabilityConfirm) {
    repos.conversation.setLeadIntent(customerPhone, 'ready_to_book');
  }
  const closeStage = inferCloseStage(recentMessages);
  const paymentFacts = getPublicPaymentFacts(skills);
  const hasConfirmedDate = isConfirmedDate(merged.fecha);
  const hasCoreBooking = merged.personas != null && hasConfirmedDate;
  const wantsNextStep = /\b(?:qu[eé]\s+sigue|what(?:'s|\s+is)\s+next|s[ií]\s+me\s+interesa)\b/i.test(message);

  // ── Closing delay guard: replace passive postponement with direct close ────
  if (!hasSafetyOverride && qComplete && pricePresented && closeIntent && containsClosingDelay(replyText)) {
    replyText = buildCloseReply(skills, lang, merged, 'closing', paymentFacts);
    needsHumanEffective = true;
    shouldSendGallery = false;
    llmTurn.img = false;
    finalScore = Math.max(hybrid.score, skills.salesStrategy.urgentLeadThreshold);
    repos.conversation.upsert(customerPhone, { lead_score: finalScore });
    logger.info({ phone: customerPhone, delayReplaced: true }, '[BOT] closing delay replaced with direct close');
  }

  // ── Payment methods question: public facts + owner alert ────
  // High commercial intent. Sets human_pending (bot still answers; agent must
  // /bridge for exclusive control). Never expose phone numbers / payment links.
  if (!hasSafetyOverride && paymentQ && (pricePresented || conversationMode === 'human_pending')) {
    if (conversationMode === 'human_pending') {
      replyText = skills.fallbackReplies[lang].humanPendingPaymentAck
        .replaceAll('{{methods}}', formatMethods(paymentFacts.methodNames, lang))
        .replaceAll('{{deposit}}', String(paymentFacts.depositPercent))
        .replaceAll('{{date}}', displayDate(merged.fecha, lang));
    } else if (/\b(?:de qu[eé] forma|por partes|se paga todo)\b/i.test(message)) {
      const quote = calculatePriceQuote(getActiveExperience(skills), {
        planId: typeof merged.plan === 'string' ? merged.plan : undefined,
        people: merged.personas,
        transportNeed: isTransportNeed(merged.transporte) ? merged.transporte : undefined,
      });
      const methodsList = formatMethods(paymentFacts.methodNames, lang);
      if (!quote) {
        replyText = buildCloseReply(skills, lang, merged, 'payment_methods', paymentFacts);
      } else {
        const depositAmount = Math.round((quote.requiresTransportConfirmation ? quote.planTotal : (quote.total ?? quote.planTotal)) * paymentFacts.depositPercent / 100);
        replyText = skills.fallbackReplies[lang].installmentPaymentReply
          .replace('{{deposit}}', String(paymentFacts.depositPercent))
          .replace('{{depositAmount}}', formatCop(depositAmount))
          .replace('{{currency}}', quote.currency)
          .replaceAll('{{methods}}', methodsList);
        if (quote.requiresTransportConfirmation) {
          replyText += skills.fallbackReplies[lang].quoteTransportConfirm;
        }
      }
    } else {
      replyText = buildCloseReply(skills, lang, merged, 'payment_methods', paymentFacts);
    }
    needsHumanEffective = true;
    shouldSendGallery = false;
    llmTurn.img = false;
    finalScore = Math.max(hybrid.score, skills.salesStrategy.urgentLeadThreshold);
    repos.conversation.upsert(customerPhone, { lead_score: finalScore });
    logger.info({
      phone: customerPhone,
      paymentQ,
      closeIntent,
      qComplete: isQualificationComplete(merged),
      paymentEscalation: true,
    }, '[BOT] payment methods reply sent');
  }

  // ── Reservation / close intent → human_pending ──────────────────
  // - Full qual + price + (analyzer ready OR analyzer down + close intent)
  // - Availability confirm only when core booking + plan (or price already shown)
  // Does not mute bot; agent /bridge still required for exclusive control.
  const deterministicBridgeFallback = analyzerUnavailable && closeIntent;
  const strongAvailabilityConfirm = availabilityConfirm
    && hasCoreBooking
    && (merged.plan != null || pricePresented || qComplete);
  const canEnterHumanPending =
    (qComplete && pricePresented && (shouldBridgeByScore || deterministicBridgeFallback))
    || strongAvailabilityConfirm
    || (reservationIntent && pricePresented && !hasConfirmedDate)
    || (reservationIntent && qComplete && pricePresented);
  const policyFactsAvailable = hasPublicPaymentFacts(skills);
  if (!hasSafetyOverride && closeIntent && !policyFactsAvailable) {
    replyText = buildReservationPolicyUnavailableReply(skills, lang);
    needsHumanEffective = true;
    llmTurn.img = false;
  } else if (!hasSafetyOverride && canEnterHumanPending) {
    if (!hasConfirmedDate) {
      replyText = skills.fallbackReplies[lang].reservationDateNeeded;
    } else if (closeStage === 'pending_sent') {
      replyText = buildCloseAck(skills, lang, merged);
    } else {
      const kind: CloseKind = closeStage === 'closing_offered' ? 'pending_owner' : (paymentQ ? 'payment_methods' : 'closing');
      replyText = buildCloseReply(skills, lang, merged, kind, paymentFacts);
    }
    needsHumanEffective = true;
    shouldSendGallery = false;
    llmTurn.img = false;
    finalScore = Math.max(hybrid.score, skills.salesStrategy.urgentLeadThreshold);
    repos.conversation.upsert(customerPhone, { lead_score: finalScore });
    logger.info({
      phone: customerPhone,
      score: finalScore,
      intent: analysis?.intent,
      readiness: analysis?.reservationReadiness,
      fallback: deterministicBridgeFallback,
      availabilityConfirm: strongAvailabilityConfirm,
    }, '[BOT] reservation human_pending triggered');
  } else if (!hasSafetyOverride && qComplete && pricePresented && closeIntent) {
    logger.warn({
      phone: customerPhone,
      qComplete,
      pricePresented,
      score: hybrid.score,
      threshold: env.BRIDGE_SCORE_THRESHOLD,
      intent: analysis?.intent,
      readiness: analysis?.reservationReadiness,
    }, '[BOT] reservation intent detected but analyzer score below bridge threshold — bot continues');
  }

  // ── Unsafe reservation claim: block LLM but close deterministically ─────
  if (containsUnsafeReservationClaim(replyText)) {
    logger.warn({ phone: customerPhone }, '[BOT] blocked unsafe reservation claim');
    unsafeReservationBlocked = true;
    shouldSendGallery = false;
    llmTurn.img = false;
    if (pricePresented && (isQualificationComplete(merged) || [merged.nombre, merged.personas, merged.fecha, merged.transporte].filter(v => v != null).length >= 3)) {
      if (closeStage === 'pending_sent') {
        replyText = buildCloseAck(skills, lang, merged);
      } else {
        const kind: CloseKind = closeStage === 'closing_offered' ? 'pending_owner' : (paymentQ ? 'payment_methods' : 'closing');
        replyText = buildCloseReply(skills, lang, merged, kind, paymentFacts);
      }
      needsHumanEffective = true;
      finalScore = Math.max(hybrid.score, skills.salesStrategy.urgentLeadThreshold);
      repos.conversation.upsert(customerPhone, { lead_score: finalScore });
    } else if (pricePresented) {
      // Some qual data exists but profile incomplete — guide next step.
      replyText = buildCloseReply(skills, lang, merged, 'soft_hold', paymentFacts);
    } else {
      // No price, incomplete — continue qualification
      const nameMerged = resolveNameFallback(merged, message, recentMessages);
      if (!merged.nombre && nameMerged.nombre) {
        repos.conversation.upsert(customerPhone, { collected_name: nameMerged.nombre });
      }
      let effectiveMerged = nameMerged;
      if (effectiveMerged.plan == null) {
        const inferred = inferPlanFromAssistantMessages(recentMessages, skills);
        if (inferred) {
          repos.conversation.upsert(customerPhone, { collected_plan: inferred });
          effectiveMerged = { ...effectiveMerged, plan: inferred };
        }
      }
      const qualFieldCount = [effectiveMerged.nombre, effectiveMerged.personas, effectiveMerged.fecha, effectiveMerged.transporte].filter(v => v != null).length;
      if (isQualificationComplete(effectiveMerged)) {
        needsHumanEffective = true;
        finalScore = Math.max(hybrid.score, skills.salesStrategy.urgentLeadThreshold);
        repos.conversation.upsert(customerPhone, { lead_score: finalScore });
        if (closeStage === 'pending_sent') {
          replyText = buildCloseAck(skills, lang, effectiveMerged);
        } else {
          const kind: CloseKind = closeStage === 'closing_offered' ? 'pending_owner' : (paymentQ ? 'payment_methods' : 'closing');
          replyText = buildCloseReply(skills, lang, effectiveMerged, kind, paymentFacts);
        }
      } else if (effectiveMerged.plan == null && qualFieldCount >= 3) {
        replyText = skills.fallbackReplies[lang].aiFailureQualified;
      } else {
        const qualCandidate = nextQualificationQuestion(effectiveMerged, skills.fallbackReplies[lang]);
        replyText = skipRepeated(qualCandidate, recentMessages, effectiveMerged, skills.fallbackReplies[lang]);
      }
    }
  }

  if (!needsHumanEffective && containsPromptLeakOrPolicyViolation(replyText)) {
    logger.warn({ phone: customerPhone }, '[BOT] blocked prompt leak or policy violation');
    replyText = skills.fallbackReplies[lang].aiFailureQualified;
    deflectionDueToPolicyLeak = true;
  }

  if (!hasSafetyOverride && introducedLargeGroup) {
    const caveat = skills.fallbackReplies[lang].largeGroupReview
      .replace('{{maxGroupSize}}', String(skills.salesStrategy.maxGroupSizePerDate));
    replyText = `${replyText.trim()}\n\n${caveat}`;
  }

  // ── When closing was triggered deterministically, lock phase so follow-ups
  // ── are permanently excluded for this lead.
  if (needsHumanEffective) {
    enterHumanPending(repos, customerPhone);
  } else if (
    !hasSafetyOverride
    && qComplete
    && pricePresented
    && isExactBookingDate(merged.fecha)
    && !closeIntent
    && !paymentQ
    && !isPriceQuestion(message)
    && !hasActionableUserQuestion(message)
    && !/[?¿]/.test(message)
    && !/por ese precio no|por ese valor no|muy caro|esta caro|algo caro|me parece caro|carisimo|se sale del presupuesto|fuera de presupuesto|no me alcanza/i.test(normalized)
    && !isAvailabilityLookupQuestion(message)
    && !lateMonthAvailabilityReply
    && !isGalleryRequest(message)
    && closeStage === 'none'
    && policyFactsAvailable
  ) {
    replyText = buildCloseReply(skills, lang, merged, 'closing', paymentFacts);
    llmTurn.img = false;
    repos.conversation.setSalesPhase(customerPhone, 'closing');
  } else if (
    !hasSafetyOverride
    && qComplete
    && (!pricePresented || extractStandaloneName(message) != null)
    && !closeIntent
    && !paymentQ
    && !isPriceQuestion(message)
    && !hasActionableUserQuestion(message)
    && !/[?¿]/.test(message)
    && !isGalleryRequest(message)
    && !lateMonthAvailabilityReply
    && !llmTurn.img
    && !wantsNextStep
  ) {
    // Fully qualified lead: summarize known facts and move forward — no re-ask loop.
    replyText = skills.fallbackReplies[lang].qualifiedNextStep
      .replaceAll('{{name}}', displayName(merged.nombre, lang))
      .replaceAll('{{summary}}', qualificationSummary(merged, lang, skills.fallbackReplies[lang]));
    llmTurn.img = false;
    repos.conversation.setSalesPhase(customerPhone, 'closing');
  } else if (!hasSafetyOverride
    && !needsHumanEffective
    && !lateMonthAvailabilityReply
    && hasCoreBooking
    && wantsNextStep
    && !hasActionableUserQuestion(message)
    && !/[?¿]/.test(message)
    && !isGalleryRequest(message)) {
    replyText = skills.fallbackReplies[lang].coreBookingNextStep
      .replaceAll('{{summary}}', qualificationSummary(merged, lang, skills.fallbackReplies[lang]))
      .replaceAll('{{date}}', displayDate(merged.fecha, lang));
    llmTurn.img = false;
  }
  // ────────────────────────────────────────────────────────────────────────

  if (!hasSafetyOverride && merged.mascota && PET_KEYWORDS.test(message) && !/pet[- ]friendly|mascotas?|perros?|dogs?|pets?/i.test(replyText)) {
    replyText = lang === 'es'
      ? `Si, somos pet-friendly. Tu mascota es bienvenida. ${replyText}`
      : `Yes, we are pet-friendly. Your pet is welcome. ${replyText}`;
  }

  if (!hasSafetyOverride && lateMonthAvailabilityReply) {
    replyText = lateMonthAvailabilityReply;
    llmTurn.img = false;
  }

  if (!hasSafetyOverride && deferredDateLowInformation) {
    replyText = skills.fallbackReplies[lang].dateDeferredAcknowledgement;
    llmTurn.img = false;
  }

  // Keep dateStatus fresh for CTA selection after any mid-turn transitions.
  merged = { ...merged, dateStatus: repos.conversation.getDateStatus(customerPhone) };
  if (!needsHumanEffective && conversationMode === 'bot' && isFirstContact) {
    const customerNamedExperience = /\b(?:mina|minera|minero|esmeralda|emerald|mining|chivor|hacienda|apicultura|ganader[ií]a)\b/i.test(message);
    replyText = stripAssumedExperienceClaims(replyText, {
      enabled: true,
      customerNamedExperience,
    });
    replyText = stripAssumedDatePhrases(replyText, {
      enabled: true,
      hasCustomerDate: customerContext.date != null,
      hasConfirmedDate: isConfirmedDate(dbQualification.fecha),
      hasDateWindow: !!activeDateWindow,
    });
  }
  replyText = stripReaskedQuestions(replyText, merged);
  if (!needsHumanEffective && conversationMode === 'bot' && !ambiguousPartyComparison) {
    replyText = ensureAdvanceQuestion(replyText, skills.fallbackReplies[lang], merged);
  }

  if (replyText.includes('{')) {
    replyText = stripUnsubstitutedTokens(replyText);
  }

  const finalPriceJustGiven = !usedStartingPriceTeaser && legalPrice && replyMentionsPrice(replyText);
  if (finalPriceJustGiven && !prePriceRow) repos.conversation.upsert(customerPhone, { price_given_at: new Date().toISOString() });
  const outputPriceJustGiven = !needsHumanEffective && finalPriceJustGiven;
  const llmAlreadyGaveDetailedPrice = initialPriceJustGiven && replyText.length > 150;
  const outputPriceFollowUpText = outputPriceJustGiven && !usedDeterministicQuote && !llmAlreadyGaveDetailedPrice
    ? computePriceFollowUp(merged.personas, merged.plan as string | undefined, lang, skills)
    : undefined;

  const shouldSendImage = !hasSafetyOverride && llmTurn.img;
  const shouldAlertOwner = needsHumanEffective || (hybrid.isHot && pricePresented) || unsafeReservationBlocked || deflectionDueToPolicyLeak;
  const ownerAlertType = needsHumanEffective ? 'reservation_handoff'
    : unsafeReservationBlocked ? 'unsafe_reservation_blocked'
    : deflectionDueToPolicyLeak ? 'policy_violation_blocked'
    : 'hot_lead';

  // ── Hard guard: never gallery or owner image on close / unsafe ──────────
  if (needsHumanEffective || unsafeReservationBlocked) {
    shouldSendGallery = false;
  }

  if (!hasSafetyOverride && !needsHumanEffective && !unsafeReservationBlocked && conversationMode === 'bot' && !isAvailabilityLookupQuestion(message) && pricePresented && !galleryAlreadyNudged && inferredPhase !== 'closing') {
    const fieldCount = [merged.nombre, merged.plan, merged.personas, merged.fecha, merged.transporte]
      .filter(v => v != null).length;
    if (fieldCount >= 3 && shouldAutoSendGallery(finalScore, false)) {
      shouldSendGallery = true;
    }
  }

  // Never auto-blast the gallery on the same turn the lead reveals an objection
  // (price/security/consult/not-interested). Answer the concern first; images
  // here read as pushy. Handoff-driven gallery sends above are unaffected.
  const suppressGalleryForObjection =
    !needsHumanEffective && !!(painQuestionPain && NON_REENGAGEMENT_PAINS.has(painQuestionPain));
  if (suppressGalleryForObjection) shouldSendGallery = false;

  if (isTruncatedReply(replyText)) {
    logger.warn({ phone: customerPhone, replyLen: replyText.length }, '[LLM] reply may be truncated');
  }

  if (!hasSafetyOverride && /\b(?:presupuestos?|ambos|comparar)\b/i.test(message)) {
    const unlabeledTransportAmount = /(\b(?:transporte|transport)\b[^.!?]{0,35}\b(?:suma|adds?|cuesta|costs?)\b[^.!?]{0,15}\$?\s*\d{1,3}(?:[.,]\d{3})+\s*(?:COP|pesos)?)(?![^.!?]{0,30}(?:adicional|additional))/i;
    replyText = replyText.replace(unlabeledTransportAmount, `$1${skills.fallbackReplies[lang].transportAdditionalLabel}`);
  }

  // Deterministic reply completions: append missing required phrases
  // when the LLM output is incomplete. Extracted to reply-enrichment.ts.
  replyText = enrichReply({
    replyText, message, lang, hasSafetyOverride, needsHumanEffective,
    unsafeReservationBlocked, pricePresented, closeIntent, isNewConversation,
    merged, skills,
  });

  return {
    reply: replyText, shouldSendReply: true,
    leadScore: finalScore, usedAi: true,
    shouldAlertOwner, ownerAlertType, shouldSendImage,
    shouldSendOwnerImage: !hasSafetyOverride && isFirstContact && !needsHumanEffective && !unsafeReservationBlocked && !multipleExperiences && !repos.mediaSend.hasRecentSameImage(customerPhone, 'owner_intro', new Date(Date.now() - MS_72H).toISOString()),
    shouldSendGalleryImages: shouldSendGallery,
    priceJustGiven: outputPriceJustGiven, priceFollowUpText: outputPriceFollowUpText,
    reservationReady: closeIntent && hasCoreBooking && pricePresented,
    mediaPlanId: typeof merged.plan === 'string' ? merged.plan : null,
    outboundDateAction: detectOutboundDateAction(replyText, merged),
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
