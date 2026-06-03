import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { loadSkills } from '../services/skill-loader.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { forwardBridgeMessage, forwardPostHandoffMessage, type ExtractedMessage } from '../routes/whatsapp-webhook.route.js';

const { mockSendTelegram } = vi.hoisted(() => ({
  mockSendTelegram: vi.fn<(_chatId: string, _text: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('../services/telegram-bot.js', () => ({
  sendTelegramMessage: mockSendTelegram,
}));

const PHONE = '573001112233';

const routing: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'Bridge', weight: 50, telegramChatId: '111', agentName: 'Heinner' },
    { id: 'line2_referral', type: 'referral', label: 'Referral', weight: 50, telegramChatId: '222', agentName: 'Alexandra', displayNumber: '+573124815443' },
  ],
};

let db: Database.Database;
let repos: Repositories;
let previousRoutingJson: string;

function msg(text: string, id = 'wamid-1'): ExtractedMessage {
  return { from: PHONE, id, text, timestamp: '' };
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
  env.LEAD_ROUTING_JSON = JSON.stringify(routing);
  resetRoutingConfigCache();
  mockSendTelegram.mockReset();
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  resetRoutingConfigCache();
  db.close();
});

describe('forwardPostHandoffMessage', () => {
  it('notifies referral agent and returns deterministic customer reply after handoff', async () => {
    seedHandedOff('line2_referral', '222');

    const result = await forwardPostHandoffMessage(repos, msg('Me das mas info?'));

    expect(result).toContain('equipo ya tiene tus datos');
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][0]).toBe('222');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('Responder desde WhatsApp Business app: +573124815443');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('https://wa.me/573001112233');
    expect(repos.message.getLastInboundBodies(PHONE, 1)[0]?.body).toBe('Me das mas info?');
  });

  it('notifies bridge agent with /chat instructions when no live bridge session exists', async () => {
    seedHandedOff('line1_bridge', '111');
    repos.conversation.setMode(PHONE, 'bridge_active');

    const result = await forwardPostHandoffMessage(repos, msg('Hola?', 'wamid-2'));

    expect(result).toBeTruthy();
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][0]).toBe('111');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('/chat 573001112233');
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
});

describe('forwardBridgeMessage', () => {
  it('reopens the bot path when active bridge Telegram delivery fails', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('111', PHONE);
    mockSendTelegram.mockRejectedValueOnce(new Error('telegram down'));

    const forwarded = await forwardBridgeMessage(repos, msg('Hola agente', 'wamid-bridge-fail'));

    expect(forwarded).toBe(false);
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
    expect(repos.bridgeSession.getByAgentChat('111')).toBeNull();
    const inbound = repos.message.getLastInboundBodies(PHONE, 10).filter(m => m.body === 'Hola agente');
    expect(inbound).toHaveLength(1);
  });
});
