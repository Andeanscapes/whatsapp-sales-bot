import { createHmac, timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { Repositories } from '../db/repositories/index.js';
import { logger } from '../config/logger.js';
import { sendAlert } from '../services/alert-service.js';

const notificationSchema = z.object({
  data: z.object({ id: z.union([z.string(), z.number()]) }),
  type: z.string().optional(),
}).passthrough();

const paymentSchema = z.object({
  id: z.union([z.string(), z.number()]),
  status: z.string(),
  external_reference: z.string().nullable().optional(),
  transaction_amount: z.number(),
}).passthrough();

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function signatureParts(value: string): { timestamp: string; signature: string } | null {
  const values = new Map(value.split(',').map(part => {
    const [key, content] = part.trim().split('=', 2);
    return [key, content];
  }));
  const timestamp = values.get('ts');
  const signature = values.get('v1');
  return timestamp && signature ? { timestamp, signature } : null;
}

function sameSignature(expected: string, received: string): boolean {
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(received, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifySignature(request: FastifyRequest, paymentId: string): boolean {
  if (!env.MERCADOPAGO_WEBHOOK_SECRET) return false;
  const signature = headerValue(request, 'x-signature');
  const requestId = headerValue(request, 'x-request-id');
  if (!signature || !requestId) return false;
  const parts = signatureParts(signature);
  if (!parts) return false;
  const manifest = `id:${paymentId};request-id:${requestId};ts:${parts.timestamp};`;
  const expected = createHmac('sha256', env.MERCADOPAGO_WEBHOOK_SECRET).update(manifest).digest('hex');
  return sameSignature(expected, parts.signature);
}

async function fetchPayment(paymentId: string): Promise<z.infer<typeof paymentSchema> | null> {
  if (!env.MERCADOPAGO_ACCESS_TOKEN) return null;
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}` },
  });
  if (!response.ok) return null;
  return paymentSchema.safeParse(await response.json()).data ?? null;
}

export async function mercadoPagoWebhookRoutes(app: FastifyInstance, opts: { repos: Repositories }): Promise<void> {
  app.post('/webhooks/mercadopago', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!env.MERCADOPAGO_ACCESS_TOKEN || !env.MERCADOPAGO_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: 'Payment integration unavailable' });
    }

    const notification = notificationSchema.safeParse(request.body);
    if (!notification.success) return reply.code(400).send({ error: 'Invalid notification' });
    const paymentId = String(notification.data.data.id);
    if (!verifySignature(request, paymentId)) return reply.code(401).send({ error: 'Invalid signature' });

    const payment = await fetchPayment(paymentId);
    if (!payment) return reply.code(502).send({ error: 'Unable to verify payment' });
    if (payment.status !== 'approved' || !payment.external_reference) return reply.code(200).send({ ok: true });

    const reservation = opts.repos.paymentReservation.getByExternalReference(payment.external_reference);
    if (!reservation || reservation.expectedAmountCop !== payment.transaction_amount) return reply.code(200).send({ ok: true });

    if (opts.repos.paymentReservation.markApproved(payment.external_reference, String(payment.id))) {
      logger.info({ paymentId: String(payment.id), externalReference: payment.external_reference }, '[MERCADOPAGO] payment approved');
      const conversation = opts.repos.conversation.getByPhone(reservation.customerPhone);
      await sendAlert({
        customerPhone: reservation.customerPhone,
        score: conversation?.lead_score ?? 0,
        intent: 'payment_received',
        message: 'Pago de reserva aprobado. Confirmar disponibilidad y reserva antes de informar al cliente.',
        name: conversation?.collected_name ?? undefined,
        date: conversation?.collected_date ?? undefined,
        people: conversation?.collected_people != null ? String(conversation.collected_people) : undefined,
        transport: conversation?.collected_transport_need ?? undefined,
      }, opts.repos);
    }
    return reply.code(200).send({ ok: true });
  });
}
