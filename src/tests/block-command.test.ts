import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { blockHandler } from '../commands/block.command.js';

const PHONE = '573001112233';

const routing: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'Booking', weight: 50, telegramChatId: '111', agentName: 'Heinner' },
    { id: 'line2_referral', type: 'referral', label: 'Booking', weight: 50, telegramChatId: '222', agentName: 'Zaret', displayNumber: '+57000' },
  ],
};

let db: Database.Database;
let repos: Repositories;
let previousRoutingJson: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousRoutingJson = env.LEAD_ROUTING_JSON;
  env.LEAD_ROUTING_JSON = JSON.stringify(routing);
  resetRoutingConfigCache();
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  resetRoutingConfigCache();
  db.close();
});

describe('/block command routing guard', () => {
  it('blocks arbitrary numbers in multi-line mode', async () => {
    const reply = await blockHandler({ repos, chatId: 111, args: [PHONE] });

    expect(reply).toBe(bridgeMessages.leadNotFound(PHONE));
    expect(repos.optOut.isOptedOut(PHONE)).toBe(false);
  });

  it('blocks unassigned leads in multi-line mode', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });

    const reply = await blockHandler({ repos, chatId: 111, args: [PHONE] });

    expect(reply).toBe(bridgeMessages.leadNotAssigned);
    expect(repos.optOut.isOptedOut(PHONE)).toBe(false);
  });

  it('blocks leads assigned to another line', async () => {
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line2_referral', assignedAgentChat: '222' });

    const reply = await blockHandler({ repos, chatId: 111, args: [PHONE] });

    expect(reply).toBe(bridgeMessages.leadAssignedToOther);
    expect(repos.optOut.isOptedOut(PHONE)).toBe(false);
  });

  it('allows the owning assigned line to block', async () => {
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });

    const reply = await blockHandler({ repos, chatId: 111, args: [PHONE] });

    expect(reply).toContain('bloqueado');
    expect(repos.optOut.isOptedOut(PHONE)).toBe(true);
  });
});
