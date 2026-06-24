import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { logger } from '../config/logger.js';
import * as whatsappClient from '../services/whatsapp-client.js';
import { processUpdate, registerCommands, type TelegramUpdate } from '../services/telegram-bot.js';

const CUSTOMER = '573001112233';

const config: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'Booking', weight: 50, telegramChatId: '111', agentName: 'Heinner' },
    { id: 'line2_referral', type: 'referral', label: 'Booking', weight: 50, telegramChatId: '222', agentName: 'Zaret', displayNumber: '+57000' },
  ],
};

let repos: Repositories;
let db: Database.Database;
let previousRoutingJson: string;
let previousTelegramChatId: string;

registerCommands();

function update(chatId: number, text: string): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, username: 'tester' },
      text,
    },
  };
}

function photoUpdate(chatId: number, fileId: string, caption?: string): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, username: 'tester' },
      caption,
      photo: [
        { file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
        { file_id: fileId, file_unique_id: 'l', width: 1280, height: 1280 },
      ],
    },
  };
}

function videoUpdate(chatId: number, fileId: string, caption?: string): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, username: 'tester' },
      caption,
      video: { file_id: fileId, file_unique_id: 'v', mime_type: 'video/mp4', file_size: 1024 },
    },
  };
}

function voiceUpdate(chatId: number, fileId: string): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, username: 'tester' },
      voice: { file_id: fileId, file_unique_id: 'a', mime_type: 'audio/ogg', file_size: 1024 },
    },
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousRoutingJson = env.LEAD_ROUTING_JSON;
  previousTelegramChatId = env.TELEGRAM_CHAT_ID;
  env.LEAD_ROUTING_JSON = JSON.stringify(config);
  env.TELEGRAM_CHAT_ID = '333';
  resetRoutingConfigCache();
  vi.restoreAllMocks();
  // Telegram replies go out via global fetch; stub so dispatcher reply sends are no-ops.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  env.TELEGRAM_CHAT_ID = previousTelegramChatId;
  resetRoutingConfigCache();
  db.close();
});

describe('telegram dispatcher authorization', () => {
  it('ignores and logs messages from unregistered chats', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const sendSpy = vi.spyOn(whatsappClient, 'sendText').mockResolvedValue();

    await processUpdate(update(999999, '/pause'), repos);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '999999' }),
      expect.stringContaining('unregistered chat'),
    );
    expect(repos.isPaused()).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('blocks /pause from an allowlisted non-owner chat', async () => {
    await processUpdate(update(111, '/pause'), repos);
    expect(repos.isPaused()).toBe(false);
  });

  it('blocks /resume from an allowlisted non-owner chat', async () => {
    repos.setPaused(true);

    await processUpdate(update(111, '/resume'), repos);

    expect(repos.isPaused()).toBe(true);
  });

  it('allows owner chat to run owner-only commands', async () => {
    await processUpdate(update(333, '/pause'), repos);
    expect(repos.isPaused()).toBe(true);

    await processUpdate(update(333, '/resume'), repos);
    expect(repos.isPaused()).toBe(false);
  });

  it('blocks /block from an allowlisted non-owner chat without mutating opt-out', async () => {
    repos.conversation.upsert(CUSTOMER, { first_seen_at: new Date().toISOString() });

    await processUpdate(update(111, `/block ${CUSTOMER}`), repos);

    expect(repos.conversation.getByPhone(CUSTOMER)?.opt_out_at).toBeFalsy();
  });

  it('blocks /delete from an allowlisted non-owner chat without deleting data', async () => {
    repos.conversation.upsert(CUSTOMER, { first_seen_at: new Date().toISOString() });

    await processUpdate(update(111, `/delete ${CUSTOMER}`), repos);

    expect(repos.conversation.getByPhone(CUSTOMER)).toBeTruthy();
  });

  it('runs /send without a secret for the owning bridge line', async () => {
    repos.message.addMessage({
      whatsapp_message_id: 'in-1', customer_phone: CUSTOMER, direction: 'inbound',
      message_type: 'text', body: 'hola', created_at: new Date().toISOString(),
    });
    repos.conversation.setAssignment(CUSTOMER, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    const sendSpy = vi.spyOn(whatsappClient, 'sendText').mockResolvedValue();

    await processUpdate(update(111, `/send ${CUSTOMER} hola buen dia`), repos);

    expect(sendSpy).toHaveBeenCalledWith(CUSTOMER, 'hola buen dia');
  });

  it('blocks an allowlisted referral chat from /send to arbitrary numbers', async () => {
    const sendSpy = vi.spyOn(whatsappClient, 'sendText').mockResolvedValue();

    await processUpdate(update(222, `/send ${CUSTOMER} mensaje`), repos);

    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('telegram bridge image relay', () => {
  function openBridge(): void {
    repos.message.addMessage({
      whatsapp_message_id: 'in-1', customer_phone: CUSTOMER, direction: 'inbound',
      message_type: 'text', body: 'hola', created_at: new Date().toISOString(),
    });
    repos.conversation.setAssignment(CUSTOMER, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setMode(CUSTOMER, 'bridge_active');
    repos.bridgeSession.open('111', CUSTOMER);
  }

  function mockTelegramFileFetch(): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/getFile')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/file_1.jpg' } }), { status: 200 }));
      }
      if (url.includes('/file/bot')) {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
      }
      // Telegram sendMessage / sendPhoto replies
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });
  }

  it('relays an agent photo to the bridged customer via WhatsApp', async () => {
    openBridge();
    mockTelegramFileFetch();
    const uploadSpy = vi.spyOn(whatsappClient, 'uploadMedia').mockResolvedValue({ id: 'wamedia-1', kind: 'image' });
    const sendImageSpy = vi.spyOn(whatsappClient, 'sendImageId').mockResolvedValue();

    await processUpdate(photoUpdate(111, 'big-file-id', 'tu QR de pago'), repos);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(sendImageSpy).toHaveBeenCalledWith(CUSTOMER, 'wamedia-1', 'tu QR de pago');
    expect(repos.message.getLastOutboundBody(CUSTOMER)).toBe('tu QR de pago');
  });

  it('relays an agent video to the bridged customer via WhatsApp', async () => {
    openBridge();
    mockTelegramFileFetch();
    const uploadSpy = vi.spyOn(whatsappClient, 'uploadMedia').mockResolvedValue({ id: 'wamedia-video', kind: 'video' });
    const sendVideoSpy = vi.spyOn(whatsappClient, 'sendVideoId').mockResolvedValue();

    await processUpdate(videoUpdate(111, 'video-file-id', 'video prueba'), repos);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0][1]).toBe('video/mp4');
    expect(sendVideoSpy).toHaveBeenCalledWith(CUSTOMER, 'wamedia-video', 'video prueba');
  });

  it('relays an agent voice note to the bridged customer via WhatsApp audio', async () => {
    openBridge();
    mockTelegramFileFetch();
    const uploadSpy = vi.spyOn(whatsappClient, 'uploadMedia').mockResolvedValue({ id: 'wamedia-audio', kind: 'audio' });
    const sendAudioSpy = vi.spyOn(whatsappClient, 'sendAudioId').mockResolvedValue();

    await processUpdate(voiceUpdate(111, 'voice-file-id'), repos);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0][1]).toBe('audio/ogg');
    expect(sendAudioSpy).toHaveBeenCalledWith(CUSTOMER, 'wamedia-audio');
  });

  it('does not relay a photo when the agent chat has no active bridge session', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const uploadSpy = vi.spyOn(whatsappClient, 'uploadMedia').mockResolvedValue({ id: 'wamedia-1', kind: 'image' });

    await processUpdate(photoUpdate(111, 'big-file-id'), repos);

    // No media relayed; only the "no active chat" hint is sent (sendMessage, never getFile).
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes('/getFile'))).toBe(true);
  });
});
