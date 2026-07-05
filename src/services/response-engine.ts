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
import type { LlmTurn } from './llm/llm-client.js';
import type { MergedQualification, ProcessMessageInput, ProcessMessageOutput } from './types.js';
import { getActiveExperience, getPlans, getPricingItems, getShortDescription, isPricingAvailable } from './product-registry.js';
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
  safeReservationHandoff,
  qualificationSummary,
  containsUnsafeReservationClaim,
  containsPromptLeakOrPolicyViolation,
  isTruncatedReply,
  isGalleryRequest,
  isGalleryConfirmation,
} from './reply-guard.js';
import { assignLine, isReferralLine } from './lead-routing.js';
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
  return ['precio', 'precios', 'cuanto', 'vale', 'valor', 'costo', 'cuesta', 'cuestan', 'price', 'prices', 'cost', 'costs'].some(t => tokens.has(t));
}

function wantsApiaryCattle(text: string): boolean {
  return /\b(apiari[oa]|abejas?|colmenas?|ganader[ií]a|ganadero|ganadera|cattle|bees?|apiary)\b/i.test(text);
}

// Composes the deterministic quote from skill JSON fragments so all customer
// copy stays in fallback-replies.json (no business text hardcoded in TS). The
// numbers come from the calculator (remote-sourced prices + local rules).
function formatDeterministicQuoteReply(quote: PriceQuote, fb: FallbackReplies['es']): string {
  const base = fb.quotePlanBase
    .replace('{{people}}', String(quote.people))
    .replace('{{planTotal}}', formatCop(quote.planTotal))
    .replace('{{currency}}', quote.currency);

  if (quote.requiresTransportConfirmation) {
    return base + fb.quoteTransportConfirm;
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

  return base + addon + transport + total;
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
  return quote ? formatDeterministicQuoteReply(quote, skills.fallbackReplies[lang]) : null;
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
  if (f.name != null) dbFields.collected_name = f.name;
  if (f.plan != null) dbFields.collected_plan = f.plan;
  if (f.people != null) dbFields.collected_people = f.people;
  if (f.date != null) dbFields.collected_date = f.date;
  if (f.transport_need != null) dbFields.collected_transport_need = f.transport_need;
  if (f.pet != null) dbFields.collected_pet = f.pet;
  if (Object.keys(dbFields).length > 0) repos.conversation.upsert(phone, dbFields);
  if (turn.sales_phase) repos.conversation.setSalesPhase(phone, turn.sales_phase);
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

function routeHumanHandoff(repos: ProcessMessageInput['repos'], customerPhone: string, q: MergedQualification, lang: 'es' | 'en', skills: Skills, defaultReply: string): string {
  const line = assignLine(repos, customerPhone);
  if (!line) return defaultReply;

  if (isReferralLine(line)) {
    repos.conversation.setMode(customerPhone, 'referred');
    return skills.fallbackReplies[lang].referralHandoff
      .replace('{{name}}', String(q.nombre ?? ''))
      .replace('{{summary}}', qualificationSummary(q, lang))
      .replace('{{agentName}}', line.agentName)
      .replace('{{displayNumber}}', line.displayNumber);
  }

  repos.conversation.setMode(customerPhone, 'bridge_active');
  return defaultReply;
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

  const bookingFields = extractBookingFields(message);
  const contextFields = contextAwareExtract(message, repos, customerPhone, bookingFields);
  repos.conversation.upsert(customerPhone, { language: lang, ...contextFields });

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
  const currentScore = repos.conversation.getLeadScore(customerPhone);
  // Single source of truth for gallery dedup: the gallery is offered at most once
  // per customer. Every automatic send path below reuses this flag so we never
  // spam the same gallery across decline/handoff/consult turns.
  const galleryAlreadyNudged = hasGalleryNudge(repos, customerPhone);

  if (isSoftCloseMessage(message)) {
    if (!softClosedAt) repos.conversation.upsert(customerPhone, { soft_closed_at: new Date().toISOString() });
    const declineScoreAlert = currentScore >= skills.salesStrategy.hotLeadThreshold;
    return { reply: skills.fallbackReplies[lang].softCloseReply.replace('{{instagramUrl}}', instagramUrl(skills)), shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: declineScoreAlert, ownerAlertType: declineScoreAlert ? 'decline_review' : undefined, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
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
    if (preLimitHandoffAllowed || preLimitReservationIntent) {
      repos.conversation.setHandedOff(customerPhone);
      const overrideScore = Math.max(currentScore, skills.salesStrategy.urgentLeadThreshold);
      repos.conversation.upsert(customerPhone, { lead_score: overrideScore });
      const handoffReply = safeReservationHandoff(dbQualification, skills.fallbackReplies[lang], lang);
      return { reply: routeHumanHandoff(repos, customerPhone, dbQualification, lang, skills, handoffReply), shouldSendReply: true, leadScore: overrideScore, usedAi: false, shouldAlertOwner: true, ownerAlertType: 'reservation_handoff', shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
    }
    if (currentScore >= skills.salesStrategy.hotLeadThreshold || (!!preLimitPriceRow && currentScore >= 20)) {
      activateHumanFallback(repos, customerPhone);
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
  const systemPrompt = buildSystemPrompt(skills, lang, collectedFields, salesPhase ?? undefined);
  const llmHistory = recentMessages.map(m => ({ role: m.role, content: m.content }));
  const llmMessage = message.length > MAX_INBOUND_CHARS ? message.slice(0, MAX_INBOUND_CHARS) : message;

  // If this is a pain reply, inject pain-specific suffix so LLM responds precisely.
  const knownPain = isPainQuestionReply ? detectLeadPain(message) : repos.conversation.getLeadPain(customerPhone);
  const painSuffix = knownPain ? buildPainSystemPromptSuffix(knownPain, lang) : undefined;

  const llmResult = await llmClient.complete({ systemPrompt, systemPromptSuffix: painSuffix, message: llmMessage, history: llmHistory, lang });

  if (!llmResult) {
    logger.warn('[LLM] DeepSeek call failed, sending minimal fallback');
    const painFallback = knownPain ? getPainFallbackReply(knownPain, lang) : null;
    const fallbackText = painFallback
      ?? (collectedFields?.nombre
        ? (skills.fallbackReplies[lang].llmFailureWarm?.replace('{{name}}', String(collectedFields.nombre)) ?? skills.fallbackReplies[lang].aiFailureQualified)
        : skills.fallbackReplies[lang].aiFailureQualified);
    return {
      reply: fallbackText, shouldSendReply: true,
      leadScore: currentScore, usedAi: true, shouldAlertOwner: hasAnyQualificationData(dbQualification),
      shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false,
    };
  }

  const llmTurn = llmResult.turn;
  const estimatedCost = llmResult.tokens.prompt * INPUT_COST_PER_TOKEN + llmResult.tokens.completion * OUTPUT_COST_PER_TOKEN;
  repos.aiUsage.recordUsage(customerPhone, env.DEEPSEEK_MODEL, llmResult.tokens.prompt, llmResult.tokens.completion, 0, estimatedCost);
  persistCollectedFromLlmTurn(repos, customerPhone, llmTurn);

  const updatedCollected = reconstructFromHistory(repos, customerPhone, getCollectedFields(repos, customerPhone));
  const merged = buildMergedQualification(updatedCollected, llmTurn);

  const llmLeadInput: LlmLeadInput = {
    intent: llmTurn.lead.intent,
    scoreDelta: llmTurn.lead.score_delta,
    confidence: llmTurn.lead.confidence,
    buyingSignals: llmTurn.lead.buying_signals,
    blockers: llmTurn.lead.blockers,
  };
  const hybrid = computeHybridScore(currentScore, llmLeadInput, regexScore.score, isReEngagement, skills.salesStrategy.hotLeadThreshold);
  repos.conversation.upsert(customerPhone, { lead_score: hybrid.score });

  let replyText = llmTurn.reply || '';
  replyText = stripHandoffPhrases(replyText);
  replyText = stripReaskedQuestions(replyText, merged);
  replyText = enforceMicroQuestionFirstContact(replyText, isFirstContact, lang);

  const exp = getActiveExperience(skills);
  const pricingAvailable = isPricingAvailable(exp);
  if (!pricingAvailable && replyMentionsPrice(replyText)) {
    replyText = skills.fallbackReplies[lang].priceUnavailable;
    llmTurn.img = false;
  }

  const deterministicQuote = buildDeterministicQuote(message, merged, lang, skills);
  if (deterministicQuote) {
    replyText = deterministicQuote;
    llmTurn.img = false;
  }

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
  const priceRow = repos.conversation.getPriceGivenAt(customerPhone);
  const pricePresented = !!(initialPriceJustGiven || priceRow);
  if (initialPriceJustGiven && !priceRow) repos.conversation.upsert(customerPhone, { price_given_at: new Date().toISOString() });

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

  if (qComplete && pricePresented && (reservationIntent || recentReservation || llmReadyToBook)) {
    needsHumanEffective = true;
    shouldSendGallery = !galleryAlreadyNudged && shouldAutoSendGallery(hybrid.score, false);
    repos.conversation.setHandedOff(customerPhone);
    finalScore = Math.max(hybrid.score, skills.salesStrategy.urgentLeadThreshold);
    repos.conversation.upsert(customerPhone, { lead_score: finalScore });
    replyText = routeHumanHandoff(repos, customerPhone, merged, lang, skills, safeReservationHandoff(merged, skills.fallbackReplies[lang], lang));
  } else if (reservationIntent || recentReservation || llmReadyToBook) {
    logger.warn({
      phone: customerPhone,
      qComplete,
      pricePresented,
      hasPriceRow: !!priceRow,
      name: merged.nombre,
      plan: merged.plan,
      personas: merged.personas,
      fecha: merged.fecha,
      transporte: merged.transporte,
      action: llmTurn.action,
      intent: llmTurn.lead.intent,
    }, '[BOT] reservation intent detected but handoff blocked — qComplete or pricePresented false');
  }

  if (!needsHumanEffective && containsUnsafeReservationClaim(replyText)) {
    logger.warn({ phone: customerPhone }, '[BOT] blocked unsafe reservation claim');
    if (qComplete && pricePresented) {
      replyText = safeReservationHandoff(merged, skills.fallbackReplies[lang], lang);
      needsHumanEffective = true;
      shouldSendGallery = !galleryAlreadyNudged && shouldAutoSendGallery(hybrid.score, false);
      repos.conversation.setHandedOff(customerPhone);
      replyText = routeHumanHandoff(repos, customerPhone, merged, lang, skills, replyText);
    } else {
      unsafeReservationBlocked = true;
      replyText = nextQualificationQuestion(merged, skills.fallbackReplies[lang]);
    }
  }

  if (!needsHumanEffective && containsPromptLeakOrPolicyViolation(replyText)) {
    logger.warn({ phone: customerPhone }, '[BOT] blocked prompt leak or policy violation');
    replyText = skills.fallbackReplies[lang].aiFailureQualified;
    deflectionDueToPolicyLeak = true;
  }

  if (!needsHumanEffective && !deflectionDueToPolicyLeak
    && (reservationIntent || recentReservation || llmReadyToBook)) {
    if (qComplete && pricePresented) {
      logger.warn({ phone: customerPhone }, '[BOT] forced handoff — reservation intent with complete qualification');
      needsHumanEffective = true;
      shouldSendGallery = !galleryAlreadyNudged && shouldAutoSendGallery(hybrid.score, false);
      repos.conversation.setHandedOff(customerPhone);
      finalScore = Math.max(hybrid.score, skills.salesStrategy.urgentLeadThreshold);
      repos.conversation.upsert(customerPhone, { lead_score: finalScore });
      replyText = routeHumanHandoff(repos, customerPhone, merged, lang, skills, safeReservationHandoff(merged, skills.fallbackReplies[lang], lang));
    } else {
      logger.warn({ phone: customerPhone, qComplete, pricePresented }, '[BOT] forced next-qualification — reservation intent with incomplete profile');
      replyText = nextQualificationQuestion(merged, skills.fallbackReplies[lang]);
    }
  }

  const finalPriceJustGiven = replyMentionsPrice(replyText);
  if (finalPriceJustGiven && !priceRow) repos.conversation.upsert(customerPhone, { price_given_at: new Date().toISOString() });

  const outputPriceJustGiven = !needsHumanEffective && finalPriceJustGiven;
  const llmAlreadyGaveDetailedPrice = initialPriceJustGiven && replyText.length > 150;
  const outputPriceFollowUpText = outputPriceJustGiven && !llmAlreadyGaveDetailedPrice ? computePriceFollowUp(merged.personas, merged.plan as string | undefined, lang, skills) : undefined;

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

  if (!needsHumanEffective && pricePresented && !galleryAlreadyNudged) {
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
    shouldSendOwnerImage: isFirstContact && !repos.mediaSend.hasRecentSameImage(customerPhone, 'owner_intro', new Date(Date.now() - MS_72H).toISOString()),
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
