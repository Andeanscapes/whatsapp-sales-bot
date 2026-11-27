import { randomUUID } from 'crypto';
import { env } from '../config/env.js';
import { getSkills, isDynamicDataFresh, type Skills } from '../services/skill-loader.js';
import { findActiveExperience, getPlans, getPublicPaymentFactsForPlan, hasPublicPaymentFacts, isPlanPaused, isPricingAvailable } from '../services/product-registry.js';
import { calculatePriceQuote, type TransportNeed } from '../services/pricing-calculator.js';
import { createMercadoPagoPreference } from '../services/mercadopago-service.js';
import { sendBridgeReply } from '../services/bridge-service.js';
import { normalizeCommandPhone } from './phone.js';
import type { CommandContext } from './index.js';

function transportNeed(value: string | null): TransportNeed | undefined {
  return value === 'own' || value === 'from_bogota' || value === 'public_bus' || value === 'yes'
    ? value
    : undefined;
}

function paymentLinkReply(
  skills: Skills,
  lang: 'es' | 'en',
  date: string,
  depositPercent: number,
  paymentUrl: string,
): string {
  return skills.fallbackReplies[lang].paymentLinkSent
    .replaceAll('{{date}}', date)
    .replaceAll('{{deposit}}', String(depositPercent))
    .replaceAll('{{paymentUrl}}', paymentUrl);
}

export async function paymentHandler(ctx: CommandContext): Promise<string> {
  const phone = normalizeCommandPhone(ctx.args[0]);
  if (!phone || ctx.args[1]?.toLowerCase() !== 'confirm') {
    return 'Uso: /payment <telefono> confirm. Usa confirm solo despues de validar disponibilidad.';
  }
  if (!env.MERCADOPAGO_ACCESS_TOKEN || !env.MERCADOPAGO_WEBHOOK_SECRET) {
    return 'Mercado Pago no esta configurado.';
  }

  const conversation = ctx.repos.conversation.getByPhone(phone);
  if (!conversation) return `No encontre el lead ${phone}.`;
  if (conversation.converted_at) return 'La reserva ya esta confirmada.';

  const skills = getSkills();
  const lang = conversation.language === 'en' ? 'en' : 'es';

  const pending = ctx.repos.paymentReservation.getPendingByCustomerPhone(phone);
  let stalePending: typeof pending = null;
  if (pending) {
    if (!isDynamicDataFresh()) return 'No puedo reenviar el enlace: precios o disponibilidad requieren verificacion.';
    const experience = findActiveExperience(skills, conversation.selected_experience_id);
    if (!experience || isPlanPaused(experience, pending.planId)
      || !getPlans(experience).some(plan => plan.id === pending.planId)) {
      return 'El plan de la reserva pendiente ya no esta disponible. No se reenvio el enlace.';
    }
    if (!pending.paymentUrl || !pending.date || pending.depositPercent == null) {
      return `Ya existe un enlace de pago en proceso para ${phone}. No se creo otro cobro.`;
    }
    // P0 2026-11-26: a link whose plan or amount no longer matches the current quote is
    // never re-sent. A new link is created below; the old one is invalidated only after
    // the new one reached the customer.
    const expectedAmount = currentDepositAmount(skills, experience, conversation);
    const stale = expectedAmount == null
      || pending.planId !== conversation.collected_plan
      || expectedAmount !== pending.expectedAmountCop;
    if (!stale) {
      const result = await sendBridgeReply(
        ctx.repos,
        phone,
        paymentLinkReply(skills, lang, pending.date, pending.depositPercent, pending.paymentUrl),
      );
      return result.ok ? `Enlace de pago pendiente reenviado a ${phone}.` : result.message;
    }
    stalePending = pending;
  }

  if (!isDynamicDataFresh()) return 'No puedo crear el enlace: precios o disponibilidad requieren verificacion.';
  if (!hasPublicPaymentFacts(skills)) return 'No hay condiciones de anticipo autorizadas para crear el enlace.';
  const experience = findActiveExperience(skills, ctx.repos.conversation.getSelectedExperienceId(phone));
  if (!experience) return 'No hay una experiencia activa para crear el enlace.';
  if (!isPricingAvailable(experience)) return 'No hay precios actualizados para crear el enlace.';
  const paymentFacts = getPublicPaymentFactsForPlan(skills, experience, conversation.collected_plan);

  const planId = conversation.collected_plan;
  const people = conversation.collected_people;
  const date = conversation.collected_date;
  const missing: string[] = [];
  if (people == null) missing.push('personas');
  if (!planId) missing.push('plan');
  if (!date) missing.push('fecha');
  if (missing.length > 0) {
    return `Faltan ${missing.join(', ')}. No creo un cobro sin esos datos.`;
  }
  if (people == null || !planId || !date) {
    return 'Faltan personas, plan o fecha. No creo un cobro sin esos datos.';
  }
  const quote = calculatePriceQuote(experience, {
    planId,
    people,
    transportNeed: transportNeed(conversation.collected_transport_need),
  });
  if (!quote || quote.total == null || paymentFacts.depositPercent <= 0) {
    return 'No pude calcular un anticipo autorizado.';
  }

  const plan = getPlans(experience).find(item => item.id === planId);
  if (!plan) return 'El plan seleccionado ya no esta disponible.';
  const amountCop = Math.round(quote.total * paymentFacts.depositPercent / 100);
  // One pending link per customer: the stale one steps aside only for this attempt.
  if (stalePending) ctx.repos.paymentReservation.markFailed(stalePending.externalReference);
  const preference = await createMercadoPagoPreference({
    customerPhone: phone,
    title: `Reserva Andean Scapes - ${plan.name}`,
    amountCop,
    externalReference: `as_${randomUUID()}`,
    notificationUrl: new URL('/webhooks/mercadopago', env.PUBLIC_BASE_URL).href,
    planId,
    date,
    people,
    transportNeed: conversation.collected_transport_need,
    depositPercent: paymentFacts.depositPercent,
    availabilityConfirmedAt: new Date().toISOString(),
  }, ctx.repos);
  if (!preference) {
    if (stalePending) ctx.repos.paymentReservation.reopenFailed(stalePending.externalReference);
    return 'No pude crear el enlace de pago. No se envio ningun cobro al cliente.';
  }

  const customerReply = paymentLinkReply(skills, lang, date, paymentFacts.depositPercent, preference.paymentUrl);
  const result = await sendBridgeReply(ctx.repos, phone, customerReply);
  if (stalePending) {
    if (!result.ok) return `${result.message} El enlace anterior (${stalePending.expectedAmountCop} COP) quedo invalidado; repite /payment para reenviar el nuevo.`;
    return `Enlace de pago enviado a ${phone}. El enlace anterior (${stalePending.expectedAmountCop} COP) no coincidia con la cotizacion actual y quedo invalidado; si el cliente lo paga, llegara una alerta para conciliar.`;
  }
  return result.ok ? `Enlace de pago enviado a ${phone}.` : result.message;
}

/** Deposit the current quote authorises; null when it cannot be computed. */
function currentDepositAmount(
  skills: Skills,
  experience: NonNullable<ReturnType<typeof findActiveExperience>>,
  conversation: { collected_plan: string | null; collected_people: number | null; collected_transport_need: string | null },
): number | null {
  if (!conversation.collected_plan || conversation.collected_people == null) return null;
  const quote = calculatePriceQuote(experience, {
    planId: conversation.collected_plan,
    people: conversation.collected_people,
    transportNeed: transportNeed(conversation.collected_transport_need),
  });
  const depositPercent = getPublicPaymentFactsForPlan(skills, experience, conversation.collected_plan).depositPercent;
  return quote?.total == null || depositPercent <= 0 ? null : Math.round(quote.total * depositPercent / 100);
}
