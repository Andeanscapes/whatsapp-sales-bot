import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHmac } from 'crypto';
import Fastify from 'fastify';
import { env } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { mercadoPagoWebhookRoutes } from '../routes/mercadopago-webhook.route.js';

vi.mock('../services/alert-service.js', () => ({ sendAlert: vi.fn(async () => true) }));
vi.mock('../services/skill-loader.js', () => ({
  getSkills: () => ({ fallbackReplies: { es: { paymentApprovedOwnerAlert: 'pago' } } }),
}));

const PHONE = '573001112233';
const REFERENCE = 'as_booking_1';
const AMOUNT = 150000;
const PAYMENT_ID = '777';
const REQUEST_ID = 'req-1';
const TS = '1700000000';

let db: Database.Database;
let repos: Repositories;
let previousAccessToken: string;
let previousSecret: string;

function sign(paymentId: string): string {
  const manifest = `id:${paymentId};request-id:${REQUEST_ID};ts:${TS};`;
  return createHmac('sha256', env.MERCADOPAGO_WEBHOOK_SECRET).update(manifest).digest('hex');
}

beforeEach(() => {
  previousAccessToken = env.MERCADOPAGO_ACCESS_TOKEN;
  previousSecret = env.MERCADOPAGO_WEBHOOK_SECRET;
  env.MERCADOPAGO_ACCESS_TOKEN = 'TEST-access-token';
  env.MERCADOPAGO_WEBHOOK_SECRET = 'test-webhook-secret';
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  repos.conversation.upsert(PHONE, { language: 'es' });
  repos.paymentReservation.createPending({
    externalReference: REFERENCE,
    customerPhone: PHONE,
    expectedAmountCop: AMOUNT,
    planId: 'core_2d1n_chivor',
    date: '2026-11-14',
    people: 2,
    transportNeed: 'own',
    depositPercent: 15,
    availabilityConfirmedAt: '2026-11-09T12:00:00.000Z',
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ id: PAYMENT_ID, status: 'approved', external_reference: REFERENCE, transaction_amount: AMOUNT }),
  } as unknown as Response);
});

afterEach(() => {
  env.MERCADOPAGO_ACCESS_TOKEN = previousAccessToken;
  env.MERCADOPAGO_WEBHOOK_SECRET = previousSecret;
  vi.restoreAllMocks();
  db.close();
});

async function notify(): Promise<number> {
  const app = Fastify();
  await app.register(async instance => mercadoPagoWebhookRoutes(instance, { repos }));
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/mercadopago',
    headers: {
      'content-type': 'application/json',
      'x-request-id': REQUEST_ID,
      'x-signature': `ts=${TS},v1=${sign(PAYMENT_ID)}`,
    },
    payload: { data: { id: PAYMENT_ID }, type: 'payment' },
  });
  await app.close();
  return res.statusCode;
}

describe('Mercado Pago approval marks the lead as booked', () => {
  it('sets converted_at once the approved payment is recorded', async () => {
    expect(repos.conversation.getBookedAt(PHONE)).toBeNull();

    expect(await notify()).toBe(200);

    expect(repos.conversation.getBookedAt(PHONE)).not.toBeNull();
    expect(repos.paymentReservation.getByExternalReference(REFERENCE)?.status).toBe('approved');
  });

  it('keeps an earlier /booking timestamp when the payment is approved later', async () => {
    repos.conversation.upsert(PHONE, { converted_at: '2026-11-01T10:00:00.000Z' });

    expect(await notify()).toBe(200);

    expect(repos.conversation.getBookedAt(PHONE)).toBe('2026-11-01T10:00:00.000Z');
    expect(repos.paymentReservation.getByExternalReference(REFERENCE)?.status).toBe('approved');
  });

  it('keeps the first booking timestamp on a repeated notification', async () => {
    await notify();
    const first = repos.conversation.getBookedAt(PHONE);

    await notify();

    expect(repos.conversation.getBookedAt(PHONE)).toBe(first);
  });
});
