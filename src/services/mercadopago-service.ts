import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { Repositories } from '../db/repositories/index.js';

const preferenceInputSchema = z.object({
  customerPhone: z.string().trim().min(1),
  title: z.string().trim().min(1),
  amountCop: z.number().int().positive(),
  externalReference: z.string().trim().min(1),
  notificationUrl: z.string().url().refine(value => new URL(value).protocol === 'https:', 'must use HTTPS'),
  planId: z.string().trim().min(1),
  date: z.string().trim().min(1),
  people: z.number().int().positive(),
  transportNeed: z.string().trim().min(1).nullable(),
  depositPercent: z.number().int().positive(),
  availabilityConfirmedAt: z.string().datetime({ offset: true }),
});

const preferenceResponseSchema = z.object({
  id: z.string().min(1),
  init_point: z.string().url().refine(value => new URL(value).protocol === 'https:', 'must use HTTPS'),
});

export interface MercadoPagoPreferenceInput {
  customerPhone: string;
  title: string;
  amountCop: number;
  externalReference: string;
  notificationUrl: string;
  planId: string;
  date: string;
  people: number;
  transportNeed: string | null;
  depositPercent: number;
  availabilityConfirmedAt: string;
}

export interface MercadoPagoPreferenceResult {
  paymentUrl: string;
  preferenceId: string;
}

export async function createMercadoPagoPreference(
  input: MercadoPagoPreferenceInput,
  repos: Repositories,
): Promise<MercadoPagoPreferenceResult | null> {
  const parsedInput = preferenceInputSchema.safeParse(input);
  if (!parsedInput.success) {
    logger.warn('[MERCADOPAGO] invalid preference input');
    return null;
  }

  const preference = parsedInput.data;
  if (!env.MERCADOPAGO_ACCESS_TOKEN) {
    logger.warn('[MERCADOPAGO] access token is not configured');
    return null;
  }

  try {
    const created = repos.paymentReservation.createPending({
      externalReference: preference.externalReference,
      customerPhone: preference.customerPhone,
      expectedAmountCop: preference.amountCop,
      planId: preference.planId,
      date: preference.date,
      people: preference.people,
      transportNeed: preference.transportNeed,
      depositPercent: preference.depositPercent,
      availabilityConfirmedAt: preference.availabilityConfirmedAt,
    });
    if (!created) return null;
  } catch {
    logger.warn('[MERCADOPAGO] could not create payment reservation');
    return null;
  }

  const failPending = (): null => {
    try {
      repos.paymentReservation.markFailed(preference.externalReference);
    } catch {
      logger.warn('[MERCADOPAGO] could not mark payment reservation failed');
    }
    return null;
  };

  let response: Response;
  try {
    response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{
          title: preference.title,
          quantity: 1,
          currency_id: 'COP',
          unit_price: preference.amountCop,
        }],
        external_reference: preference.externalReference,
        notification_url: preference.notificationUrl,
      }),
    });
  } catch {
    logger.warn('[MERCADOPAGO] preference request failed');
    return failPending();
  }

  if (!response.ok) {
    logger.warn({ status: response.status }, '[MERCADOPAGO] preference request rejected');
    return failPending();
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    logger.warn('[MERCADOPAGO] preference response was not JSON');
    return failPending();
  }

  const parsedResponse = preferenceResponseSchema.safeParse(payload);
  if (!parsedResponse.success) {
    logger.warn('[MERCADOPAGO] preference response was invalid');
    return failPending();
  }

  try {
    repos.paymentReservation.attachPreference(
      preference.externalReference,
      parsedResponse.data.id,
      parsedResponse.data.init_point,
    );
  } catch {
    logger.warn('[MERCADOPAGO] could not attach payment preference');
    return failPending();
  }

  return {
    paymentUrl: parsedResponse.data.init_point,
    preferenceId: parsedResponse.data.id,
  };
}
