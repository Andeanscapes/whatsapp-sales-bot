import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../app.js';
import { env } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { loadSkills } from '../services/skill-loader.js';

// Real pacer (no human-delay mock): with no first-message wait, a burst is still merged
// because a newer inbound queued while the reply was being generated supersedes it.
const { sendTextMock, processMessageMock, releaseFirst } = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const firstGate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const sendTextMock = vi.fn(() => Promise.resolve());
  const processMessageMock = vi.fn(async () => {
    calls += 1;
    const call = calls;
    if (call === 1) await firstGate;
    return {
      reply: `reply ${call}`,
      shouldSendReply: true,
      usedAi: true,
      leadScore: 10,
      shouldAlertOwner: false,
      shouldSendImage: false,
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      priceJustGiven: false,
      outboundDateAction: null,
      ownerAlertType: null,
    };
  });
  return { sendTextMock, processMessageMock, releaseFirst: () => release() };
});

vi.mock('../services/whatsapp-client.js', () => ({
  sendText: sendTextMock,
  sendImageUrl: vi.fn(() => Promise.resolve({ whatsappMessageId: 'wamid.IMG' })),
  downloadMedia: vi.fn(),
  WhatsAppSendError: class WhatsAppSendError extends Error {
    deliveryUncertain = false;
  },
}));

vi.mock('../services/response-engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/response-engine.js')>();
  return { ...actual, processMessage: processMessageMock };
});

function sign(body: string): string {
  return `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET).update(body).digest('hex')}`;
}

function inboundPayload(phone: string, text: string, id: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'biz',
      changes: [{
        field: 'messages',
        value: { messaging_product: 'whatsapp', messages: [{ from: phone, id, type: 'text', text: { body: text } }] },
      }],
    }],
  });
}

describe('burst merge with no response delay', () => {
  let db: Database.Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let previousWebhookOwnerOnly: boolean;

  beforeEach(async () => {
    loadSkills();
    previousWebhookOwnerOnly = env.WEBHOOK_OWNER_ONLY_ENABLED;
    env.WEBHOOK_OWNER_ONLY_ENABLED = false;
    db = new Database(':memory:');
    migrate(db);
    app = await buildApp(createRepositories(db));
    await app.ready();
  });

  afterEach(async () => {
    env.WEBHOOK_OWNER_ONLY_ENABLED = previousWebhookOwnerOnly;
    await app.close();
    db.close();
  });

  it('three quick messages get one reply, from the newest turn', async () => {
    const phone = '573001119901';
    for (const [index, text] of ['Hola', 'quiero info', 'somos 2'].entries()) {
      const body = inboundPayload(phone, text, `wamid-burst-${index}`);
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
    }

    releaseFirst();

    await vi.waitFor(() => {
      expect(processMessageMock).toHaveBeenCalledTimes(3);
      expect(sendTextMock).toHaveBeenCalledTimes(1);
    });
    expect(sendTextMock).toHaveBeenCalledWith(phone, 'reply 3');
  });
});
