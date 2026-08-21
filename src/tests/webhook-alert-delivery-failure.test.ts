import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '../app.js';
import { env } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { loadSkills } from '../services/skill-loader.js';

const {
  paceMock,
  createTurnPacerMock,
  sendTextMock,
  processMessageMock,
  sendAlertMock,
  logSystemErrorMock,
} = vi.hoisted(() => {
  const paceMock = vi.fn(() => Promise.resolve(true));
  const createTurnPacerMock = vi.fn(() => ({ pace: paceMock }));
  const sendTextMock = vi.fn(() => Promise.resolve());
  const processMessageMock = vi.fn(async () => ({
    reply: 'Listo, quedo validando con el equipo.',
    shouldSendReply: true,
    usedAi: true,
    leadScore: 95,
    shouldAlertOwner: true,
    shouldSendImage: false,
    shouldSendOwnerImage: false,
    shouldSendGalleryImages: false,
    priceJustGiven: false,
    outboundDateAction: null,
    ownerAlertType: 'reservation_handoff' as string,
  }));
  const sendAlertMock = vi.fn(async () => false);
  const logSystemErrorMock = vi.fn();
  return {
    paceMock,
    createTurnPacerMock,
    sendTextMock,
    processMessageMock,
    sendAlertMock,
    logSystemErrorMock,
  };
});

vi.mock('../services/human-delay.js', () => ({
  createTurnPacer: createTurnPacerMock,
}));

vi.mock('../services/whatsapp-client.js', () => ({
  sendText: sendTextMock,
  sendImageUrl: vi.fn(() => Promise.resolve()),
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

vi.mock('../services/alert-service.js', () => ({
  sendAlert: sendAlertMock,
}));

vi.mock('../services/error-logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/error-logger.js')>();
  return {
    ...actual,
    logSystemError: logSystemErrorMock,
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

describe('webhook owner-alert delivery failure', () => {
  let db: Database.Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let previousWebhookOwnerOnly: boolean;

  beforeEach(async () => {
    loadSkills();
    previousWebhookOwnerOnly = env.WEBHOOK_OWNER_ONLY_ENABLED;
    env.WEBHOOK_OWNER_ONLY_ENABLED = false;
    paceMock.mockReset();
    paceMock.mockResolvedValue(true);
    createTurnPacerMock.mockClear();
    sendTextMock.mockClear();
    processMessageMock.mockClear();
    sendAlertMock.mockClear();
    logSystemErrorMock.mockClear();
    sendAlertMock.mockResolvedValue(false);
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

  it('logs critical alert_send when sendAlert returns false', async () => {
    const phone = '573001119999';
    const body = inboundPayload(phone, 'Si', 'wamid-alert-fail-1');
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
      expect(sendAlertMock).toHaveBeenCalled();
      expect(logSystemErrorMock).toHaveBeenCalled();
    });

    expect(logSystemErrorMock).toHaveBeenCalledWith(
      'alert_send',
      'critical',
      expect.objectContaining({ message: 'Owner alert produced no delivered channel' }),
      expect.objectContaining({
        phone,
        alertType: 'reservation_handoff',
        alertChannel: env.ALERT_CHANNEL,
      }),
    );
  });

  // Regression: the alert lives outside the reply branch. Nesting it under a
  // delivered reply loses every silent-handoff and limit-loop lead.
  it('alerts the owner when the engine produces no reply', async () => {
    sendAlertMock.mockResolvedValue(true);
    processMessageMock.mockResolvedValueOnce({
      reply: '',
      shouldSendReply: false,
      usedAi: false,
      leadScore: 90,
      shouldAlertOwner: true,
      shouldSendImage: false,
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      priceJustGiven: false,
      outboundDateAction: null,
      ownerAlertType: 'limit_loop',
    });
    const phone = '573001119998';
    const body = inboundPayload(phone, 'Si', 'wamid-alert-noreply-1');

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
      expect(sendAlertMock).toHaveBeenCalledWith(
        expect.objectContaining({ customerPhone: phone, intent: 'limit_loop' }),
        expect.anything(),
      );
    });
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('alerts the owner even when the reply send fails', async () => {
    sendAlertMock.mockResolvedValue(true);
    sendTextMock.mockRejectedValueOnce(new Error('meta down'));
    const phone = '573001119997';
    const body = inboundPayload(phone, 'Si', 'wamid-alert-sendfail-1');

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
      expect(sendAlertMock).toHaveBeenCalledWith(
        expect.objectContaining({ customerPhone: phone, intent: 'reservation_handoff' }),
        expect.anything(),
      );
    });
  });

  it('alerts the owner when a superseded turn cancels reply delivery', async () => {
    paceMock.mockResolvedValue(false);
    sendAlertMock.mockResolvedValue(true);
    const phone = '573001119996';
    const body = inboundPayload(phone, 'Si', 'wamid-alert-superseded-1');

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
    await vi.waitFor(() => expect(sendAlertMock).toHaveBeenCalled());
    expect(sendTextMock).not.toHaveBeenCalled();
  });
});
