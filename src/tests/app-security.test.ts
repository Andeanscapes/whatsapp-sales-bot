import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../app.js';
import { env } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';

let db: Database.Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let previousVerifyToken: string;
let previousMercadoPagoAccessToken: string;
let previousMercadoPagoWebhookSecret: string;

beforeEach(async () => {
  previousVerifyToken = env.WHATSAPP_VERIFY_TOKEN;
  previousMercadoPagoAccessToken = env.MERCADOPAGO_ACCESS_TOKEN;
  previousMercadoPagoWebhookSecret = env.MERCADOPAGO_WEBHOOK_SECRET;
  env.WHATSAPP_VERIFY_TOKEN = 'verify-test-token';
  env.MERCADOPAGO_ACCESS_TOKEN = 'TEST-access-token';
  env.MERCADOPAGO_WEBHOOK_SECRET = 'test-webhook-secret';
  db = new Database(':memory:');
  migrate(db);
  app = await buildApp(createRepositories(db));
  await app.ready();
});

afterEach(async () => {
  env.WHATSAPP_VERIFY_TOKEN = previousVerifyToken;
  env.MERCADOPAGO_ACCESS_TOKEN = previousMercadoPagoAccessToken;
  env.MERCADOPAGO_WEBHOOK_SECRET = previousMercadoPagoWebhookSecret;
  await app.close();
  db.close();
});

describe('app security controls', () => {
  it('verifies WhatsApp challenge tokens with the configured token', async () => {
    const ok = await app.inject('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-test-token&hub.challenge=abc');
    const wrongLength = await app.inject('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc');
    // Equal length, different content — exercises the timingSafeEqual branch, not the length guard.
    const sameLength = await app.inject('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-test-tokeX&hub.challenge=abc');

    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('abc');
    expect(wrongLength.statusCode).toBe(403);
    expect(sameLength.statusCode).toBe(403);
  });

  it('rate limits public health endpoint', async () => {
    let statusCode = 200;
    for (let i = 0; i < 61; i += 1) {
      const res = await app.inject('/health');
      statusCode = res.statusCode;
    }

    expect(statusCode).toBe(429);
  });

  it('rejects oversized json payloads before webhook processing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ oversized: 'x'.repeat(513 * 1024) }),
    });

    expect(res.statusCode).toBe(413);
  });

  it('rejects Mercado Pago callbacks with an invalid signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/mercadopago',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'request-123',
        'x-signature': 'ts:123,v1:not-a-valid-signature',
      },
      payload: { data: { id: 'payment-123' }, type: 'payment' },
    });

    expect(res.statusCode).toBe(401);
  });
});
