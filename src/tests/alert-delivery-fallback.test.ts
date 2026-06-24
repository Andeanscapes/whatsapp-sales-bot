import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';

const { mockSendTelegram } = vi.hoisted(() => ({
  mockSendTelegram: vi.fn<(_chatId: string, _text: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('../services/telegram-bot.js', () => ({
  sendTelegramMessage: mockSendTelegram,
  startTelegramBot: vi.fn(),
}));

const { sendAlert } = await import('../services/alert-service.js');

const PHONE = '573009997777';

const config: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'Booking', weight: 30, telegramChatId: '111', agentName: 'Heinner' },
    { id: 'line2_referral', type: 'referral', label: 'Booking', weight: 70, telegramChatId: '222', agentName: 'Zaret', displayNumber: '+57000' },
  ],
};

let repos: Repositories;
let db: Database.Database;
let previousRoutingJson: string;

beforeEach(() => {
  loadSkills();
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousRoutingJson = env.LEAD_ROUTING_JSON;
  env.LEAD_ROUTING_JSON = JSON.stringify(config);
  resetRoutingConfigCache();
  env.ALERT_CHANNEL = 'telegram';
  env.TELEGRAM_BOT_TOKEN = 'test-token';
  env.TELEGRAM_CHAT_ID = '999';
  mockSendTelegram.mockReset();
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  resetRoutingConfigCache();
  db.close();
});

describe('sendAlert — per-line delivery', () => {
  function pinBridgeLine(): void {
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
  }

  it('sends to the assigned line and records the alert on success', async () => {
    pinBridgeLine();
    mockSendTelegram.mockResolvedValue(undefined);

    await sendAlert({
      customerPhone: PHONE,
      score: 90,
      intent: 'reservation_handoff',
      message: 'Quiero reservar',
      name: 'David',
      date: '5 sep',
      people: '2',
      transport: 'own',
    }, repos);

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(String(mockSendTelegram.mock.calls[0][0])).toBe('111');
    expect(repos.ownerAlert.wasAlertedToday(PHONE, 'reservation_handoff')).toBe(true);
  });

  it('does not record the alert when both line and fallback fail — allows retry', async () => {
    pinBridgeLine();
    mockSendTelegram.mockRejectedValue(new Error('chat not found'));

    await sendAlert({
      customerPhone: PHONE,
      score: 90,
      intent: 'reservation_handoff',
      message: 'Quiero reservar',
      name: 'David',
      date: '5 sep',
      people: '2',
    }, repos);

    expect(repos.ownerAlert.wasAlertedToday(PHONE, 'reservation_handoff')).toBe(false);
  });

  it('falls back to owner chat when assigned-line delivery fails and records on fallback success', async () => {
    pinBridgeLine();
    mockSendTelegram.mockRejectedValueOnce(new Error('chat not found'));

    await sendAlert({
      customerPhone: PHONE,
      score: 90,
      intent: 'reservation_handoff',
      message: 'Quiero reservar',
      name: 'David',
    }, repos);

    expect(mockSendTelegram).toHaveBeenCalledTimes(2);
    const [, fallbackCall] = mockSendTelegram.mock.calls;
    expect(fallbackCall[0]).toBe('999');
    expect(fallbackCall[1]).toContain('[FALLBACK]');
    expect(repos.ownerAlert.wasAlertedToday(PHONE, 'reservation_handoff')).toBe(true);
  });

  it('does not dedupe unsafe_reservation_blocked against a prior hot alert', async () => {
    pinBridgeLine();
    mockSendTelegram.mockResolvedValue(undefined);

    // Prior low-score hot alert already recorded today.
    await sendAlert({ customerPhone: PHONE, score: 16, intent: 'hot_lead', message: 'me interesa' }, repos);
    expect(repos.ownerAlert.wasAlertedToday(PHONE, 'hot')).toBe(true);
    mockSendTelegram.mockClear();

    // Unsafe reservation block at the same low score must still deliver.
    await sendAlert({ customerPhone: PHONE, score: 16, intent: 'unsafe_reservation_blocked', message: 'si quiero reservar' }, repos);

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(repos.ownerAlert.wasAlertedToday(PHONE, 'unsafe_reservation_blocked')).toBe(true);
  });

  it('does not fall back when the failing chat IS the owner chat', async () => {
    pinBridgeLine();
    env.TELEGRAM_CHAT_ID = '111';
    mockSendTelegram.mockRejectedValue(new Error('chat not found'));

    await sendAlert({
      customerPhone: PHONE,
      score: 90,
      intent: 'reservation_handoff',
      message: 'Quiero reservar',
    }, repos);

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(repos.ownerAlert.wasAlertedToday(PHONE, 'reservation_handoff')).toBe(false);
  });
});

describe('sendAlert — single-line mode', () => {
  it('records the alert when sent via ALERT_CHANNEL=telegram fallback', async () => {
    disableRouting();

    await sendAlert({
      customerPhone: PHONE,
      score: 88,
      intent: 'qualifying',
      message: 'hola',
    }, repos);

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(repos.ownerAlert.wasAlertedToday(PHONE, 'hot')).toBe(true);
  });
});

function disableRouting(): void {
  env.LEAD_ROUTING_JSON = '';
  resetRoutingConfigCache();
}
