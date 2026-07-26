import { randomUUID } from 'crypto';
import { env } from '../config/env.js';
import { getSkills, isDynamicDataFresh } from '../services/skill-loader.js';
import { getActiveExperience, getPlans, getPublicPaymentFacts, hasPublicPaymentFacts, isPricingAvailable } from '../services/product-registry.js';
import { calculatePriceQuote, type TransportNeed } from '../services/pricing-calculator.js';
import { createMercadoPagoPreference } from '../services/mercadopago-service.js';
import { sendBridgeReply } from '../services/bridge-service.js';
import type { CommandContext } from './index.js';

function transportNeed(value: string | null): TransportNeed | undefined {
  return value === 'own' || value === 'from_bogota' || value === 'public_bus' ? value : undefined;
}

export async function paymentHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0];
  if (!phone) return 'Uso: /payment <telefono>. Usar solo despues de confirmar disponibilidad.';
  if (!env.MERCADOPAGO_ACCESS_TOKEN || !env.MERCADOPAGO_WEBHOOK_SECRET) {
    return 'Mercado Pago no esta configurado.';
  }
  if (!isDynamicDataFresh()) return 'No puedo crear el enlace: precios o disponibilidad requieren verificacion.';

  const conversation = ctx.repos.conversation.getByPhone(phone);
  if (!conversation) return `No encontre el lead ${phone}.`;
  if (conversation.converted_at) return 'La reserva ya esta confirmada.';
  if (conversation.collected_people == null || !conversation.collected_plan || !conversation.collected_date) {
    return 'Faltan personas, plan o fecha. No creo un cobro sin esos datos.';
  }

  const skills = getSkills();
  if (!hasPublicPaymentFacts(skills)) return 'No hay condiciones de anticipo autorizadas para crear el enlace.';
  const experience = getActiveExperience(skills);
  if (!isPricingAvailable(experience)) return 'No hay precios actualizados para crear el enlace.';
  const quote = calculatePriceQuote(experience, {
    planId: conversation.collected_plan,
    people: conversation.collected_people,
    transportNeed: transportNeed(conversation.collected_transport_need),
  });
  const paymentFacts = getPublicPaymentFacts(skills);
  if (!quote || paymentFacts.depositPercent <= 0) return 'No pude calcular un anticipo autorizado.';

  const plan = getPlans(experience).find(item => item.id === conversation.collected_plan);
  if (!plan) return 'El plan seleccionado ya no esta disponible.';
  const amountCop = Math.round((quote.total ?? quote.planTotal) * paymentFacts.depositPercent / 100);
  const preference = await createMercadoPagoPreference({
    customerPhone: phone,
    title: `Reserva Andean Scapes - ${plan.name}`,
    amountCop,
    externalReference: `as_${randomUUID()}`,
    notificationUrl: new URL('/webhooks/mercadopago', env.PUBLIC_BASE_URL).href,
  }, ctx.repos);
  if (!preference) return 'No pude crear el enlace de pago. No se envio ningun cobro al cliente.';

  const result = await sendBridgeReply(
    ctx.repos,
    phone,
    `Ya validamos disponibilidad para ${conversation.collected_date}. Puedes separar la reserva con el ${paymentFacts.depositPercent}% mediante este enlace seguro: ${preference.paymentUrl}`,
  );
  return result.ok ? `Enlace de pago enviado a ${phone}.` : result.message;
}
