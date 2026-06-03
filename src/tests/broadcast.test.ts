import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';

const { mockSendTelegram } = vi.hoisted(() => ({
  mockSendTelegram: vi.fn<(_chatId: string, _text: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('../services/telegram-bot.js', () => ({
  sendTelegramMessage: mockSendTelegram,
  startTelegramBot: vi.fn(),
}));

const { broadcastToAllLines } = await import('../services/broadcast.js');

let previousRoutingJson: string;

beforeEach(() => {
  previousRoutingJson = env.LEAD_ROUTING_JSON;
  mockSendTelegram.mockReset();
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  resetRoutingConfigCache();
});

function useRouting(config: RoutingConfig): void {
  env.LEAD_ROUTING_JSON = JSON.stringify(config);
  resetRoutingConfigCache();
}

describe('broadcastToAllLines', () => {
  it('is a no-op when routing is not configured', async () => {
    env.LEAD_ROUTING_JSON = '';
    resetRoutingConfigCache();

    await broadcastToAllLines('hola');

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('notifies every configured line once', async () => {
    useRouting({
      salesLines: [
        { id: 'a', type: 'bridge', label: 'A', weight: 50, telegramChatId: '111', agentName: 'Heinner' },
        { id: 'b', type: 'referral', label: 'B', weight: 50, telegramChatId: '222', agentName: 'Zaret', displayNumber: '+57000' },
      ],
    });

    await broadcastToAllLines('hola');

    expect(mockSendTelegram).toHaveBeenCalledTimes(2);
    expect(mockSendTelegram).toHaveBeenCalledWith('111', 'hola');
    expect(mockSendTelegram).toHaveBeenCalledWith('222', 'hola');
  });

  it('isolates a failing line and still notifies the others', async () => {
    useRouting({
      salesLines: [
        { id: 'a', type: 'bridge', label: 'A', weight: 50, telegramChatId: '111', agentName: 'Heinner' },
        { id: 'b', type: 'referral', label: 'B', weight: 50, telegramChatId: '222', agentName: 'Zaret', displayNumber: '+57000' },
      ],
    });
    mockSendTelegram.mockImplementation(async (chatId) => {
      if (String(chatId) === '111') throw new Error('down');
    });

    await broadcastToAllLines('hola');

    expect(mockSendTelegram).toHaveBeenCalledTimes(2);
    const chats = mockSendTelegram.mock.calls.map(c => String(c[0]));
    expect(chats).toEqual(expect.arrayContaining(['111', '222']));
  });
});
