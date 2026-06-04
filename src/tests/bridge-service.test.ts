import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { sendBridgeReply, sendBridgeMedia, isBridgeActive } from '../services/bridge-service.js';
import { isWithinServiceWindow } from '../services/time-window-policy.js';
import * as whatsappClient from '../services/whatsapp-client.js';

const PHONE = '573001112233';

let repos: Repositories;
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  vi.restoreAllMocks();
});

afterEach(() => {
  db.close();
});

function recordInbound(phone: string, createdAt: string): void {
  repos.message.addMessage({
    whatsapp_message_id: `in-${createdAt}`,
    customer_phone: phone,
    direction: 'inbound',
    message_type: 'text',
    body: 'hola',
    created_at: createdAt,
  });
}

describe('sendBridgeReply guards', () => {
  it('blocks when bot is paused', async () => {
    recordInbound(PHONE, new Date().toISOString());
    repos.setPaused(true);
    const sendSpy = vi.spyOn(whatsappClient, 'sendText').mockResolvedValue();

    const result = await sendBridgeReply(repos, PHONE, 'hi');

    expect(result.ok).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('blocks when the customer opted out', async () => {
    recordInbound(PHONE, new Date().toISOString());
    repos.optOut.setOptOut(PHONE);
    const sendSpy = vi.spyOn(whatsappClient, 'sendText').mockResolvedValue();

    const result = await sendBridgeReply(repos, PHONE, 'hi');

    expect(result.ok).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('blocks when outside the 24h service window', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    recordInbound(PHONE, old);
    const sendSpy = vi.spyOn(whatsappClient, 'sendText').mockResolvedValue();

    const result = await sendBridgeReply(repos, PHONE, 'hi');

    expect(result.ok).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('sends and stores outbound when within the window', async () => {
    recordInbound(PHONE, new Date().toISOString());
    const sendSpy = vi.spyOn(whatsappClient, 'sendText').mockResolvedValue();

    const result = await sendBridgeReply(repos, PHONE, 'hola desde el bridge');

    expect(result.ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith(PHONE, 'hola desde el bridge');
    expect(repos.message.getLastOutboundBody(PHONE)).toBe('hola desde el bridge');
  });

  it('surfaces the API error reason and does not store on failure', async () => {
    recordInbound(PHONE, new Date().toISOString());
    vi.spyOn(whatsappClient, 'sendText').mockRejectedValue(new Error('HTTP 470'));

    const result = await sendBridgeReply(repos, PHONE, 'hi');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('HTTP 470');
    expect(repos.message.getLastOutboundBody(PHONE)).toBeNull();
  });
});

describe('sendBridgeMedia guards', () => {
  const img = Buffer.from('fake-jpeg');

  it('blocks when outside the 24h service window and never uploads', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    recordInbound(PHONE, old);
    const uploadSpy = vi.spyOn(whatsappClient, 'uploadMedia').mockResolvedValue({ id: 'media-1', kind: 'image' });

    const result = await sendBridgeMedia(repos, PHONE, img, 'image/jpeg', 'pago');

    expect(result.ok).toBe(false);
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('uploads, sends by media id, and stores an image outbound on success', async () => {
    recordInbound(PHONE, new Date().toISOString());
    const uploadSpy = vi.spyOn(whatsappClient, 'uploadMedia').mockResolvedValue({ id: 'media-1', kind: 'image' });
    const sendSpy = vi.spyOn(whatsappClient, 'sendImageId').mockResolvedValue();

    const result = await sendBridgeMedia(repos, PHONE, img, 'image/jpeg', 'QR de pago');

    expect(result.ok).toBe(true);
    expect(uploadSpy).toHaveBeenCalledWith(img, 'image/jpeg');
    expect(sendSpy).toHaveBeenCalledWith(PHONE, 'media-1', 'QR de pago');
  });

  it('surfaces the API error reason and does not store on failure', async () => {
    recordInbound(PHONE, new Date().toISOString());
    vi.spyOn(whatsappClient, 'uploadMedia').mockRejectedValue(new Error('HTTP 413'));

    const result = await sendBridgeMedia(repos, PHONE, img, 'image/jpeg');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('HTTP 413');
    expect(repos.message.getLastOutboundBody(PHONE)).toBeNull();
  });
});

describe('isBridgeActive', () => {
  it('returns false when mode is not bridge_active', () => {
    expect(isBridgeActive(repos, PHONE)).toBe(false);
  });

  it('reverts mode to bot when marked bridge_active but no session exists', () => {
    repos.conversation.setMode(PHONE, 'bridge_active');

    expect(isBridgeActive(repos, PHONE)).toBe(false);
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
  });

  it('stays active for a fresh session', () => {
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('111', PHONE);

    expect(isBridgeActive(repos, PHONE)).toBe(true);
    expect(repos.conversation.getMode(PHONE)).toBe('bridge_active');
  });

  it('reaps a stale session past the TTL and reverts mode to bot', () => {
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('111', PHONE);

    const future = new Date(Date.now() + 13 * 60 * 60 * 1000);
    expect(isBridgeActive(repos, PHONE, future)).toBe(false);
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
    expect(repos.bridgeSession.getByCustomer(PHONE)).toBeNull();
  });
});

describe('isWithinServiceWindow boundaries', () => {
  it('is false with no inbound message', () => {
    expect(isWithinServiceWindow(repos, PHONE)).toBe(false);
  });

  it('is true just inside the 24h window', () => {
    const now = new Date();
    recordInbound(PHONE, new Date(now.getTime() - (24 * 60 * 60 * 1000 - 1000)).toISOString());
    expect(isWithinServiceWindow(repos, PHONE, now)).toBe(true);
  });

  it('is false at/after exactly 24h', () => {
    const now = new Date();
    recordInbound(PHONE, new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
    expect(isWithinServiceWindow(repos, PHONE, now)).toBe(false);
  });
});
