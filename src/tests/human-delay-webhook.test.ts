import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../app.js';
import { env } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { loadSkills } from '../services/skill-loader.js';

const { paceMock, createTurnPacerMock, sendTextMock, processMessageMock } = vi.hoisted(() => {
  const paceMock = vi.fn(() => Promise.resolve(true));
  const createTurnPacerMock = vi.fn(() => ({ pace: paceMock }));
  const sendTextMock = vi.fn(() => Promise.resolve());
  const processMessageMock = vi.fn(async () => ({
    reply: 'Hola, con gusto te ayudo.',
    shouldSendReply: true,
    usedAi: false,
    leadScore: 10,
    shouldAlertOwner: false,
    shouldSendImage: false,
    shouldSendOwnerImage: false,
    shouldSendGalleryImages: false,
    priceJustGiven: false,
    outboundDateAction: null,
    ownerAlertType: null,
  }));
  return { paceMock, createTurnPacerMock, sendTextMock, processMessageMock };
});

vi.mock('../services/human-delay.js', () => ({
  createTurnPacer: createTurnPacerMock,
}));

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
  return {
    ...actual,
    processMessage: processMessageMock,
  };
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
        value: {
          messaging_product: 'whatsapp',
          messages: [{ from: phone, id, type: 'text', text: { body: text } }],
        },
      }],
    }],
  });
}

describe('human-delay webhook wiring', () => {
  let db: Database.Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let previousMessageDelay: boolean;
  let previousWebhookOwnerOnly: boolean;

  beforeEach(async () => {
    loadSkills();
    previousMessageDelay = env.MESSAGE_DELAY;
    previousWebhookOwnerOnly = env.WEBHOOK_OWNER_ONLY_ENABLED;
    env.MESSAGE_DELAY = true;
    env.WEBHOOK_OWNER_ONLY_ENABLED = false;
    paceMock.mockClear();
    createTurnPacerMock.mockClear();
    sendTextMock.mockClear();
    processMessageMock.mockClear();
    db = new Database(':memory:');
    migrate(db);
    app = await buildApp(createRepositories(db));
    await app.ready();
  });

  afterEach(async () => {
    env.MESSAGE_DELAY = previousMessageDelay;
    env.WEBHOOK_OWNER_ONLY_ENABLED = previousWebhookOwnerOnly;
    await app.close();
    db.close();
  });

  it('creates a turn pacer and paces before the bot reply send', async () => {
    const body = inboundPayload('573001112233', 'Hola', 'wamid-delay-1');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(body),
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(processMessageMock).toHaveBeenCalled();
      expect(sendTextMock).toHaveBeenCalled();
    });

    expect(createTurnPacerMock).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Function),
      true,
    );
    expect(paceMock).toHaveBeenCalled();
    expect(paceMock.mock.invocationCallOrder[0]).toBeLessThan(sendTextMock.mock.invocationCallOrder[0]);
  });

  it('passes MESSAGE_DELAY=false into the pacer when flag is off', async () => {
    env.MESSAGE_DELAY = false;
    const body = inboundPayload('573001112244', 'Hola', 'wamid-delay-2');
    await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(body),
      },
      payload: body,
    });

    await vi.waitFor(() => {
      expect(createTurnPacerMock).toHaveBeenCalled();
    });

    expect(createTurnPacerMock).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Function),
      false,
    );
  });

  it('does not send a reply when pacing reports a newer inbound', async () => {
    paceMock.mockResolvedValueOnce(false);
    const body = inboundPayload('573001112255', 'Hola', 'wamid-delay-3');
    await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(body),
      },
      payload: body,
    });

    await vi.waitFor(() => {
      expect(processMessageMock).toHaveBeenCalled();
      expect(paceMock).toHaveBeenCalled();
    });
    expect(sendTextMock).not.toHaveBeenCalled();
  });
});
