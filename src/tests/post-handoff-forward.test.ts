import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { loadSkills } from '../services/skill-loader.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { extractMessages, forwardBridgeMessage, forwardPostHandoffMessage, forwardPostHandoffMedia, notifyAssignedLineIfDormant, type ExtractedMessage } from '../routes/whatsapp-webhook.route.js';
import { formatLeadHistory } from '../commands/lead-format.js';

const { mockSendTelegram, mockSendTelegramPhoto, mockSendTelegramVoice, mockDownloadMedia } = vi.hoisted(() => ({
  mockSendTelegram: vi.fn<(_chatId: string, _text: string) => Promise<void>>(() => Promise.resolve()),
  mockSendTelegramPhoto: vi.fn<(_chatId: string, _buf: Buffer, _mime: string, _caption?: string) => Promise<void>>(() => Promise.resolve()),
  mockSendTelegramVoice: vi.fn<(_chatId: string, _buf: Buffer, _mime: string) => Promise<void>>(() => Promise.resolve()),
  mockDownloadMedia: vi.fn<(_id: string) => Promise<{ buffer: Buffer; mimeType: string }>>(() =>
    Promise.resolve({ buffer: Buffer.from('img'), mimeType: 'image/jpeg' })),
}));

vi.mock('../services/telegram-bot.js', () => ({
  sendTelegramMessage: mockSendTelegram,
  sendTelegramPhoto: mockSendTelegramPhoto,
  sendTelegramVoice: mockSendTelegramVoice,
}));

vi.mock('../services/whatsapp-client.js', () => ({
  downloadMedia: mockDownloadMedia,
  sendText: vi.fn(() => Promise.resolve()),
  sendImageUrl: vi.fn(() => Promise.resolve()),
}));

const PHONE = '573001112233';

const routing: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'Bridge', weight: 50, telegramChatId: '111', agentName: 'Heinner' },
    { id: 'line2_referral', type: 'referral', label: 'Referral', weight: 50, telegramChatId: '222', agentName: 'Alexandra', displayNumber: '+573001112233' },
  ],
};

let db: Database.Database;
let repos: Repositories;
let previousRoutingJson: string;
let previousTelegramChatId: string;

function msg(text: string, id = 'wamid-1'): ExtractedMessage {
  return { from: PHONE, id, type: 'text', text, media: null, timestamp: '' };
}

function imgMsg(caption: string, id = 'wamid-img', mediaId = 'media-1'): ExtractedMessage {
  return { from: PHONE, id, type: 'image', text: caption, media: { id: mediaId, mimeType: 'image/jpeg' }, timestamp: '' };
}

function audioMsg(id = 'wamid-audio', mediaId = 'media-audio'): ExtractedMessage {
  return { from: PHONE, id, type: 'audio', text: '', media: { id: mediaId, mimeType: 'audio/ogg' }, timestamp: '' };
}

function videoMsg(caption = '', id = 'wamid-video', mediaId = 'media-video'): ExtractedMessage {
  return { from: PHONE, id, type: 'video', text: caption, media: { id: mediaId, mimeType: 'video/mp4' }, timestamp: '' };
}

function seedHandedOff(lineId: 'line1_bridge' | 'line2_referral', chatId: '111' | '222'): void {
  repos.conversation.upsert(PHONE, { language: 'es' });
  repos.conversation.setAssignment(PHONE, { assignedLineId: lineId, assignedAgentChat: chatId });
  repos.conversation.setHandedOff(PHONE);
}

beforeEach(() => {
  loadSkills();
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousRoutingJson = env.LEAD_ROUTING_JSON;
  previousTelegramChatId = env.TELEGRAM_CHAT_ID;
  env.LEAD_ROUTING_JSON = JSON.stringify(routing);
  // Owner chat must be non-empty: isOwnerChat('') is false by design, and CI
  // does not load .env.dev so TELEGRAM_CHAT_ID defaults to ''.
  env.TELEGRAM_CHAT_ID = 'owner-chat';
  resetRoutingConfigCache();
  mockSendTelegram.mockReset();
  mockSendTelegram.mockResolvedValue(undefined);
  mockSendTelegramPhoto.mockReset();
  mockSendTelegramPhoto.mockResolvedValue(undefined);
  mockSendTelegramVoice.mockReset();
  mockSendTelegramVoice.mockResolvedValue(undefined);
  mockDownloadMedia.mockReset();
  mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('img'), mimeType: 'image/jpeg' });
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  env.TELEGRAM_CHAT_ID = previousTelegramChatId;
  resetRoutingConfigCache();
  db.close();
});

describe('extractMessages', () => {
  it('extracts WhatsApp video messages', () => {
    const messages = extractMessages({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'entry-1',
        changes: [{
          field: 'messages',
          value: {
            messages: [{
              from: PHONE,
              id: 'wamid-video',
              type: 'video',
              video: { id: 'media-video', mime_type: 'video/mp4', caption: 'clip' },
            }],
          },
        }],
      }],
    });

    expect(messages).toEqual([{
      from: PHONE,
      id: 'wamid-video',
      type: 'video',
      text: 'clip',
      media: { id: 'media-video', mimeType: 'video/mp4' },
      timestamp: '',
    }]);
  });
});

describe('formatLeadHistory', () => {
  it('caps long chat history to a Telegram-safe response', () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    for (let i = 0; i < 80; i++) {
      repos.message.addMessage({
        customer_phone: PHONE,
        direction: i % 2 === 0 ? 'inbound' : 'outbound',
        message_type: 'text',
        body: `mensaje largo ${i} ${'x'.repeat(200)}`,
        created_at: new Date(Date.now() + i).toISOString(),
      });
    }
    const conv = repos.conversation.getByPhone(PHONE);
    if (!conv) throw new Error('missing conversation');

    const history = formatLeadHistory(conv, repos.message.getRecentMessages(PHONE, 500));

    expect(history.length).toBeLessThan(4096);
    expect(history).toContain('older omitted');
    expect(history).toContain('mensaje largo 79');
  });
});

describe('forwardPostHandoffMessage', () => {
  it('notifies referral agent and returns deterministic customer reply after handoff', async () => {
    seedHandedOff('line2_referral', '222');

    const result = await forwardPostHandoffMessage(repos, msg('Me das mas info?'));

    expect(result).toContain('Ya tengo');
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][0]).toBe('222');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('Responder desde WhatsApp Business app: +573001112233');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('https://wa.me/573001112233');
    expect(repos.message.getLastInboundBodies(PHONE, 1)[0]?.body).toBe('Me das mas info?');
  });

  it('notifies bridge agent with /bridge instructions when no live bridge session exists', async () => {
    seedHandedOff('line1_bridge', '111');
    repos.conversation.setMode(PHONE, 'bridge_active');

    const result = await forwardPostHandoffMessage(repos, msg('Hola?', 'wamid-2'));

    expect(result).toBeTruthy();
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][0]).toBe('111');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('/bridge 573001112233');
  });

  it('does not notify opted-out customers', async () => {
    seedHandedOff('line2_referral', '222');
    repos.optOut.setOptOut(PHONE);

    const result = await forwardPostHandoffMessage(repos, msg('Hola?', 'wamid-3'));

    expect(result).toBeNull();
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('returns null and does not notify when the bot is paused', async () => {
    seedHandedOff('line2_referral', '222');
    repos.setPaused(true);

    const result = await forwardPostHandoffMessage(repos, msg('Hola?', 'wamid-4'));

    expect(result).toBeNull();
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('returns null for a customer that was never handed off', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line2_referral', assignedAgentChat: '222' });

    const result = await forwardPostHandoffMessage(repos, msg('Hola?', 'wamid-5'));

    expect(result).toBeNull();
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('stores the inbound exactly once', async () => {
    seedHandedOff('line2_referral', '222');

    await forwardPostHandoffMessage(repos, msg('Una pregunta', 'wamid-6'));

    const inbound = repos.message.getLastInboundBodies(PHONE, 10).filter(m => m.body === 'Una pregunta');
    expect(inbound).toHaveLength(1);
  });
  it('returns IG soft-close without Telegram notification on post-handoff decline', async () => {
    seedHandedOff('line1_bridge', '111');
    repos.conversation.setMode(PHONE, 'bridge_active');
    mockSendTelegram.mockClear();

    const result = await forwardPostHandoffMessage(repos, msg('Esta costoso gracias'));

    expect(result).toContain('https://www.instagram.com/andean_scapes/');
    expect(result).toContain('te interesa');
    expect(mockSendTelegram).not.toHaveBeenCalled();
    expect(repos.conversation.getSoftClosedAt(PHONE)).toBeTruthy();
    expect(repos.conversation.getHandedOffAt(PHONE)).toBeNull();
    expect(repos.conversation.getAssignment(PHONE)).toBeNull();
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
    expect(repos.message.getLastInboundBodies(PHONE, 1)[0]?.body).toBe('Esta costoso gracias');
  });

  it('does not keep routing post-handoff re-engagement to Telegram after decline', async () => {
    seedHandedOff('line1_bridge', '111');
    await forwardPostHandoffMessage(repos, msg('Esta costoso gracias', 'wamid-decline'));
    mockSendTelegram.mockClear();

    const result = await forwardPostHandoffMessage(repos, msg('Hola', 'wamid-reengage'));

    expect(result).toBeNull();
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('still notifies referral agent for non-decline post-handoff messages', async () => {
    seedHandedOff('line2_referral', '222');
    mockSendTelegram.mockClear();

    await forwardPostHandoffMessage(repos, msg('Hola necesito ayuda urgente'));

    expect(mockSendTelegram).toHaveBeenCalled();
  });
});

describe('forwardBridgeMessage', () => {
  it('forwards an owner bridge when lead routing is disabled', async () => {
    env.LEAD_ROUTING_JSON = '';
    resetRoutingConfigCache();
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open(env.TELEGRAM_CHAT_ID, PHONE);

    const forwarded = await forwardBridgeMessage(repos, msg('Hola owner', 'wamid-owner-bridge'));

    expect(forwarded).toBe(true);
    expect(mockSendTelegram).toHaveBeenCalledWith(env.TELEGRAM_CHAT_ID, expect.stringContaining('Hola owner'));
    expect(repos.conversation.getMode(PHONE)).toBe('bridge_active');
  });

  it('closes a stale non-owner bridge when lead routing is disabled', async () => {
    env.LEAD_ROUTING_JSON = '';
    resetRoutingConfigCache();
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('removed-agent', PHONE);

    const forwarded = await forwardBridgeMessage(repos, msg('Mensaje privado', 'wamid-stale-bridge'));

    expect(forwarded).toBe(false);
    expect(mockSendTelegram).not.toHaveBeenCalled();
    expect(repos.bridgeSession.getByCustomer(PHONE)).toBeNull();
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
  });

  it('closes a bridge session whose line changed to referral', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('222', PHONE);

    const forwarded = await forwardBridgeMessage(repos, msg('Mensaje privado', 'wamid-referral-bridge'));

    expect(forwarded).toBe(false);
    expect(mockSendTelegram).not.toHaveBeenCalled();
    expect(repos.bridgeSession.getByCustomer(PHONE)).toBeNull();
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
  });

  it('reopens the bot path when active bridge Telegram delivery fails', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('111', PHONE);
    mockDownloadMedia.mockResolvedValueOnce({ buffer: Buffer.from('voice'), mimeType: 'audio/ogg' });
    mockSendTelegram.mockRejectedValueOnce(new Error('telegram down'));

    const forwarded = await forwardBridgeMessage(repos, msg('Hola agente', 'wamid-bridge-fail'));

    expect(forwarded).toBe(false);
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
    expect(repos.bridgeSession.getByAgentChat('111')).toBeNull();
    const inbound = repos.message.getLastInboundBodies(PHONE, 10).filter(m => m.body === 'Hola agente');
    expect(inbound).toHaveLength(1);
  });

  it('forwards a customer image to the agent as a Telegram photo during an active bridge', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('111', PHONE);

    const forwarded = await forwardBridgeMessage(repos, imgMsg('comprobante de pago'));

    expect(forwarded).toBe(true);
    expect(mockDownloadMedia).toHaveBeenCalledWith('media-1');
    expect(mockSendTelegramPhoto).toHaveBeenCalledTimes(1);
    const [chatId, buffer, mime, caption] = mockSendTelegramPhoto.mock.calls[0];
    expect(chatId).toBe('111');
    expect(buffer).toBeInstanceOf(Buffer);
    expect(mime).toBe('image/jpeg');
    expect(caption).toContain('comprobante de pago');
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('stores the inbound image as message_type image', async () => {
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('111', PHONE);

    await forwardBridgeMessage(repos, imgMsg(''));

    const inbound = repos.message.getLastInboundBodies(PHONE, 10);
    expect(inbound).toHaveLength(1);
  });

  it('keeps the bridge open and notifies the agent when image download fails', async () => {
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('111', PHONE);
    mockDownloadMedia.mockRejectedValueOnce(new Error('graph 404'));

    const forwarded = await forwardBridgeMessage(repos, imgMsg('x', 'wamid-img-fail'));

    // Transient relay error: do not silently drop or hand back to the bot.
    expect(forwarded).toBe(true);
    expect(repos.conversation.getMode(PHONE)).toBe('bridge_active');
    expect(repos.bridgeSession.getByAgentChat('111')).not.toBeNull();
    expect(mockSendTelegramPhoto).not.toHaveBeenCalled();
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('no se pudo descargar');
  });

  it('forwards a customer voice note to the agent as a Telegram voice during an active bridge', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('111', PHONE);
    mockDownloadMedia.mockResolvedValueOnce({ buffer: Buffer.from('voice'), mimeType: 'audio/ogg' });

    const forwarded = await forwardBridgeMessage(repos, audioMsg());

    expect(forwarded).toBe(true);
    expect(mockDownloadMedia).toHaveBeenCalledWith('media-audio');
    expect(mockSendTelegramVoice).toHaveBeenCalledTimes(1);
    const [chatId, buf, mime] = mockSendTelegramVoice.mock.calls[0];
    expect(chatId).toBe('111');
    expect(buf).toBeInstanceOf(Buffer);
    expect(mime).toBe('audio/ogg');
    expect(mockSendTelegram).toHaveBeenCalled(); // "Audio de X" text notification
  });

  it('notifies customer video while bridge is active', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('111', PHONE);

    const forwarded = await forwardBridgeMessage(repos, videoMsg());

    expect(forwarded).toBe(true);
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('Video de 573001112233');
    expect(repos.message.getRecentMessages(PHONE, 1)[0]?.messageType).toBe('video');
  });

  it('keeps the bridge open and notifies the agent when customer audio download fails', async () => {
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('111', PHONE);
    mockDownloadMedia.mockRejectedValueOnce(new Error('graph 404'));

    const forwarded = await forwardBridgeMessage(repos, audioMsg('wamid-audio-fail'));

    expect(forwarded).toBe(true);
    expect(repos.conversation.getMode(PHONE)).toBe('bridge_active');
    expect(mockSendTelegramVoice).not.toHaveBeenCalled();
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('audio');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('no se pudo descargar');
  });
});

describe('forwardPostHandoffMedia', () => {
  it('downloads and forwards post-handoff customer image to assigned agent', async () => {
    seedHandedOff('line1_bridge', '111');
    mockDownloadMedia.mockResolvedValueOnce({ buffer: Buffer.from('imgdata'), mimeType: 'image/jpeg' });

    const forwarded = await forwardPostHandoffMedia(repos, imgMsg('cedula'));

    expect(forwarded).toBe(true);
    expect(mockDownloadMedia).toHaveBeenCalledWith('media-1');
    expect(mockSendTelegramPhoto).toHaveBeenCalledTimes(1);
    const [chatId, buf, mime, caption] = mockSendTelegramPhoto.mock.calls[0];
    expect(chatId).toBe('111');
    expect(buf).toBeInstanceOf(Buffer);
    expect(mime).toBe('image/jpeg');
    expect(caption).toContain('envio una imagen');
    expect(repos.message.getRecentMessages(PHONE, 1)[0]?.messageType).toBe('image');
  });

  it('downloads and forwards post-handoff customer audio to assigned agent', async () => {
    seedHandedOff('line1_bridge', '111');
    mockDownloadMedia.mockResolvedValueOnce({ buffer: Buffer.from('voice'), mimeType: 'audio/ogg' });

    const forwarded = await forwardPostHandoffMedia(repos, audioMsg());

    expect(forwarded).toBe(true);
    expect(mockDownloadMedia).toHaveBeenCalledWith('media-audio');
    expect(mockSendTelegramVoice).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('envio un audio');
    expect(repos.message.getRecentMessages(PHONE, 1)[0]?.messageType).toBe('audio');
  });

  it('falls back to text notice when post-handoff image download fails', async () => {
    seedHandedOff('line1_bridge', '111');
    mockDownloadMedia.mockRejectedValueOnce(new Error('graph 404'));

    const forwarded = await forwardPostHandoffMedia(repos, imgMsg('', 'wamid-img-fail'));

    expect(forwarded).toBe(true);
    expect(mockSendTelegramPhoto).not.toHaveBeenCalled();
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('envio una imagen');
  });
});

describe('notifyAssignedLineIfDormant', () => {
  it('notifies the assigned bridge agent when mode is bot and assignment exists', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    // mode is already 'bot' by default — simulating after /end

    const result = await notifyAssignedLineIfDormant(repos, msg('Hola de nuevo'));

    // Dormant notify never short-circuits; text inbound is stored by processMessage.
    expect(result).toBe(false);
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][0]).toBe('111');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('/bridge 573001112233');
    expect(repos.message.getLastInboundBodies(PHONE, 1)).toHaveLength(0);
  });

  it('does not notify when mode is bridge_active', async () => {
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setMode(PHONE, 'bridge_active');

    await notifyAssignedLineIfDormant(repos, msg('Hola'));

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('notifies assigned bridge agent when mode is human_pending without short-circuiting bot', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setMode(PHONE, 'human_pending');

    const result = await notifyAssignedLineIfDormant(repos, msg('Sigo esperando confirmacion'));

    expect(result).toBe(false);
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][0]).toBe('111');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('/bridge');
  });

  it('does not notify when opt-out', async () => {
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.optOut.setOptOut(PHONE);

    await notifyAssignedLineIfDormant(repos, msg('Hola'));

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('does not notify for referral lines', async () => {
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line2_referral', assignedAgentChat: '222' });

    await notifyAssignedLineIfDormant(repos, msg('Hola'));

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('does not notify when already handed off', async () => {
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setHandedOff(PHONE);

    await notifyAssignedLineIfDormant(repos, msg('Hola'));

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('does not notify when bot is paused', async () => {
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.setPaused(true);

    await notifyAssignedLineIfDormant(repos, msg('Hola'));

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('downloads and sends dormant customer image as Telegram photo', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    mockDownloadMedia.mockResolvedValueOnce({ buffer: Buffer.from('imgdata'), mimeType: 'image/jpeg' });

    const result = await notifyAssignedLineIfDormant(repos, imgMsg('comprobante'));
    const conv = repos.conversation.getByPhone(PHONE);
    if (!conv) throw new Error('missing conversation');
    const history = formatLeadHistory(conv, repos.message.getRecentMessages(PHONE, 500));

    expect(result).toBe(false);
    expect(mockSendTelegramPhoto).toHaveBeenCalledTimes(1);
    const [, , , caption] = mockSendTelegramPhoto.mock.calls[0];
    expect(caption).toContain('envio una imagen');
    expect(caption).toContain('/bridge');
    expect(history).toContain('📷 comprobante');
  });

  it('falls back to text notice when dormant media download fails', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    mockDownloadMedia.mockRejectedValueOnce(new Error('graph 404'));

    const result = await notifyAssignedLineIfDormant(repos, imgMsg('', 'wamid-img-fail'));

    expect(result).toBe(false);
    expect(mockSendTelegramPhoto).not.toHaveBeenCalled();
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('envio una imagen');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('/bridge');
  });

  it('downloads and sends dormant customer audio as Telegram voice + text notice', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    mockDownloadMedia.mockResolvedValueOnce({ buffer: Buffer.from('voicedata'), mimeType: 'audio/ogg' });

    const result = await notifyAssignedLineIfDormant(repos, audioMsg());
    const conv = repos.conversation.getByPhone(PHONE);
    if (!conv) throw new Error('missing conversation');
    const history = formatLeadHistory(conv, repos.message.getRecentMessages(PHONE, 500));

    expect(result).toBe(false);
    expect(mockSendTelegramVoice).toHaveBeenCalledTimes(1);
    const [, buf,] = mockSendTelegramVoice.mock.calls[0];
    expect(buf).toBeInstanceOf(Buffer);
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('envio un audio');
    expect(history).toContain('🎤 audio');
  });

  it('notifies dormant bridge agent for video and keeps media in chat history', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });

    const result = await notifyAssignedLineIfDormant(repos, videoMsg());
    const conv = repos.conversation.getByPhone(PHONE);
    if (!conv) throw new Error('missing conversation');
    const history = formatLeadHistory(conv, repos.message.getRecentMessages(PHONE, 500));

    expect(result).toBe(false);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('envio un video');
    expect(history).toContain('🎥 video');
  });
});
