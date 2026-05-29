import { getSkills, type Skills } from './skill-loader.js';
import { logger } from '../config/logger.js';
import { scoreMessage } from './lead-scoring.js';
import { checkTimeWindow } from './time-window-policy.js';
import { checkBudget } from './budget-guard.js';
import {
  buildSystemPrompt,
  callDeepSeekCached,
  recordAiUsage,
} from './deepseek-client.js';
import type { MergedQualification, ProcessMessageInput, ProcessMessageOutput } from './types.js';
import { getActiveExperience, getPlans, getPricingItems, getShortDescription } from './product-registry.js';
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
  asksItinerary,
  isGenericConversionReply,
  isUserConfusedOrRepeating,
  isTruncatedReply,
  hasActionableUserQuestion,
  itineraryReply,
  safeReservationHandoff,
  buildFallbackReply,
  containsUnsafeReservationClaim,
  colombiaTimeAwareReply,
} from './reply-guard.js';

export {
  detectsReservationIntent,
  isReservationIntentOrConfirmation,
  replyMentionsPrice,
  containsHandoffPhrase,
  stripHandoffPhrases,
  isTruncatedReply,
};

export type { ProcessMessageInput, ProcessMessageOutput };

const OPT_OUT_KEYWORDS_ES = ['detener', 'cancelar mensajes', 'no me escriban', 'basta', 'suficiente', 'dejen de escribirme', 'no me contacten', 'no me contacte', 'sacame de la lista', 'no quiero recibir mensajes', 'no quiero mas mensajes', 'borra mis datos', 'eliminame', 'eliminame de la lista', 'no me vuelvan a escribir', 'no me manden mas mensajes', 'dejen de molestar', 'paren', 'bloqueo', 'reporto'];
const OPT_OUT_KEYWORDS_EN = ['stop', 'unsubscribe', 'no more messages', 'remove me', 'do not contact me', 'take me off', 'take me off the list', 'please stop', 'enough', "i'm done", 'i am done', 'unsubscribe me', 'do not text', 'do not message', 'stop messaging', 'leave me alone', 'do not disturb', 'block', 'report spam'];
const ALL_OPT_OUT_KEYWORDS = [...OPT_OUT_KEYWORDS_ES, ...OPT_OUT_KEYWORDS_EN];

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

  if (individualPrice == null || couplePrice == null) {
    return undefined;
  }

  const n = typeof personas === 'number' ? personas : parseInt(String(personas), 10);
  if (isNaN(n) || n <= 0) {
    return lang === 'es'
      ? `Plan ${duration}. Individual: $${formatPeso(individualPrice)} COP. Pareja: $${formatPeso(couplePrice)} COP.`
      : `${duration} Plan. Individual: $${formatPeso(individualPrice)} COP. Couple: $${formatPeso(couplePrice)} COP.`;
  }

  let label: string;
  let amount: number;
  if (n === 1) {
    amount = individualPrice;
    label = lang === 'es' ? '1 persona' : '1 person';
  } else if (n === 2) {
    amount = couplePrice;
    label = lang === 'es' ? 'pareja' : 'couple';
  } else if (n === 3) {
    amount = couplePrice + individualPrice;
    label = lang === 'es' ? '3 personas' : '3 people';
  } else if (n === 4) {
    amount = couplePrice * 2;
    label = lang === 'es' ? '4 personas (2 parejas)' : '4 people (2 couples)';
  } else {
    return undefined;
  }

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

export async function processMessage(input: ProcessMessageInput): Promise<ProcessMessageOutput> {
  const { repos, customerPhone, message, messageId } = input;
  const skills = getSkills();

  const handedOffRow = repos.conversation.getHandedOffAt(customerPhone);
  const handedOffAt = handedOffRow;

  if (handedOffAt) {
    const fb = skills.fallbackReplies[resolveLanguage(repos, customerPhone, message)];
    const norm = message.toLowerCase().trim();

    const looksTypo = norm.length <= 15 && /^[a-záéíóúñ\s]{1,15}$/.test(norm) && !/^(?:si|no|ok|gracias|thanks|vale|listo|hola|hello|hi|buenas|bye|chao|adios|perfecto|excelente|genial|great|excellent)$/i.test(norm);
    const looksQuestion = /\?$|^(?:como|donde|cuando|cuanto|que|qu[eé]|what|how|where|when|por qu[eé]|why)\b/i.test(norm);
    const looksThanks = /\b(gracias|thank|vale|perfecto|excelente|genial|ok|listo|great|excellent|bye|chao|adios)\b/i.test(norm);

    if (looksTypo) {
      return {
        reply: fb.handedOffTypo ?? fb.handedOffVariant0,
        shouldSendReply: true,
        leadScore: 0,
        usedAi: false,
        shouldAlertOwner: false,
        shouldSendImage: false,
        priceJustGiven: false,
      };
    }
    if (looksQuestion) {
      return {
        reply: fb.handedOffQuestion ?? fb.handedOffVariant0,
        shouldSendReply: true,
        leadScore: 0,
        usedAi: false,
        shouldAlertOwner: false,
        shouldSendImage: false,
        priceJustGiven: false,
      };
    }
    if (looksThanks) {
      return {
        reply: fb.handedOffThanks ?? fb.handedOffVariant1,
        shouldSendReply: true,
        leadScore: 0,
        usedAi: false,
        shouldAlertOwner: false,
        shouldSendImage: false,
        priceJustGiven: false,
      };
    }

    const idx = Math.floor(Date.now() / 1000) % 2;
    return {
      reply: idx === 0 ? fb.handedOffVariant0 : fb.handedOffVariant1,
      shouldSendReply: true,
      leadScore: 0,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  const lang = resolveLanguage(repos, customerPhone, message);

  if (isAdcodeNoise(message)) {
    return {
      reply: '',
      shouldSendReply: false,
      leadScore: 0,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  if (repos.optOut.isOptedOut(customerPhone)) {
    return {
      reply: '',
      shouldSendReply: false,
      leadScore: 0,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  const normalized = message.toLowerCase().trim();
  const optOutKeywords = lang === 'es' ? OPT_OUT_KEYWORDS_ES : OPT_OUT_KEYWORDS_EN;
  if (optOutKeywords.some(k => normalized.includes(k)) || ALL_OPT_OUT_KEYWORDS.some(k => normalized.includes(k))) {
    if (!repos.optOut.isOptedOut(customerPhone)) {
      repos.optOut.setOptOut(customerPhone);
    }
    const optOutMsg = skills.fallbackReplies[lang].optOutConfirmation;
    return {
      reply: optOutMsg,
      shouldSendReply: true,
      leadScore: 0,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  const softCloseRow = repos.conversation.getSoftClosedAt(customerPhone);
  const softClosedAt = softCloseRow;

  repos.message.addMessage({
    whatsapp_message_id: messageId,
    customer_phone: customerPhone,
    direction: 'inbound',
    message_type: 'text',
    body: message,
    created_at: new Date().toISOString(),
    raw_json: null,
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
  if (Object.keys(missingFromDb).length > 0) {
    repos.conversation.upsert(customerPhone, missingFromDb);
  }

  const collectedFields = reconstructFromHistory(repos, customerPhone, getCollectedFields(repos, customerPhone));
  const dbQualification = buildDbQualification(collectedFields);
  const recentMessages = repos.message.getRecentMessages(customerPhone, 21).filter((_, i, arr) => i < arr.length - 1);

  const scoreDelta = scoreMessage(normalized, skills);
  const currentScore = (() => {
    const existing = repos.conversation.getLeadScore(customerPhone);
    return Math.max(0, Math.min(100, existing + scoreDelta.score));
  })();

  repos.conversation.upsert(customerPhone, { lead_score: currentScore });

  if (isSoftCloseMessage(message)) {
    if (!softClosedAt) {
      repos.conversation.upsert(customerPhone, { soft_closed_at: new Date().toISOString() });
    }
    const softCloseReply = skills.fallbackReplies[lang].softCloseReply.replace('{{instagramUrl}}', instagramUrl(skills));
    return {
      reply: softCloseReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  if (softClosedAt) {
    if (isReEngagementMessage(message)) {
      repos.conversation.clearSoftClosed(customerPhone);
    } else {
      return {
        reply: '',
        shouldSendReply: false,
        leadScore: currentScore,
        usedAi: false,
        shouldAlertOwner: false,
        shouldSendImage: false,
        priceJustGiven: false,
      };
    }
  }

  const preLimitPriceRow = repos.conversation.getPriceGivenAt(customerPhone);
  const lastAssistantQuestion = getLastAssistantQuestion(repos, customerPhone);
  const preLimitHandoffAllowed = isQualificationComplete(dbQualification)
    && !!preLimitPriceRow
    && isReservationIntentOrConfirmation(message, lastAssistantQuestion);

  if (preLimitPriceRow && isPartnerConsultPause(message)) {
    return {
      reply: buildPartnerConsultSummary(dbQualification, lang, skills),
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  const limits = checkTimeWindow(repos, customerPhone);
  if (limits.isLimited) {
    logger.warn({ phone: customerPhone, reason: limits.reason }, '[BOT] message limit reached');
    if (preLimitHandoffAllowed) {
      repos.conversation.setHandedOff(customerPhone);
      return {
        reply: safeReservationHandoff(dbQualification, skills.fallbackReplies[lang], lang),
        shouldSendReply: true,
        leadScore: currentScore,
        usedAi: false,
        shouldAlertOwner: true,
        shouldSendImage: false,
        priceJustGiven: false,
      };
    }
    if (preLimitPriceRow) {
      const fb = skills.fallbackReplies[lang];
      return {
        reply: colombiaTimeAwareReply(fb.messageLimitAfterPrice, fb.messageLimitAfterPriceAfterHours, fb.messageLimitAfterPriceMorningHours),
        shouldSendReply: true,
        leadScore: currentScore,
        usedAi: false,
        shouldAlertOwner: true,
        shouldSendImage: false,
        priceJustGiven: false,
      };
    }
    const gracefulReply = skills.fallbackReplies[lang].messageLimitReached;
    return {
      reply: gracefulReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  const budget = checkBudget(repos, customerPhone);
  if (!budget.aiAllowed) {
    logger.warn({ reason: budget.reason }, '[AI] budget blocked');
    const fb2 = skills.fallbackReplies[lang];
    const gracefulReply = preLimitPriceRow
      ? colombiaTimeAwareReply(fb2.messageLimitAfterPrice, fb2.messageLimitAfterPriceAfterHours, fb2.messageLimitAfterPriceMorningHours)
      : skills.fallbackReplies[lang].aiFailureQualified;
    return {
      reply: gracefulReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: true,
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  const systemPrompt = buildSystemPrompt(skills, lang, collectedFields);
  const aiResult = await callDeepSeekCached(repos, message, systemPrompt, recentMessages);

  if (!aiResult) {
    logger.warn('[AI] DeepSeek call failed, sending graceful reply');
    const fallbackReply = buildFallbackReply(dbQualification, message, lang, repos, customerPhone, skills);
    return {
      reply: fallbackReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: isQualificationComplete(dbQualification),
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  const { response: aiResponse } = aiResult;

  recordAiUsage(repos, customerPhone, {
    prompt_tokens: aiResult.promptTokens,
    completion_tokens: aiResult.completionTokens,
  });

  if (aiResponse.reply === null || aiResponse.reply === '') {
    logger.warn('[AI] DeepSeek returned null reply, sending graceful reply');
    const fallbackReply = buildFallbackReply(dbQualification, message, lang, repos, customerPhone, skills);
    return {
      reply: fallbackReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: true,
      shouldAlertOwner: isQualificationComplete(dbQualification),
      shouldSendImage: false,
      priceJustGiven: false,
    };
  }

  let finalScore = Math.max(0, Math.min(100, currentScore + aiResponse.lead_score_delta));

  const collectedFromAi = aiResponse.collected_fields ?? {};
  const dbFields: Record<string, unknown> = {};
  if (collectedFromAi.name != null) dbFields.collected_name = collectedFromAi.name;
  if (collectedFromAi.plan != null) dbFields.collected_plan = collectedFromAi.plan;
  if (collectedFromAi.people != null) dbFields.collected_people = collectedFromAi.people;
  if (collectedFromAi.date != null) dbFields.collected_date = collectedFromAi.date;
  if (collectedFromAi.transport_need != null) dbFields.collected_transport_need = collectedFromAi.transport_need;
  if (collectedFromAi.lodging_need != null) dbFields.collected_lodging_need = collectedFromAi.lodging_need;
  if (collectedFromAi.pet != null) dbFields.collected_pet = collectedFromAi.pet;
  if (Object.keys(dbFields).length > 0) {
    repos.conversation.upsert(customerPhone, { lead_score: finalScore, ...dbFields });
  } else {
    repos.conversation.upsert(customerPhone, { lead_score: finalScore });
  }

  const shouldSendImage = aiResponse.should_send_image;

  let replyText = stripHandoffPhrases(aiResponse.reply);

  const merged: MergedQualification = {
    nombre: collectedFields.nombre ?? collectedFromAi.name,
    plan: collectedFields.plan ?? collectedFromAi.plan,
    personas: collectedFields.personas ?? collectedFromAi.people,
    fecha: collectedFields.fecha ?? collectedFromAi.date,
    transporte: collectedFields.transporte ?? collectedFromAi.transport_need,
    mascota: collectedFields.mascota ?? collectedFromAi.pet,
  };

  if (asksItinerary(message) && isGenericConversionReply(replyText)) {
    replyText = itineraryReply(merged, skills.fallbackReplies[lang], skills, lang);
  } else if (isUserConfusedOrRepeating(message) && isGenericConversionReply(replyText)) {
    const preCheckPrice = repos.conversation.getPriceGivenAt(customerPhone);
    if (preCheckPrice) {
      const name = String(merged.nombre ?? '');
      replyText = lang === 'es'
        ? `${name}, perdón, me enredé. Para resumir: el plan sale bien, y si quieres, valido disponibilidad exacta con el equipo y te confirmo.`
        : `${name}, sorry, I got tangled up. To summarize: the plan works, and if you want, I'll validate exact availability with the team and confirm.`;
    }
  }

  const initialPriceJustGiven = replyMentionsPrice(replyText);
  const priceRow = repos.conversation.getPriceGivenAt(customerPhone);
  const pricePresented = !!(initialPriceJustGiven || priceRow);
  if (initialPriceJustGiven && !priceRow) {
    repos.conversation.upsert(customerPhone, { price_given_at: new Date().toISOString() });
  }

  const reservationIntent = isReservationIntentOrConfirmation(message, lastAssistantQuestion);
  const explicitReservation = detectsReservationIntent(message);
  const recentReservation = recentMessages
    .filter(m => m.role === 'user')
    .slice(-6)
    .some(m => detectsReservationIntent(m.content));
  const handoffAllowed = isQualificationComplete(merged) && pricePresented && (reservationIntent || recentReservation);

  if (pricePresented && (explicitReservation || reservationIntent || recentReservation)) {
    finalScore = Math.max(finalScore, skills.salesStrategy.urgentLeadThreshold);
    repos.conversation.upsert(customerPhone, { lead_score: finalScore });
  }

  let needsHumanEffective = false;

  if (handoffAllowed) {
    replyText = safeReservationHandoff(merged, skills.fallbackReplies[lang], lang);
    needsHumanEffective = true;
    repos.conversation.setHandedOff(customerPhone);
  } else {
    if (!merged.plan && pricePresented && (reservationIntent || recentReservation || containsUnsafeReservationClaim(replyText))) {
      replyText = nextQualificationQuestion(merged, skills.fallbackReplies[lang]);
    } else if (containsUnsafeReservationClaim(replyText) && isQualificationComplete(merged) && pricePresented) {
      logger.warn({ phone: customerPhone, pricePresented, reservationIntent }, '[BOT] blocked unsafe reservation claim');
      replyText = safeReservationHandoff(merged, skills.fallbackReplies[lang], lang);
      needsHumanEffective = true;
      repos.conversation.setHandedOff(customerPhone);
    }

    const modelTriedHandoff =
      aiResponse.needs_human || replyText.length === 0 || containsHandoffPhrase(aiResponse.reply);
    if (!needsHumanEffective && modelTriedHandoff) {
      logger.warn({ phone: customerPhone, merged: { nombre: merged.nombre, personas: merged.personas, fecha: merged.fecha, transporte: merged.transporte, mascota: merged.mascota }, pricePresented, reservationIntent }, '[BOT] suppressed premature handoff');
      if (!isQualificationComplete(merged)) {
        const nextQ = asksItinerary(message)
          ? itineraryReply(merged, skills.fallbackReplies[lang], skills, lang)
          : hasActionableUserQuestion(message)
            ? skills.fallbackReplies[lang].answerQuestionBeforeQualification
          : nextQualificationQuestion(merged, skills.fallbackReplies[lang]);
        const lastAssistant = getLastAssistantQuestion(repos, customerPhone);
        if (lastAssistant && lastAssistant.trim().toLowerCase() === nextQ.trim().toLowerCase()) {
          const extractedNow = extractBookingFields(message);
          if (extractedNow.collected_people && !merged.personas) {
            repos.conversation.upsert(customerPhone, { collected_people: extractedNow.collected_people });
            replyText = nextQualificationQuestion({ ...merged, personas: extractedNow.collected_people }, skills.fallbackReplies[lang]);
          } else {
            replyText = lang === 'es'
              ? 'Perdón, creo que no tomé bien tu respuesta. ¿Me confirmas de nuevo?'
              : 'Sorry, I think I missed that. Could you confirm again?';
          }
        } else {
          replyText = nextQ;
        }
      } else if (!pricePresented) {
        replyText = skills.fallbackReplies[lang].repairPriceNotPresented.replace('{{name}}', String(merged.nombre ?? ''));
        repos.conversation.upsert(customerPhone, { price_given_at: new Date().toISOString() });
      } else {
        replyText = skills.fallbackReplies[lang].repairPricePresented.replace('{{name}}', String(merged.nombre ?? ''));
      }
    }
  }

  const finalPriceJustGiven = replyMentionsPrice(replyText);
  if (finalPriceJustGiven && !priceRow) {
    repos.conversation.upsert(customerPhone, { price_given_at: new Date().toISOString() });
  }

  const outputPriceJustGiven = !needsHumanEffective && finalPriceJustGiven;
  const outputPriceFollowUpText = outputPriceJustGiven
    ? computePriceFollowUp(merged.personas, merged.plan as string | undefined, lang, skills)
    : undefined;

  if (merged.mascota && PET_KEYWORDS.test(message) && !/pet[- ]friendly|mascotas?|perros?|dogs?|pets?/i.test(replyText)) {
    replyText = lang === 'es'
      ? `Si, somos pet-friendly. Tu mascota es bienvenida. ${replyText}`
      : `Yes, we are pet-friendly. Your pet is welcome. ${replyText}`;
  }

  const shouldAlertOwner = needsHumanEffective || (
    finalScore >= skills.salesStrategy.hotLeadThreshold
    && isQualificationComplete(merged)
    && pricePresented
    && reservationIntent
  ) || (
    pricePresented && explicitReservation
  );
  const ownerAlertType = needsHumanEffective
    ? 'reservation_handoff'
    : explicitReservation
      ? 'reservation_intent'
      : 'hot_lead';

  if (isTruncatedReply(replyText)) {
    logger.warn({ phone: customerPhone, replySnippet: replyText.slice(0, 40) }, '[AI] reply may be truncated');
  }

  return {
    reply: replyText,
    shouldSendReply: true,
    leadScore: finalScore,
    usedAi: true,
    shouldAlertOwner,
    ownerAlertType,
    shouldSendImage,
    priceJustGiven: outputPriceJustGiven,
    priceFollowUpText: outputPriceFollowUpText,
  };
}
