import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { chatHandler } from '../commands/chat.command.js';
import { endHandler } from '../commands/end.command.js';

const PHONE = '573001112233';

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
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousRoutingJson = env.LEAD_ROUTING_JSON;
  env.LEAD_ROUTING_JSON = JSON.stringify(config);
  resetRoutingConfigCache();
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  resetRoutingConfigCache();
  db.close();
});

describe('/chat command', () => {
  it('rejects a referral-line caller', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line2_referral', assignedAgentChat: '222' });

    const reply = await chatHandler({ repos, chatId: 222, args: [PHONE] });

    expect(reply).toBe(bridgeMessages.bridgeOnlyForApiLine);
    expect(repos.bridgeSession.getByCustomer(PHONE)).toBeNull();
  });

  it('returns usage when no phone is provided', async () => {
    const reply = await chatHandler({ repos, chatId: 111, args: [] });
    expect(reply).toBe(bridgeMessages.bridgeUsage);
  });

  it('blocks a bridge agent from chatting a lead assigned to another line', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line2_referral', assignedAgentChat: '222' });

    const reply = await chatHandler({ repos, chatId: 111, args: [PHONE] });

    expect(reply).toBe(bridgeMessages.leadAssignedToOther);
  });

  it('opens a bridge session for the owning bridge line', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });

    const reply = await chatHandler({ repos, chatId: 111, args: [PHONE] });

    expect(reply).toContain('Chat activo');
    expect(repos.conversation.getMode(PHONE)).toBe('bridge_active');
    expect(repos.bridgeSession.getByCustomer(PHONE)?.agentChatId).toBe('111');
  });
});

describe('/end command', () => {
  it('returns noActiveChat when there is no session', async () => {
    const reply = await endHandler({ repos, chatId: 111, args: [] });
    expect(reply).toBe(bridgeMessages.noActiveChat);
  });

  it('closes the session and reverts the conversation to bot mode', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.bridgeSession.open('111', PHONE);
    repos.conversation.setMode(PHONE, 'bridge_active');

    const reply = await endHandler({ repos, chatId: 111, args: [] });

    expect(reply).toBe(bridgeMessages.chatClosed(PHONE));
    expect(repos.bridgeSession.getByAgentChat('111')).toBeNull();
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
  });
});
