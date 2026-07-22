import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { pauseHandler } from '../commands/pause.command.js';
import { resumeHandler } from '../commands/resume.command.js';

const { mockSendTelegram } = vi.hoisted(() => ({
  mockSendTelegram: vi.fn<(_chatId: string, _text: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('../services/telegram-bot.js', () => ({
  sendTelegramMessage: mockSendTelegram,
  startTelegramBot: vi.fn(),
}));

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

function chatIdsFromCalls(): string[] {
  return mockSendTelegram.mock.calls.map(c => String(c[0]));
}

describe('/pause broadcast', () => {
  it('notifies all lines including the originator', async () => {
    const result = await pauseHandler({ repos, args: [], chatId: 111 });

    expect(result).toContain('pausado');
    expect(result).toContain('notifico');
    // Both lines (111 and 222) notified — includes originator.
    expect(chatIdsFromCalls()).toEqual(expect.arrayContaining(['111', '222']));
    expect(mockSendTelegram).toHaveBeenCalledTimes(2);
    expect(repos.isPaused()).toBe(true);
  });

  it('returns early when already paused — no extra broadcast', async () => {
    repos.setPaused(true);

    const result = await pauseHandler({ repos, args: [], chatId: 111 });

    expect(result).toContain('ya esta pausado');
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('one failing line does not block the notification for other lines', async () => {
    mockSendTelegram.mockImplementation(async (chatId) => {
      if (String(chatId) === '111') throw new Error('down');
    });

    await pauseHandler({ repos, args: [], chatId: 222 });

    expect(mockSendTelegram).toHaveBeenCalledTimes(2);
    expect(chatIdsFromCalls()).toContain('111');
    expect(chatIdsFromCalls()).toContain('222');
    expect(repos.isPaused()).toBe(true);
  });
});

describe('/resume broadcast', () => {
  it('notifies all lines when bot was paused', async () => {
    repos.setPaused(true);

    const result = await resumeHandler({ repos, args: [], chatId: 222 });

    expect(result).toContain('reactivado');
    expect(result).toContain('notifico');
    expect(chatIdsFromCalls()).toEqual(expect.arrayContaining(['111', '222']));
    expect(repos.isPaused()).toBe(false);
  });

  it('returns early when already active — no extra broadcast', async () => {
    const result = await resumeHandler({ repos, args: [], chatId: 111 });

    expect(result).toContain('ya esta activo');
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });
});
