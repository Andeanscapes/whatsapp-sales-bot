import { extractBookingFields } from './qualification-engine.js';
import { getCommonQuestions, getFutureAvailableDates, getActiveExperience } from './product-registry.js';
import type { Skills } from './skill-loader.js';
import type { MergedQualification } from './types.js';

export interface EnrichReplyInput {
  replyText: string;
  message: string;
  lang: 'es' | 'en';
  hasSafetyOverride: boolean;
  needsHumanEffective: boolean;
  unsafeReservationBlocked: boolean;
  pricePresented: boolean;
  closeIntent: boolean;
  isNewConversation: boolean;
  merged: MergedQualification;
  skills: Skills;
}

function stripTrailingQuestion(reply: string): string {
  return reply.replace(/(?:\n\n|\s)(?:¿[^?]*\?|[^.!?\n]*\?)\s*$/u, '').trim();
}

export function enrichReply(input: EnrichReplyInput): string {
  const {
    replyText: initial, message, lang, hasSafetyOverride, needsHumanEffective,
    unsafeReservationBlocked, pricePresented, closeIntent, isNewConversation,
    merged, skills,
  } = input;
  let replyText = initial;
  const exp = getActiveExperience(skills);
  const replies = skills.fallbackReplies[lang];
  const safe = !hasSafetyOverride && !needsHumanEffective && !unsafeReservationBlocked;

  // Post-price next-step injection: if the customer shows interest after price
  // but the LLM didn't offer a concrete next step, append one deterministically.
  if (safe && pricePresented && !closeIntent
    && /\b(?:me interesa|qu[eé] sigue|c[oó]mo seguimos|y ahora|c[oó]mo se hace|siguiente paso)\b/i.test(message)
    && !/\b(?:validar|separar|reservar|confirmar|iniciamos|inicie|iniciamos la reserva)\b/i.test(replyText)
    && !/\b(?:car[oi]|costos[oa]|muy\s+car[oi]|presupuesto|no me alcanza|fuera de)\b/i.test(message)) {
    replyText = `${replyText}\n\n${replies.enrichAfterPriceNextStep}`;
  }

  // First-contact qualification: if reply lacks solo/pareja/grupo, append.
  if (safe && isNewConversation
    && !/\b(?:solo|sola|pareja|grupo)\b/i.test(replyText)
    && !/[?¿]/.test(replyText)
    && !/\b(?:no gracias|no me interesa|cancelar|baja|remove|stop|opt.?out|dinero|pago|reembolso|devoluci[oó]n|problema|queja|reclamo)\b/i.test(message)
    && merged.personas == null
    && !extractBookingFields(message).collected_people
    && /\b(?:plan|experiencia|mina|miner[ao]|chivor|tour|aventura|reserva|precio|fecha)\b/i.test(message + replyText)) {
    const qSuffix = `\n\n${replies.enrichFirstContactQualification}`;
    if (!replyText.includes(qSuffix.trim())) replyText = replyText + qSuffix;
  }

  // Date mention injection: if customer asked for prices+fechas and reply lacks fecha/disponibilidad.
  if (safe
    && /\b(?:fecha|disponibilidad|disponible)\b/i.test(message)) {
    const availabilityDates = getFutureAvailableDates(exp);
    if (availabilityDates.length > 0) {
      const dateLabels = availabilityDates.slice(0, 2).map(d => {
        const dObj = new Date(d.date + 'T00:00:00');
        return dObj.toLocaleDateString(lang === 'es' ? 'es-CO' : 'en-US', { day: 'numeric', month: 'long' });
      });
      if (!dateLabels.some(date => replyText.includes(date))) {
        const dateRefs = dateLabels.join(lang === 'es' ? ' y ' : ' and ');
        replyText = `${stripTrailingQuestion(replyText)}\n\n${replies.enrichPublishedDates.replace('{{dates}}', dateRefs)}`;
      }
    }
  }

  // Bus recommendation injection: transport budget shock without bus mention.
  if (safe
    && /\b(?:se sali[oó]|fuera de (?:mi |presupuesto)|muy caro|es mucho)\b/i.test(message)
    && /\b(?:transporte)\b/i.test(message)
    && !/\b(?:bus)\b.{0,30}\b(?:chivor|boyac[aá])\b/i.test(replyText.toLowerCase())) {
    replyText = `${replyText}\n\n${replies.enrichBusAlternative.replace('{{meetingPoint}}', exp.meetingPoint)}`;
  }

  if (safe
    && /\b(?:por\s+qu[eé]|porque)\s+(?:tan\s+)?caro\b/i.test(message)
    && /\b(?:transporte|4x4)\b/i.test(message)) {
    const complete = /\bprivad[oa]\b/i.test(replyText)
      && /\b(?:grupo|grupos|compart(?:e|ir)|group|share)\b/i.test(replyText)
      && /\b(?:carro propio|moto|veh[ií]culo propio|own car|motorcycle|own vehicle)\b/i.test(replyText);
    if (!complete) {
      const trustedReply = getCommonQuestions(exp)
        .find(question => question.lang === lang && question.intent === 'transport_cost_objection')?.answer;
      if (trustedReply) replyText = trustedReply;
    }
  }

  // Re-engagement date options: soft decline re-engagement missing concrete dates.
  if (safe
    && /\b(?:coordin[ea]|retom[ea])\b/i.test(message)) {
    const futureDates = getFutureAvailableDates(exp);
    if (futureDates.length > 0 && !/\b(?:\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre))\b/i.test(replyText)) {
      const dateRefs = futureDates.slice(0, 2).map(d => {
        const dObj = new Date(d.date + 'T00:00:00');
        return dObj.toLocaleDateString(lang === 'es' ? 'es-CO' : 'en-US', { day: 'numeric', month: 'long' });
      }).join(lang === 'es' ? ' y ' : ' and ');
      if (dateRefs && !replyText.includes(dateRefs)) {
        const dateSuffix = ` ${replies.enrichReengagementDates.replace('{{dates}}', dateRefs)}`;
        replyText = replyText.replace(/\.\s*$/, dateSuffix);
      }
    }
  }

  return replyText;
}
