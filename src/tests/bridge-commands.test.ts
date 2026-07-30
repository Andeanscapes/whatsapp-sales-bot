import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { chatHandler } from '../commands/chat.command.js';
import { endHandler } from '../commands/end.command.js';
import { stopbotHandler } from '../commands/stopbot.command.js';
import { returnbotHandler } from '../commands/returnbot.command.js';

const PHONE = '573001112233';

const config: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'Booking', weight: 30, telegramChatId: '111', agentName: 'AgentA' },
    { id: 'line2_referral', type: 'referral', label: 'Booking', weight: 70, telegramChatId: '222', agentName: 'AgentB', displayNumber: '+57000' },
  ],
};

let repos: Repositories;
let db: Database.Database;
let previousRoutingJson: string;
let previousOwnerChatId: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousRoutingJson = env.LEAD_ROUTING_JSON;
  previousOwnerChatId = env.TELEGRAM_CHAT_ID;
  env.LEAD_ROUTING_JSON = JSON.stringify(config);
  env.TELEGRAM_CHAT_ID = '333';
  resetRoutingConfigCache();
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  env.TELEGRAM_CHAT_ID = previousOwnerChatId;
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

  it('allows the owner to bridge an unassigned lead', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });

    const reply = await chatHandler({ repos, chatId: 333, args: [PHONE] });

    expect(reply).toContain('Chat activo');
    expect(repos.conversation.getMode(PHONE)).toBe('bridge_active');
    expect(repos.bridgeSession.getByCustomer(PHONE)?.agentChatId).toBe('333');
  });

  it('allows the owner to take over a lead assigned to another line', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line2_referral', assignedAgentChat: '222' });

    await chatHandler({ repos, chatId: 333, args: [PHONE] });

    expect(repos.bridgeSession.getByCustomer(PHONE)?.agentChatId).toBe('333');
    expect(repos.conversation.getAssignment(PHONE)).toEqual({ assignedLineId: 'line2_referral', assignedAgentChat: '222' });
  });

  it('closes the target agent session when the owner takes over', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('111', PHONE);

    await chatHandler({ repos, chatId: 333, args: [PHONE] });

    expect(repos.bridgeSession.getByAgentChat('111')).toBeNull();
    expect(repos.bridgeSession.getByCustomer(PHONE)?.agentChatId).toBe('333');
  });

  it('does not let the assigned agent displace an active owner bridge', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('333', PHONE);

    const reply = await chatHandler({ repos, chatId: 111, args: [PHONE] });

    expect(reply).toBe(bridgeMessages.leadAssignedToOther);
    expect(repos.bridgeSession.getByCustomer(PHONE)?.agentChatId).toBe('333');
    expect(repos.conversation.getMode(PHONE)).toBe('bridge_active');
  });

  it('returns the owner previous bridge to bot mode before switching leads', async () => {
    const otherPhone = '573009998888';
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.upsert(otherPhone, { language: 'es' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('333', PHONE);

    await chatHandler({ repos, chatId: 333, args: [otherPhone] });

    expect(repos.conversation.getMode(PHONE)).toBe('bot');
    expect(repos.bridgeSession.getByCustomer(PHONE)).toBeNull();
    expect(repos.conversation.getMode(otherPhone)).toBe('bridge_active');
    expect(repos.bridgeSession.getByCustomer(otherPhone)?.agentChatId).toBe('333');
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

  it('restores human_only after ending a bridge opened by /stopbot', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.bridgeSession.open('111', PHONE, 'human_only');
    repos.conversation.setMode(PHONE, 'bridge_active');

    const reply = await endHandler({ repos, chatId: 111, args: [] });

    expect(reply).toBe(bridgeMessages.chatClosed(PHONE));
    expect(repos.bridgeSession.getByAgentChat('111')).toBeNull();
    expect(repos.conversation.getMode(PHONE)).toBe('human_only');
  });
});

describe('/stopbot command', () => {
  it('returns usage when no phone is provided', async () => {
    const reply = await stopbotHandler({ repos, chatId: 333, args: [] });
    expect(reply).toBe(bridgeMessages.stopbotUsage);
  });

  it('returns leadNotFound for unknown phone', async () => {
    const reply = await stopbotHandler({ repos, chatId: 333, args: [PHONE] });
    expect(reply).toBe(bridgeMessages.leadNotFound(PHONE));
  });

  it('rejects booked leads', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setBooked(PHONE);

    const reply = await stopbotHandler({ repos, chatId: 333, args: [PHONE] });

    expect(reply).toBe(bridgeMessages.stopbotBooked);
  });

  it('opens a human bridge that returns to human_only and clears handoff', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setHandedOff(PHONE);

    const reply = await stopbotHandler({ repos, chatId: 333, args: [PHONE] });

    expect(reply).toBe(bridgeMessages.stopbotDone(PHONE));
    expect(repos.conversation.getMode(PHONE)).toBe('bridge_active');
    expect(repos.conversation.getHandedOffAt(PHONE)).toBeNull();
    expect(repos.conversation.getAssignment(PHONE)).toBeNull();
    expect(repos.bridgeSession.getByCustomer(PHONE)?.agentChatId).toBe('333');
    expect(repos.bridgeSession.getByCustomer(PHONE)?.returnMode).toBe('human_only');
  });

  it('takes over an active bridge and keeps human routing active', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.bridgeSession.open('111', PHONE);

    await stopbotHandler({ repos, chatId: 333, args: [PHONE] });

    expect(repos.conversation.getMode(PHONE)).toBe('bridge_active');
    expect(repos.bridgeSession.getByCustomer(PHONE)?.agentChatId).toBe('333');
    expect(repos.bridgeSession.getByCustomer(PHONE)?.returnMode).toBe('human_only');
  });
});

describe('/returnbot from human_only', () => {
  it('reverts human_only mode back to bot', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setMode(PHONE, 'human_only');

    const reply = await returnbotHandler({ repos, chatId: 333, args: [PHONE] });

    expect(reply).toBe(bridgeMessages.returnbotDone(PHONE));
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
  });
});
