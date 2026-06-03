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

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousRoutingJson = env.LEAD_ROUTING_JSON;
  env.LEAD_ROUTING_JSON = JSON.stringify(config);
  resetRoutingConfigCache();
  vi.restoreAllMocks();
  // Telegram replies go out via global fetch; stub so dispatcher reply sends are no-ops.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
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

  it('runs /pause without a secret from an allowlisted chat', async () => {
    await processUpdate(update(111, '/pause'), repos);
    expect(repos.isPaused()).toBe(true);
  });

  it('runs /resume without a secret from an allowlisted chat', async () => {
    repos.setPaused(true);

    await processUpdate(update(111, '/resume'), repos);

    expect(repos.isPaused()).toBe(false);
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
