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
    repos.paymentReservation.createPending(
      preference.externalReference,
      preference.customerPhone,
      preference.amountCop,
    );
  } catch {
    logger.warn('[MERCADOPAGO] could not create payment reservation');
    return null;
  }

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
    return null;
  }

  if (!response.ok) {
    logger.warn({ status: response.status }, '[MERCADOPAGO] preference request rejected');
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    logger.warn('[MERCADOPAGO] preference response was not JSON');
    return null;
  }

  const parsedResponse = preferenceResponseSchema.safeParse(payload);
  if (!parsedResponse.success) {
    logger.warn('[MERCADOPAGO] preference response was invalid');
    return null;
  }

  try {
    repos.paymentReservation.attachPreference(preference.externalReference, parsedResponse.data.id);
  } catch {
    logger.warn('[MERCADOPAGO] could not attach payment preference');
    return null;
  }

  return {
    paymentUrl: parsedResponse.data.init_point,
    preferenceId: parsedResponse.data.id,
  };
}
