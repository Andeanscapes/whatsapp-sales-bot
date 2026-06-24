import { getSkills, refreshSkills, type Skills } from './skill-loader.js';
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
import type { RecentMessage } from '../db/repositories/types.js';

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

function getSystemErrorRetry(lang: 'es' | 'en' | null): string {
  return getSkills().fallbackReplies[lang ?? 'es'].systemErrorRetry;
}

const OPT_OUT_KEYWORDS_ES = ['detener', 'cancelar mensajes', 'no me escriban', 'basta', 'suficiente', 'dejen de escribirme', 'no me contacten', 'no me contacte', 'sacame de la lista', 'no quiero recibir mensajes', 'no quiero mas mensajes', 'borra mis datos', 'eliminame', 'eliminame de la lista', 'no me vuelvan a escribir', 'no me manden mas mensajes', 'dejen de molestar', 'paren', 'bloqueo', 'reporto'];
const OPT_OUT_KEYWORDS_EN = ['stop', 'unsubscribe', 'no more messages', 'remove me', 'do not contact me', 'take me off', 'take me off the list', 'please stop', 'enough', "i'm done", 'i am done', 'unsubscribe me', 'do not text', 'do not message', 'stop messaging', 'leave me alone', 'do not disturb', 'block', 'report spam'];
const ALL_OPT_OUT_KEYWORDS = [...OPT_OUT_KEYWORDS_ES, ...OPT_OUT_KEYWORDS_EN];

export const llmClient = new DeepSeekLlmClient(true);

const INPUT_COST_PER_TOKEN = 0.15 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 0.60 / 1_000_000;

function formatPeso(n: number): string {
  return n.toLocaleString('en-US');
}

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
  const n = typeof personas === 'number' ? personas : parseInt(String(personas), 10);
  if (isNaN(n) || n <= 0) {
    return lang === 'es'
      ? `Plan ${duration}. Individual: $${formatPeso(individualPrice)} COP. Pareja: $${formatPeso(couplePrice)} COP.`
      : `${duration} Plan. Individual: $${formatPeso(individualPrice)} COP. Couple: $${formatPeso(couplePrice)} COP.`;
  }
  let label: string;
  let amount: number;
  if (n === 1) { amount = individualPrice; label = lang === 'es' ? '1 persona' : '1 person'; }
  else if (n === 2) { amount = couplePrice; label = lang === 'es' ? 'pareja' : 'couple'; }
  else if (n === 3) { amount = couplePrice + individualPrice; label = lang === 'es' ? '3 personas' : '3 people'; }
  else if (n === 4) { amount = couplePrice * 2; label = lang === 'es' ? '4 personas (2 parejas)' : '4 people (2 couples)'; }
  else return undefined;
  return lang === 'es'
    ? `En tu caso, ${label}: $${formatPeso(amount)} COP todo incluido.`
    : `In your case, ${label}: $${formatPeso(amount)} COP all-inclusive.`;
}

function computePartnerPriceLine(personas: unknown, planId: string | undefined | null, lang: string, skills: Skills): string | undefined {
  const { individualPrice, couplePrice, duration } = getPlanPricing(planId, skills);
  if (individualPrice == null || couplePrice == null) return undefined;
  const n = typeof personas === 'number' ? personas : parseInt(String(personas), 10);
  if (isNaN(n) || n <= 0) {
    return lang === 'es'
      ? `Plan ${duration}. Individual: $${formatPeso(individualPrice)} COP. Pareja: $${formatPeso(couplePrice)} COP.`
      : `Plan ${duration}. Individual: $${formatPeso(individualPrice)} COP. Couple: $${formatPeso(couplePrice)} COP.`;
  }
  let amount: number;
  if (n === 1) amount = individualPrice;
  else if (n === 2) amount = couplePrice;
  else if (n === 3) amount = couplePrice + individualPrice;
  else if (n === 4) amount = couplePrice * 2;
  else return lang === 'es'
    ? 'Para grupos de 5+ personas validamos el total con vehiculos adicionales si aplica.'
    : 'For groups of 5+ people, we validate the final total with extra vehicles if needed.';
  return lang === 'es'
    ? `Para ${n} ${n === 1 ? 'persona' : 'personas'} queda en $${formatPeso(amount)} COP total.`
    : `For ${n} ${n === 1 ? 'person' : 'people'}, it is $${formatPeso(amount)} COP total.`;
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
  const { repos, customerPhone, message, messageId } = input;

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

  const softClosedAt = repos.conversation.getSoftClosedAt(customerPhone);

  const isFirstContact = isNewConversation;

  repos.message.addMessage({
    whatsapp_message_id: messageId, customer_phone: customerPhone, direction: 'inbound',
    message_type: 'text', body: message, created_at: new Date().toISOString(), raw_json: null,
  });

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
    return { reply: skills.fallbackReplies[lang].softCloseReply.replace('{{instagramUrl}}', instagramUrl(skills)), shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: declineScoreAlert, ownerAlertType: declineScoreAlert ? 'decline_review' : undefined, shouldSendOwnerImage: false, shouldSendGalleryImages: !galleryAlreadyNudged, shouldSendImage: false, priceJustGiven: false };
  }

  const lastAssistantQuestion = getLastAssistantQuestion(repos, customerPhone);
  const galleryRequested = isGalleryRequest(message) || isGalleryConfirmation(message, lastAssistantQuestion);

  let isReEngagement = false;
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
    return { reply: buildPartnerConsultSummary(dbQualification, lang, skills), shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: false, shouldSendOwnerImage: false, shouldSendGalleryImages: !galleryAlreadyNudged, shouldSendImage: false, priceJustGiven: false };
  }

  const limits = checkTimeWindow(repos, customerPhone);
  if (limits.isLimited) {
    logger.warn({ phone: customerPhone, reason: limits.reason }, '[BOT] message limit reached');
    if (preLimitHandoffAllowed || preLimitReservationIntent) {
      repos.conversation.setHandedOff(customerPhone);
      const overrideScore = Math.max(currentScore, skills.salesStrategy.urgentLeadThreshold);
      repos.conversation.upsert(customerPhone, { lead_score: overrideScore });
      const handoffReply = safeReservationHandoff(dbQualification, skills.fallbackReplies[lang], lang);
      return { reply: routeHumanHandoff(repos, customerPhone, dbQualification, lang, skills, handoffReply), shouldSendReply: true, leadScore: overrideScore, usedAi: false, shouldAlertOwner: true, ownerAlertType: 'reservation_handoff', shouldSendOwnerImage: false, shouldSendGalleryImages: !galleryAlreadyNudged, shouldSendImage: false, priceJustGiven: false };
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
    activateHumanFallback(repos, customerPhone);
    return { reply: skills.fallbackReplies[lang].aiBudgetExhausted, shouldSendReply: true, leadScore: currentScore, usedAi: false, shouldAlertOwner: true, shouldSendOwnerImage: false, shouldSendGalleryImages: false, shouldSendImage: false, priceJustGiven: false };
  }

  const salesPhase = repos.conversation.getSalesPhase(customerPhone);
  const systemPrompt = buildSystemPrompt(skills, lang, collectedFields, salesPhase ?? undefined);
  const llmHistory = recentMessages.map(m => ({ role: m.role, content: m.content }));
  const llmMessage = message.length > MAX_INBOUND_CHARS ? message.slice(0, MAX_INBOUND_CHARS) : message;

  const llmResult = await llmClient.complete({ systemPrompt, message: llmMessage, history: llmHistory, lang });

  if (!llmResult) {
    logger.warn('[LLM] DeepSeek call failed, sending minimal fallback');
    const fallbackText = collectedFields?.nombre
      ? (skills.fallbackReplies[lang].llmFailureWarm?.replace('{{name}}', String(collectedFields.nombre)) ?? skills.fallbackReplies[lang].aiFailureQualified)
      : skills.fallbackReplies[lang].aiFailureQualified;
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

  const exp = getActiveExperience(skills);
  const pricingAvailable = isPricingAvailable(exp);
  if (!pricingAvailable && replyMentionsPrice(replyText)) {
    replyText = skills.fallbackReplies[lang].priceUnavailable;
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
    shouldSendGallery = !galleryAlreadyNudged;
    repos.conversation.setHandedOff(customerPhone);
    finalScore = Math.max(hybrid.score, skills.salesStrategy.urgentLeadThreshold);
    repos.conversation.upsert(customerPhone, { lead_score: finalScore });
    replyText = routeHumanHandoff(repos, customerPhone, merged, lang, skills, safeReservationHandoff(merged, skills.fallbackReplies[lang], lang));
  }

  if (!needsHumanEffective && containsUnsafeReservationClaim(replyText)) {
    logger.warn({ phone: customerPhone }, '[BOT] blocked unsafe reservation claim');
    if (qComplete && pricePresented) {
      replyText = safeReservationHandoff(merged, skills.fallbackReplies[lang], lang);
      needsHumanEffective = true;
      shouldSendGallery = !galleryAlreadyNudged;
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
    if (fieldCount >= 3) {
      shouldSendGallery = true;
    }
  }

  if (isTruncatedReply(replyText)) {
    logger.warn({ phone: customerPhone, replySnippet: replyText.slice(0, 40) }, '[LLM] reply may be truncated');
  }

  return {
    reply: replyText, shouldSendReply: true,
    leadScore: finalScore, usedAi: true,
    shouldAlertOwner, ownerAlertType, shouldSendImage,
    shouldSendOwnerImage: isFirstContact,
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
