import { getSkills, refreshSkills, isDynamicDataFresh, type Skills, type FallbackReplies } from './skill-loader.js';
import { logger } from '../config/logger.js';
import { logSystemError } from './error-logger.js';
import { hasGalleryNudge } from './media-service.js';
import { env } from '../config/env.js';
import { scoreMessage, computeHybridScore, type LlmLeadInput } from './lead-scoring.js';
import { checkTimeWindow } from './time-window-policy.js';
import { checkBudget } from './budget-guard.js';
import { buildSystemPrompt } from './deepseek-client.js';
import { DeepSeekLlmClient } from './llm/deepseek-llm-client.js';
import { analyzeLead, type LeadAnalysis } from './lead-analyzer.js';
import type { LlmTurn } from './llm/llm-client.js';
import type { MergedQualification, ProcessMessageInput, ProcessMessageOutput } from './types.js';
import { getActiveExperience, getCommonQuestions, getPlans, getPricingItems, getShortDescription, isPricingAvailable, getPublicPaymentFacts } from './product-registry.js';
import type { PublicPaymentFacts } from './product-registry.js';
import { calculatePriceQuote, formatCop, type PriceQuote, type TransportNeed } from './pricing-calculator.js';
import {
  extractBookingFields,
  contextAwareExtract,
  reconstructFromHistory,
  buildDbQualification,
  getCollectedFields,
  resolveLanguage,
  isQualificationComplete,
  nextQualificationQuestion,
  extractStandaloneName,
  detectPlan,
  PET_KEYWORDS,
} from './qualification-engine.js';
import {
  isSoftCloseMessage,
  isAdcodeNoise,
  isReEngagementMessage,
  isPartnerConsultPause,
  getLastAssistantQuestion,
  detectsReservationIntent,
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
  qualificationSummary,
  peopleLabel,
} from './reply-guard.js';
import { assignLine, isReferralLine } from './lead-routing.js';
import { normalizeText } from './language-service.js';
import { INPUT_COST_PER_TOKEN, MS_72H, OUTPUT_COST_PER_TOKEN, SCORE_GALLERY_TRIGGER_THRESHOLD } from './constants.js';
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

const MAX_INBOUND_CHARS = 1500;
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

function factualPolicyReply(skills: Skills, lang: 'es' | 'en', message: string): string | null {
  const emeraldQuestion = /(?:esmerald.{0,80}(?:encontr|hall|qued|llev|garant|segur)|(?:encontr|hall|qued|llev|garant|segur).{0,80}esmerald)/i.test(message);
  const mineQuestion = /(?:mina.{0,80}(?:la uni[oó]n|activa|siempre)|(?:la uni[oó]n|activa|siempre).{0,80}mina)/i.test(message);
  if (!emeraldQuestion && !mineQuestion) return null;
  const questions = getCommonQuestions(getActiveExperience(skills));
  const intents = [emeraldQuestion ? 'emerald' : null, mineQuestion ? 'mine_assignment' : null].filter((intent): intent is string => intent !== null);
  const answers = intents.map(intent => questions.find(question => question.lang === lang && question.intent === intent)?.answer).filter((answer): answer is string => Boolean(answer));
  return answers.length > 0 ? answers.join('\n\n') : null;
}

function shouldAutoSendGallery(currentScore: number, isExplicitRequest: boolean): boolean {
  if (isExplicitRequest) return true;
  return currentScore >= SCORE_GALLERY_TRIGGER_THRESHOLD;
}

function stripReaskedQuestions(reply: string, merged: MergedQualification): string {
  let result = reply;

  if (merged.nombre) {
    const nameAskPattern = new RegExp(
      String.raw`(?:¿?(?:y\s+)?(?:c[oó]mo\s+te\s+llamas|c[uú]al\s+es\s+tu\s+nombre|con\s+qui[eé]n\s+tengo\s+el\s+gusto|me\s+(?:dices|recuerdas|confirmas)\s+tu\s+nombre|y\s+tu\s+nombre|tu\s+nombre\s+es|como\s+te\s+llamo|what'?s\s+your\s+name|what\s+is\s+your\s+name|may\s+i\s+ask\s+your\s+name|before\s+we\s+continue,?\s*(?:what'?s\s+your\s+name|what\s+is\s+your\s+name)|antes\s+de\s+seguir,?\s*¿?(?:c[oó]mo\s+te\s+llamas|c[uú]al\s+es\s+tu\s+nombre))[?¿]?\s*\.?)`,
      'gi'
    );
    result = result.replace(nameAskPattern, '');
  }

  if (merged.personas != null) {
    result = result.replace(/(?:¿?(?:para\s+cu[aá]ntas\s+personas\s+ser[ií]a|cu[aá]ntas\s+personas\s+(?:ser[ií]an|son)|vienes?\s+solo\s+o\s+(?:acompa[ñn]ado|con\s+alguien)|la\s+experiencia\s+ser[ií]a\s+para\s+ti\s+solo,?\s+en\s+pareja\s+o\s+para\s+un\s+grupo|how\s+many\s+people|is\s+the\s+experience\s+for\s+you\s+alone,?\s+as\s+a\s+couple,?\s+or\s+for\s+a\s+group)[?¿]?\s*\.?)/gi, '');
  }

  if (merged.fecha != null) {
    result = result.replace(/(?:¿?(?:qu[eé]\s+fecha\s+(?:tienes|tienen)\s+en\s+mente|tienes?\s+alguna\s+fecha\s+(?:tentativa|en\s+mente)|para\s+qu[eé]\s+fecha|cu[aá]ndo\s+(?:quieres|quieren|te\s+gustar[ií]a)\s+ir|what\s+date\s+do\s+you\s+have\s+in\s+mind|do\s+you\s+have\s+a\s+date\s+in\s+mind|when\s+would\s+you\s+like\s+to\s+go)[?¿]?\s*\.?)/gi, '');
  }

  if (merged.transporte != null) {
    result = result.replace(/(?:¿?(?:vienen?\s+en\s+carro\s+propio\s+o\s+necesitan\s+transporte|tienen?\s+carro\s+propio\s+o\s+necesitan\s+transporte|c[oó]mo\s+(?:llegar[ií]an|van\s+a\s+llegar)|necesitan\s+transporte\s+desde\s+bogot[aá]|are\s+you\s+arriving\s+on\s+your\s+own\s+or\s+do\s+you\s+need\s+transport|do\s+you\s+need\s+transport(?:\s+from\s+bogota)?|how\s+would\s+you\s+get\s+there)[?¿]?\s*\.?)/gi, '');
  }

  result = result.replace(/\n{3,}/g, '\n\n').trim();

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

// Price / date / reservation intent detector for the dynamic-data guard.
// Uses word-boundary matching (not bare substring) so casual chat does not
// leak into the block (e.g. "coffee" must not match "fee", "cuando quieras"
// should still match "cuando" as a whole word but not partial tokens like
// "pagaron" matching "pago"). Multi-word phrases are matched literally.
// Accent-insensitive: the message is normalized (diacritics stripped) so a
// single ASCII keyword covers both "cuanto" and "cuánto".
const DYNAMIC_PRICE_DATE_KEYWORDS = [
  // ES
  'precio', 'precios', 'cuanto', 'cuanta', 'cuantas', 'cuantos', 'vale', 'valor',
  'costo', 'cuesta', 'cuestan', 'cobran', 'fecha', 'fechas', 'disponible',
  'disponibilidad', 'cupo', 'cupos', 'agenda', 'agendar', 'reservar', 'reserva',
  'reservacion', 'separar', 'pagar', 'pago', 'deposito', 'abono', 'nequi',
  // EN
  'price', 'prices', 'cost', 'costs', 'fee', 'fees', 'date', 'dates',
  'available', 'availability', 'schedule', 'book', 'booking', 'reserve',
  'reservation', 'pay', 'payment', 'deposit',
];
// Multi-word phrases checked with substring after normalization (order-stable).
const DYNAMIC_PRICE_DATE_PHRASES = ['how much', 'mercado pago'];

function normalizeForKeywordMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isPriceDateOrReservationMessage(text: string): boolean {
  const norm = normalizeForKeywordMatch(text);
  if (DYNAMIC_PRICE_DATE_PHRASES.some(p => norm.includes(p))) return true;
  const tokens = norm.split(/[^a-z0-9]+/).filter(Boolean);
  const keywordSet = new Set(DYNAMIC_PRICE_DATE_KEYWORDS);
  return tokens.some(t => keywordSet.has(t));
}

const OPT_OUT_KEYWORDS_ES = ['detener', 'cancelar mensajes', 'no me escriban', 'basta', 'suficiente', 'dejen de escribirme', 'no me contacten', 'no me contacte', 'sacame de la lista', 'no quiero recibir mensajes', 'no quiero mas mensajes', 'borra mis datos', 'eliminame', 'eliminame de la lista', 'no me vuelvan a escribir', 'no me manden mas mensajes', 'dejen de molestar', 'paren', 'bloqueo', 'reporto'];
const OPT_OUT_KEYWORDS_EN = ['stop', 'unsubscribe', 'no more messages', 'remove me', 'do not contact me', 'take me off', 'take me off the list', 'please stop', 'enough', "i'm done", 'i am done', 'unsubscribe me', 'do not text', 'do not message', 'stop messaging', 'leave me alone', 'do not disturb', 'block', 'report spam'];
const ALL_OPT_OUT_KEYWORDS = [...OPT_OUT_KEYWORDS_ES, ...OPT_OUT_KEYWORDS_EN];

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

function computePriceFollowUp(personas: unknown, planId: string | undefined | null, lang: string, skills: Skills): string | undefined {
  const { individualPrice, couplePrice, duration } = getPlanPricing(planId, skills);
  if (individualPrice == null || couplePrice == null) return undefined;
  const quote = calculatePriceQuote(getActiveExperience(skills), { planId, people: personas });
  if (!quote) {
    return lang === 'es'
      ? `Plan ${duration}. Individual: $${formatCop(individualPrice)} COP. Pareja: $${formatCop(couplePrice)} COP.`
      : `${duration} Plan. Individual: $${formatCop(individualPrice)} COP. Couple: $${formatCop(couplePrice)} COP.`;
  }
  const label = lang === 'es'
    ? (quote.people === 2 ? 'pareja' : `${quote.people} ${quote.people === 1 ? 'persona' : 'personas'}`)
    : (quote.people === 2 ? 'couple' : `${quote.people} ${quote.people === 1 ? 'person' : 'people'}`);
  return lang === 'es'
    ? `En tu caso, ${label}: $${formatCop(quote.planTotal)} COP todo incluido.`
    : `In your case, ${label}: $${formatCop(quote.planTotal)} COP all-inclusive.`;
}

function computePartnerPriceLine(personas: unknown, planId: string | undefined | null, lang: string, skills: Skills): string | undefined {
  const { individualPrice, couplePrice, duration } = getPlanPricing(planId, skills);
  if (individualPrice == null || couplePrice == null) return undefined;
  const quote = calculatePriceQuote(getActiveExperience(skills), { planId, people: personas });
  if (!quote) {
    return lang === 'es'
      ? `Plan ${duration}. Individual: $${formatCop(individualPrice)} COP. Pareja: $${formatCop(couplePrice)} COP.`
      : `Plan ${duration}. Individual: $${formatCop(individualPrice)} COP. Couple: $${formatCop(couplePrice)} COP.`;
  }
  return lang === 'es'
    ? `Para ${quote.people} ${quote.people === 1 ? 'persona' : 'personas'} queda en $${formatCop(quote.planTotal)} COP total.`
    : `For ${quote.people} ${quote.people === 1 ? 'person' : 'people'}, it is $${formatCop(quote.planTotal)} COP total.`;
}

function isPriceQuestion(text: string): boolean {
  const norm = normalizeForKeywordMatch(text);
  if (norm.includes('how much')) return true;
  const tokens = new Set(norm.split(/[^a-z0-9]+/).filter(Boolean));
  if (['precio', 'precios', 'vale', 'valor', 'costo', 'cuesta', 'cuestan', 'price', 'prices', 'cost', 'costs'].some(t => tokens.has(t))) return true;
  return tokens.has('cuanto') && !/\bcuanto\s+(dura|tiempo)\b/.test(norm);
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
function formatDeterministicQuoteReply(quote: PriceQuote, skills: Skills, lang: 'es' | 'en'): string {
  const fb = skills.fallbackReplies[lang];
  const plan = quotePlan(skills, quote.planId);
  const fit = quoteFitLine(quote.people, plan, fb);
  const valueStack = applyPlanTokens(fb.quoteValueStack, plan);
  const anchor = applyPlanTokens(fb.quoteAnchor, plan);
  const base = fb.quotePlanBase
    .replace('{{people}}', peopleLabel(quote.people, lang))
    .replace('{{planTotal}}', formatCop(quote.planTotal))
    .replace('{{currency}}', quote.currency);

  if (quote.requiresTransportConfirmation) {
    return `${fit} ${valueStack} ${anchor} ${base}${fb.quoteTransportConfirm} ${fb.quoteNextStep}`.trim();
  }

  const addon = quote.addonsTotal > 0
    ? fb.quoteAddons.replace('{{addonsTotal}}', formatCop(quote.addonsTotal)).replace('{{currency}}', quote.currency)
    : '';
  const transport = quote.transportTotal != null
    ? fb.quoteTransport.replace('{{transportTotal}}', formatCop(quote.transportTotal)).replace('{{currency}}', quote.currency)
    : '';
  const total = fb.quoteTotal
    .replace('{{total}}', formatCop(quote.total ?? quote.planTotal))
    .replace('{{currency}}', quote.currency);

  const totalLine = quote.total != null && quote.total !== quote.planTotal
    ? total
    : '';
  return `${fit} ${valueStack} ${anchor} ${base}${addon}${transport}${totalLine} ${fb.quoteNextStep}`.trim();
}

function frameDeterministicQuote(_llmReply: string, quoteReply: string, _fb: FallbackReplies['es']): string {
  // Package is self-contained (fit + value + number + CTA). Avoid stitching bare LLM fragments.
  return quoteReply;
}

/** First full price only after explicit ask, or group size + depth (date/transport/more turns). */
function canPresentFirstPrice(message: string, merged: MergedQualification, inboundCount: number): boolean {
  if (isPriceQuestion(message)) return true;
  if (typeof merged.personas !== 'number') return false;
  if (merged.fecha != null || merged.transporte != null) return true;
  if (inboundCount >= 3) return true;
  return false;
}

function scrubInternalLeakTokens(reply: string, internalDatePending: string): string {
  return reply
    .replace(/\btentative_unknown\b/gi, internalDatePending)
    .replace(/_relative_ordinal_[a-z0-9_]+/gi, internalDatePending);
}

function buildPriceGateTeaser(skills: Skills, lang: 'es' | 'en', planId: string | null | undefined): string {
  const exp = getActiveExperience(skills);
  const plan = planId ? getPlans(exp).find(p => p.id === planId) : undefined;
  return applyPlanTokens(skills.fallbackReplies[lang].priceGateTeaser, plan ?? getPlans(exp)[0]);
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

function buildCloseReply(
  skills: Skills,
  lang: 'es' | 'en',
  merged: MergedQualification,
  kind: CloseKind,
  facts: PublicPaymentFacts,
): string {
  const fb = skills.fallbackReplies[lang];
  const template =
    kind === 'payment_methods' ? fb.paymentMethodsReply
    : kind === 'pending_owner' ? fb.reservationPendingOwner
    : kind === 'soft_hold' ? fb.reservationSoftHold
    : fb.reservationClosing;

  return template
    .replaceAll('{{name}}', displayName(merged.nombre, lang))
    .replaceAll('{{summary}}', qualificationSummary(merged, lang, fb))
    .replaceAll('{{date}}', displayDate(merged.fecha, lang))
    .replaceAll('{{deposit}}', String(facts.depositPercent))
    .replaceAll('{{methods}}', formatMethods(facts.methodNames, lang));
}

function buildCloseAck(skills: Skills, lang: 'es' | 'en', merged: MergedQualification): string {
  const fb = skills.fallbackReplies[lang];
  return fb.reservationPendingAck
    .replaceAll('{{name}}', displayName(merged.nombre, lang))
    .replaceAll('{{date}}', displayDate(merged.fecha, lang));
}

type CloseStage = 'none' | 'closing_offered' | 'pending_sent';

function inferCloseStage(recentMessages: RecentMessage[]): CloseStage {
  const anchors: Record<'pending_sent' | 'closing_offered', RegExp[]> = {
    pending_sent: [
      /estoy validando disponibilidad/i,
      /I am validating availability/i,
    ],
    closing_offered: [
      /inicie esa validacion|inicie la validacion|quieres que inicie/i,
      /separamos con anticipo|reserva se separa/i,
      /booking is held with|shall I start that validation|shall I start it/i,
      /validacion ahora|validation now/i,
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

function buildDeterministicQuote(message: string, merged: MergedQualification, lang: 'es' | 'en', skills: Skills): string | null {
  if (!isPriceQuestion(message)) return null;
  const exp = getActiveExperience(skills);
  if (!isPricingAvailable(exp)) return null;
  const quote = calculatePriceQuote(exp, {
    planId: typeof merged.plan === 'string' ? merged.plan : undefined,
    people: merged.personas,
    transportNeed: typeof merged.transporte === 'string' ? merged.transporte as TransportNeed : undefined,
    includeApiaryCattle: wantsApiaryCattle(message),
  });
  return quote ? formatDeterministicQuoteReply(quote, skills, lang) : null;
}

function buildPartnerConsultSummary(q: MergedQualification, lang: 'es' | 'en', skills: Skills): string {
  const name = String(q.nombre ?? '').trim();
  const priceLine = computePartnerPriceLine(q.personas, q.plan as string | undefined, lang, skills)
    ?? (lang === 'es'
      ? 'El valor final lo validamos segun cantidad de personas.'
      : 'We validate the final price based on the group size.');
  return skills.fallbackReplies[lang].partnerConsultSummary
    .replace('{{name}}', name)
    .replace('{{experienceSummary}}', getShortDescription(getActiveExperience(skills)))
    .replace('{{priceLine}}', priceLine)
    .trim();
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

export async function processMessage(input: ProcessMessageInput): Promise<ProcessMessageOutput> {
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

  if (repos.isPaused()) {
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
  const skills = getSkills();

  const handedOffRow = repos.conversation.getHandedOffAt(customerPhone);
  if (handedOffRow) {
    return { reply: buildHandedOffReply(repos, customerPhone, message, skills), shouldSendReply: true, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  const lang = resolveLanguage(repos, customerPhone, message);

  if (isAdcodeNoise(message)) {
    return { reply: '', shouldSendReply: false, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  if (repos.optOut.isOptedOut(customerPhone)) {
    return { reply: '', shouldSendReply: false, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  const normalized = message.toLowerCase().trim();
  const optOutKeywords = lang === 'es' ? OPT_OUT_KEYWORDS_ES : OPT_OUT_KEYWORDS_EN;
  if (optOutKeywords.some(k => normalized.includes(k)) || ALL_OPT_OUT_KEYWORDS.some(k => normalized.includes(k))) {
    if (!repos.optOut.isOptedOut(customerPhone)) repos.optOut.setOptOut(customerPhone);
    return { reply: skills.fallbackReplies[lang].optOutConfirmation, shouldSendReply: true, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  // Terminal state: a booked (converted) lead gets no bot reply. Placed after
  // opt-out handling so a post-sale "stop" still registers for compliance.
  // Live bridge and post-handoff forwarding take precedence upstream in the
  // webhook route, so this only fires for booked leads still in `bot` mode.
  if (repos.conversation.getBookedAt(customerPhone)) {
    persistInbound();
    return { reply: '', shouldSendReply: false, leadScore: 0, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  const softClosedAt = repos.conversation.getSoftClosedAt(customerPhone);

  const isFirstContact = isNewConversation;

  persistInbound();

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

  // ── First-nudge reply detection ─────────────────────────────────────────
  // When customer replies to a first_nudge follow-up, mark it replied so
  // the scheduler can send the pain-question on next tick.
  if (
    latestFollowUpEvent?.stage === 'first_nudge' &&
    latestFollowUpEvent.status === 'sent'
  ) {
    const scoreNow = repos.conversation.getLeadScore(customerPhone);
    repos.followUpEvent.markReplied(customerPhone, latestFollowUpEvent.sequenceNumber, scoreNow, null);
    repos.conversation.incrementFollowUpReplyCount(customerPhone);
  }
  // ────────────────────────────────────────────────────────────────────────

  const pastDate = extractPastExplicitDate(message);
  if (pastDate) {
    return {
      reply: skills.fallbackReplies[lang].pastDateReply.replace('{{date}}', pastDate),
      shouldSendReply: true, leadScore: repos.conversation.getLeadScore(customerPhone), usedAi: false,
      shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false,
      shouldSendImage: false, priceJustGiven: false,
    };
  }

  const policyReply = factualPolicyReply(skills, lang, message);
  if (policyReply) {
    return {
      reply: policyReply, shouldSendReply: true, leadScore: repos.conversation.getLeadScore(customerPhone), usedAi: false,
      shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false,
      shouldSendImage: false, priceJustGiven: false,
    };
  }

  const bookingFields = extractBookingFields(message);
  const contextFields = contextAwareExtract(message, repos, customerPhone, bookingFields);
  repos.conversation.upsert(customerPhone, { language: lang, ...contextFields });
  const introducedLargeGroup = typeof contextFields.collected_people === 'number'
    && contextFields.collected_people > skills.salesStrategy.maxGroupSizePerDate;

  const rawCollected = getCollectedFields(repos, customerPhone);
  const richCollected = reconstructFromHistory(repos, customerPhone, rawCollected);
  const missingFromDb: Record<string, unknown> = {};
  if (!rawCollected.nombre && richCollected.nombre) missingFromDb.collected_name = richCollected.nombre;
  if (!rawCollected.personas && richCollected.personas) missingFromDb.collected_people = richCollected.personas;
  if (!rawCollected.fecha && richCollected.fecha) missingFromDb.collected_date = richCollected.fecha;
  if (!rawCollected.transporte && richCollected.transporte) missingFromDb.collected_transport_need = richCollected.transporte;
  if (!rawCollected.mascota && richCollected.mascota) missingFromDb.collected_pet = richCollected.mascota;
  if (richCollected.plan && richCollected.plan !== rawCollected.plan) missingFromDb.collected_plan = richCollected.plan;
  if (Object.keys(missingFromDb).length > 0) repos.conversation.upsert(customerPhone, missingFromDb);

  const collectedFields = reconstructFromHistory(repos, customerPhone, getCollectedFields(repos, customerPhone));
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
  // Single source of truth for gallery dedup: the gallery is offered at most once
  // per customer. Every automatic send path below reuses this flag so we never
  // spam the same gallery across decline/handoff/consult turns.
  const galleryAlreadyNudged = hasGalleryNudge(repos, customerPhone);

  if (isSoftCloseMessage(message)) {
    // Price objections with qualification data are recoverable: let the LLM
    // handle them instead of hard-closing with the IG soft-close.
    const hasQualData = dbQualification.personas != null || dbQualification.fecha != null || dbQualification.nombre != null;
    const isPriceObj = /muy caro|esta caro|algo caro|me parece caro|carisimo|se sale del presupuesto|fuera de presupuesto|no me alcanza|consultarlo|lo consulto|lo hablo|lo pienso|consultar/i.test(normalized);
    if (hasQualData && isPriceObj && !softClosedAt) {
      // Don't soft-close — let the objection fall through to the LLM for handling.
    } else {
      if (!softClosedAt) repos.conversation.upsert(customerPhone, { soft_closed_at: new Date().toISOString() });
      const declineScoreAlert = currentScore >= skills.salesStrategy.hotLeadThreshold;
      return { reply: skills.fallbackReplies[lang].softCloseReply.replace('{{instagramUrl}}', instagramUrl(skills)), shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: declineScoreAlert, ownerAlertType: declineScoreAlert ? 'decline_review' : undefined, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
  }

  const lastAssistantQuestion = getLastAssistantQuestion(repos, customerPhone);
  const galleryRequested = isGalleryRequest(message) || isGalleryConfirmation(message, lastAssistantQuestion);

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
    if (isReEngagementMessage(message) || galleryRequested) {
      isReEngagement = true;
      repos.conversation.clearSoftClosed(customerPhone);
    } else {
      return { reply: '', shouldSendReply: false, leadScore: currentScore, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
  }

  // Explicit customer request for photos bypasses the once-per-customer dedup:
  // if they ask again, we honor it. Only automatic nudges are deduped.
  if (galleryRequested) {
    return { reply: skills.fallbackReplies[lang].galleryIntro, shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: true, shouldSendImage: false, priceJustGiven: false };
  }

  const preLimitPriceRow = repos.conversation.getPriceGivenAt(customerPhone);
  const preLimitHandoffAllowed = isQualificationComplete(dbQualification) && !!preLimitPriceRow
    && isReservationIntentOrConfirmation(message, lastAssistantQuestion);

  const preLimitReservationIntent = !!preLimitPriceRow && isReservationIntentOrConfirmation(message, lastAssistantQuestion);

  if (preLimitPriceRow && isPartnerConsultPause(message)) {
    return { reply: buildPartnerConsultSummary(dbQualification, lang, skills), shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: !galleryAlreadyNudged && shouldAutoSendGallery(currentScore, false), shouldSendImage: false, priceJustGiven: false };
  }

  const limits = checkTimeWindow(repos, customerPhone);
  if (limits.isLimited) {
    logger.warn({ phone: customerPhone, reason: limits.reason }, '[BOT] message limit reached');
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

  const budget = checkBudget(repos, customerPhone);
  if (!budget.aiAllowed) {
    logger.warn({ reason: budget.reason }, '[AI] budget blocked');
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

  // ── Dynamic data guard ──────────────────────────────────────────────────
  // When DYNAMIC_SKILL_URL is configured but the last remote fetch failed,
  // we have no reliable pricing or availability. Block only price/date/
  // reservation messages: send a safe holding reply and alert the owner.
  // Non-price messages (route, safety, inclusions) continue normally.
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
  // ────────────────────────────────────────────────────────────────────────

  const salesPhase = repos.conversation.getSalesPhase(customerPhone);
  const safeCollected = sanitizeCollectedFields(collectedFields, skills.fallbackReplies[lang].internalDatePending);
  const systemPrompt = buildSystemPrompt(skills, lang, safeCollected, salesPhase ?? undefined);
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

  const llmResult = await llmClient.complete({ systemPrompt, systemPromptSuffix: painSuffix, message: enrichedMessage, history: llmHistory, lang });

  if (!llmResult) {
    logger.warn('[LLM] DeepSeek call failed, sending minimal fallback');
    const painFallback = isPainQuestionReply ? detectLeadPain(message) : null;
    const painReply = painFallback ? getPainFallbackReply(painFallback, lang) : null;
    const fieldCount = [collectedFields?.nombre, collectedFields?.personas, collectedFields?.fecha].filter(v => v != null).length;
    const isNearClosing = fieldCount >= 3;
    const fallbackText: string = painReply
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
  const estimatedCost = llmResult.tokens.prompt * INPUT_COST_PER_TOKEN + llmResult.tokens.completion * OUTPUT_COST_PER_TOKEN;
  repos.aiUsage.recordUsage({ phone: customerPhone, model: env.DEEPSEEK_MODEL, promptTokens: llmResult.tokens.prompt, completionTokens: llmResult.tokens.completion, cachedTokens: 0, estimatedCost, purpose: 'reply', success: true });
  persistCollectedFromLlmTurn(repos, customerPhone, llmTurn);

  const updatedCollected = reconstructFromHistory(repos, customerPhone, getCollectedFields(repos, customerPhone));
  let merged = buildMergedQualification(updatedCollected, llmTurn);

  // ── LLM-powered lead analysis (separate scoring call) ───────────────────
  // Gated behind the budget guard: the analyzer is a second DeepSeek call, so
  // it must respect daily/monthly USD budgets and per-customer/global call caps.
  // The reply call already recorded its usage row, so re-checking here reflects
  // the just-consumed budget. When budget is tight we skip analysis (score
  // unchanged) rather than overspend.
  const prePriceRow = repos.conversation.getPriceGivenAt(customerPhone);
  const analysisBudget = checkBudget(repos, customerPhone);
  let analysis: LeadAnalysis | null = null;
  if (analysisBudget.aiAllowed) {
    analysis = await analyzeLead({
      latestMessage: message,
      history: recentMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      currentScore,
      salesPhase,
      collectedFields: safeCollected as Record<string, unknown>,
      priceGiven: !!prePriceRow,
      isFollowUpReply: latestFollowUpEvent?.stage === 'first_nudge' && latestFollowUpEvent.status === 'sent',
      isPainQuestionReply,
      lastAssistantQuestion,
      lang,
    });
  } else {
    logger.warn({ phone: customerPhone, reason: analysisBudget.reason }, '[LEAD_ANALYZER] skipped — budget guard');
  }

  let llmLeadInput: LlmLeadInput;
  if (analysis) {
    const analysisCost = analysis.promptTokens * INPUT_COST_PER_TOKEN + analysis.completionTokens * OUTPUT_COST_PER_TOKEN;
    repos.aiUsage.recordUsage({ phone: customerPhone, model: env.DEEPSEEK_MODEL, promptTokens: analysis.promptTokens, completionTokens: analysis.completionTokens, cachedTokens: 0, estimatedCost: analysisCost, purpose: 'lead_analysis', success: true });
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
    const userPlan = detectPlan(message);
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
    && (isPriceQuestion(message) || replyMentionsPrice(replyText))
  ) {
    replyText = typeof merged.personas === 'number'
      ? skills.fallbackReplies[lang].priceUnavailableKnownGroup.replace('{{people}}', String(merged.personas))
      : skills.fallbackReplies[lang].priceUnavailable;
    llmTurn.img = false;
  }
  const inboundCount = recentMessages.filter(m => m.role === 'user').length + 1;
  const priceUnlocked = !!prePriceRow || canPresentFirstPrice(message, merged, inboundCount);

  let deterministicQuote: string | null = null;
  if (priceUnlocked) {
    deterministicQuote = buildDeterministicQuote(message, merged, lang, skills);

    // Calculator is source of truth. Always wrap numbers in the value package.
    // Skip override when price already given — re-engagement, not first present.
    if (!prePriceRow && !deterministicQuote && typeof merged.personas === 'number' && replyMentionsPrice(replyText) && pricingAvailable) {
      const priceOverrideQuote = calculatePriceQuote(exp, {
        planId: typeof merged.plan === 'string' ? merged.plan : undefined,
        people: merged.personas,
        transportNeed: isTransportNeed(merged.transporte) ? merged.transporte : undefined,
        includeApiaryCattle: wantsApiaryCattle(message),
      });
      if (priceOverrideQuote) deterministicQuote = formatDeterministicQuoteReply(priceOverrideQuote, skills, lang);
    }
  } else if (replyMentionsPrice(replyText)) {
    // Group size alone is not enough — sell package value first, ask one depth question.
    replyText = buildPriceGateTeaser(skills, lang, typeof merged.plan === 'string' ? merged.plan : undefined);
    llmTurn.img = false;
  }

  const usedDeterministicQuote = deterministicQuote != null;
  if (deterministicQuote) {
    replyText = frameDeterministicQuote(replyText, deterministicQuote, skills.fallbackReplies[lang]);
    llmTurn.img = false;
  }

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

  const initialPriceJustGiven = replyMentionsPrice(replyText);
  const pricePresented = !!(initialPriceJustGiven || prePriceRow);
  if (initialPriceJustGiven && !prePriceRow) repos.conversation.upsert(customerPhone, { price_given_at: new Date().toISOString() });

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
  const closeIntent = reservationIntent || recentReservation || llmReadyToBook;
  const closeStage = inferCloseStage(recentMessages);
  const paymentFacts = getPublicPaymentFacts(skills);

  // ── Payment methods question: public facts + owner handoff alert ────
  // Explicit payment-detail request is high commercial intent even if
  // qualification is incomplete. Always alert owner (reservation_handoff
  // cooldown), but keep bot mode — agent must still /bridge to take over.
  // Never expose phone numbers / payment links here (template is public-only).
  if (paymentQ && pricePresented) {
    replyText = buildCloseReply(skills, lang, merged, 'payment_methods', paymentFacts);
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

  // ── Reservation / close intent: analyzer-gated bridge ──────────────────
  // Primary path: the LLM analyzer decides whether to alert/bridge the owner.
  // Many fields or deterministic regex patterns alone do NOT trigger bridge.
  // Fallback path: when the analyzer is UNAVAILABLE (HTTP/timeout/invalid JSON
  // or budget-skipped), never silently drop a booking-ready lead — bridge when
  // qualification is complete, price was shown, and reservation intent is
  // explicit (the pre-analyzer deterministic guarantee).
  const deterministicBridgeFallback = analyzerUnavailable && closeIntent;
  if (qComplete && pricePresented && (shouldBridgeByScore || deterministicBridgeFallback)) {
    if (closeStage === 'pending_sent') {
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
    }, '[BOT] reservation bridge triggered');
  } else if (qComplete && pricePresented && closeIntent) {
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

  if (introducedLargeGroup) {
    const caveat = skills.fallbackReplies[lang].largeGroupReview
      .replace('{{maxGroupSize}}', String(skills.salesStrategy.maxGroupSizePerDate));
    replyText = `${replyText.trim()}\n\n${caveat}`;
  }

  const finalPriceJustGiven = replyMentionsPrice(replyText);
  if (finalPriceJustGiven && !prePriceRow) repos.conversation.upsert(customerPhone, { price_given_at: new Date().toISOString() });

  // ── When closing was triggered deterministically, lock phase so follow-ups
  // ── are permanently excluded for this lead.
  if (needsHumanEffective) {
    repos.conversation.setSalesPhase(customerPhone, 'closing');
  }
  // ────────────────────────────────────────────────────────────────────────

  const outputPriceJustGiven = !needsHumanEffective && finalPriceJustGiven;
  const llmAlreadyGaveDetailedPrice = initialPriceJustGiven && replyText.length > 150;
  const outputPriceFollowUpText = outputPriceJustGiven && !usedDeterministicQuote && !llmAlreadyGaveDetailedPrice
    ? computePriceFollowUp(merged.personas, merged.plan as string | undefined, lang, skills)
    : undefined;

  if (merged.mascota && PET_KEYWORDS.test(message) && !/pet[- ]friendly|mascotas?|perros?|dogs?|pets?/i.test(replyText)) {
    replyText = lang === 'es'
      ? `Si, somos pet-friendly. Tu mascota es bienvenida. ${replyText}`
      : `Yes, we are pet-friendly. Your pet is welcome. ${replyText}`;
  }

  const shouldSendImage = llmTurn.img;
  const shouldAlertOwner = needsHumanEffective || (hybrid.isHot && pricePresented) || unsafeReservationBlocked || deflectionDueToPolicyLeak;
  const ownerAlertType = needsHumanEffective ? 'reservation_handoff'
    : unsafeReservationBlocked ? 'unsafe_reservation_blocked'
    : deflectionDueToPolicyLeak ? 'policy_violation_blocked'
    : 'hot_lead';

  // ── Hard guard: never gallery or owner image on close / unsafe ──────────
  if (needsHumanEffective || unsafeReservationBlocked) {
    shouldSendGallery = false;
  }

  if (!needsHumanEffective && !unsafeReservationBlocked && pricePresented && !galleryAlreadyNudged && inferredPhase !== 'closing') {
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
    logger.warn({ phone: customerPhone, replySnippet: replyText.slice(0, 40) }, '[LLM] reply may be truncated');
  }

  return {
    reply: replyText, shouldSendReply: true,
    leadScore: finalScore, usedAi: true,
    shouldAlertOwner, ownerAlertType, shouldSendImage,
    shouldSendOwnerImage: isFirstContact && !needsHumanEffective && !unsafeReservationBlocked && !repos.mediaSend.hasRecentSameImage(customerPhone, 'owner_intro', new Date(Date.now() - MS_72H).toISOString()),
    shouldSendGalleryImages: shouldSendGallery,
    priceJustGiven: outputPriceJustGiven, priceFollowUpText: outputPriceFollowUpText,
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
