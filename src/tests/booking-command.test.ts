import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { bookingHandler } from '../commands/booking.command.js';

const { mockSendTelegram } = vi.hoisted(() => ({
  mockSendTelegram: vi.fn<(_chatId: string, _text: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('../services/telegram-bot.js', () => ({
  sendTelegramMessage: mockSendTelegram,
  startTelegramBot: vi.fn(),
}));

const PHONE = '573001112233';

const config: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'BK', weight: 50, telegramChatId: '111', agentName: 'AgentA' },
    { id: 'line2_referral', type: 'referral', label: 'BK', weight: 50, telegramChatId: '222', agentName: 'AgentB', displayNumber: '+57000' },
  ],
};

let repos: Repositories;
let db: Database.Database;
let previousRoutingJson: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousRoutingJson = env.LEAD_ROUTING_JSON;
  env.LEAD_ROUTING_JSON = JSON.stringify(config);
  resetRoutingConfigCache();
  mockSendTelegram.mockReset();
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  resetRoutingConfigCache();
  db.close();
});

describe('/booking command', () => {
  it('marks converted_at and broadcasts to all lines', async () => {
    repos.conversation.upsert(PHONE, { collected_name: 'David', language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });

    const result = await bookingHandler({ repos, chatId: 111, args: [PHONE] });

    expect(result).toContain('Reserva confirmada');
    expect(result).toContain('David');
    expect(repos.conversation.getBookedAt(PHONE)).toBeTruthy();
    expect(mockSendTelegram).toHaveBeenCalledTimes(2);
    const allChats = mockSendTelegram.mock.calls.map(c => String(c[0]));
    expect(allChats).toEqual(expect.arrayContaining(['111', '222']));
    expect(mockSendTelegram.mock.calls[0][1]).toContain('David');
    expect(mockSendTelegram.mock.calls[0][1]).toContain(PHONE);
  });

  it('broadcasts the caller agent name', async () => {
    repos.conversation.upsert(PHONE, { collected_name: 'David', language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });

    await bookingHandler({ repos, chatId: 111, args: [PHONE] });

    expect(mockSendTelegram.mock.calls[0][1]).toContain('AgentA');
  });

  it('rejects non-owning line', async () => {
    repos.conversation.upsert(PHONE, { collected_name: 'David' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });

    const result = await bookingHandler({ repos, chatId: 222, args: [PHONE] });

    expect(result).toBe(bridgeMessages.leadAssignedToOther);
    expect(repos.conversation.getBookedAt(PHONE)).toBeNull();
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('rejects unassigned lead', async () => {
    repos.conversation.upsert(PHONE, { collected_name: 'David' });

    const result = await bookingHandler({ repos, chatId: 111, args: [PHONE] });

    expect(result).toBe(bridgeMessages.leadNotAssigned);
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('rejects non-existent phone', async () => {
    const result = await bookingHandler({ repos, chatId: 111, args: [PHONE] });

    expect(result).toBe(bridgeMessages.leadNotFound(PHONE));
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('returns early when already booked', async () => {
    repos.conversation.upsert(PHONE, { collected_name: 'David' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setBooked(PHONE);

    const result = await bookingHandler({ repos, chatId: 111, args: [PHONE] });

    expect(result).toContain('Ya estaba confirmado');
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });
});
