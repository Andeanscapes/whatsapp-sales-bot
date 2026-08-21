import { randomUUID } from 'crypto';
import { env } from '../config/env.js';
import { getSkills, isDynamicDataFresh, type Skills } from '../services/skill-loader.js';
import { findActiveExperience, getPlans, getPublicPaymentFacts, hasPublicPaymentFacts, isPricingAvailable } from '../services/product-registry.js';
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
  if (pending) {
    if (!pending.paymentUrl || !pending.date || pending.depositPercent == null) {
      return `Ya existe un enlace de pago en proceso para ${phone}. No se creo otro cobro.`;
    }
    const result = await sendBridgeReply(
      ctx.repos,
      phone,
      paymentLinkReply(skills, lang, pending.date, pending.depositPercent, pending.paymentUrl),
    );
    return result.ok ? `Enlace de pago pendiente reenviado a ${phone}.` : result.message;
  }

  if (!isDynamicDataFresh()) return 'No puedo crear el enlace: precios o disponibilidad requieren verificacion.';
  if (!hasPublicPaymentFacts(skills)) return 'No hay condiciones de anticipo autorizadas para crear el enlace.';
  const experience = findActiveExperience(skills, ctx.repos.conversation.getSelectedExperienceId(phone));
  if (!experience) return 'No hay una experiencia activa para crear el enlace.';
  if (!isPricingAvailable(experience)) return 'No hay precios actualizados para crear el enlace.';
  const paymentFacts = getPublicPaymentFacts(skills);

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
  if (!preference) return 'No pude crear el enlace de pago. No se envio ningun cobro al cliente.';

  const customerReply = paymentLinkReply(skills, lang, date, paymentFacts.depositPercent, preference.paymentUrl);
  const result = await sendBridgeReply(ctx.repos, phone, customerReply);
  return result.ok ? `Enlace de pago enviado a ${phone}.` : result.message;
}
