import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { returnbotHandler } from '../commands/returnbot.command.js';

const PHONE = '573001112233';
let repos: Repositories;
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
});

afterEach(() => {
  db.close();
});

describe('/returnbot', () => {
  it('returns usage with no phone', async () => {
    expect(await returnbotHandler({ repos, args: [], chatId: 111 })).toBe(bridgeMessages.returnbotUsage);
  });

  it('rejects unknown lead', async () => {
    expect(await returnbotHandler({ repos, args: [PHONE], chatId: 111 })).toBe(bridgeMessages.leadNotFound(PHONE));
  });

  it('rejects booked leads', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setBooked(PHONE);

    const out = await returnbotHandler({ repos, args: [PHONE], chatId: 111 });

    expect(out).toBe(bridgeMessages.returnbotBooked);
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
    expect(repos.conversation.getBookedAt(PHONE)).toBeTruthy();
  });

  it('does not mutate booked lead bridge or handoff state', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.bridgeSession.open('111', PHONE);
    repos.conversation.setMode(PHONE, 'bridge_active');
    repos.conversation.setAssignment(PHONE, { assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    repos.conversation.setHandedOff(PHONE);
    repos.conversation.setBooked(PHONE);

    const handedOffBefore = repos.conversation.getHandedOffAt(PHONE);
    const bookedBefore = repos.conversation.getBookedAt(PHONE);

    const out = await returnbotHandler({ repos, args: [PHONE], chatId: 111 });

    expect(out).toBe(bridgeMessages.returnbotBooked);
    expect(repos.bridgeSession.getByCustomer(PHONE)?.agentChatId).toBe('111');
    expect(repos.conversation.getMode(PHONE)).toBe('bridge_active');
    expect(repos.conversation.getAssignment(PHONE)).toEqual({ assignedLineId: 'line1_bridge', assignedAgentChat: '111' });
    expect(repos.conversation.getHandedOffAt(PHONE)).toBe(handedOffBefore);
    expect(repos.conversation.getBookedAt(PHONE)).toBe(bookedBefore);
  });

  it('normalizes formatted phone input', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });

    const out = await returnbotHandler({ repos, args: ['+57 300 111 2233'], chatId: 111 });

    expect(out).toBe(bridgeMessages.returnbotDone(PHONE));
  });

  it('clears bridge session and handoff for non-booked lead', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.bridgeSession.open('111', PHONE);
    repos.conversation.setMode(PHONE, 'bridge_active');

    const out = await returnbotHandler({ repos, args: [PHONE], chatId: 111 });

    expect(out).toBe(bridgeMessages.returnbotDone(PHONE));
    expect(repos.bridgeSession.getByCustomer(PHONE)).toBeNull();
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
    expect(repos.conversation.getHandedOffAt(PHONE)).toBeNull();
    expect(repos.conversation.getAssignment(PHONE)).toBeNull();
  });

  it('clears handoff (no bridge) for non-booked lead', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    repos.conversation.setHandedOff(PHONE);

    const out = await returnbotHandler({ repos, args: [PHONE], chatId: 111 });

    expect(out).toBe(bridgeMessages.returnbotDone(PHONE));
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
    expect(repos.conversation.getHandedOffAt(PHONE)).toBeNull();
    expect(repos.conversation.getAssignment(PHONE)).toBeNull();
  });

  it('works for lead with no bridge and no handoff', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });

    const out = await returnbotHandler({ repos, args: [PHONE], chatId: 111 });

    expect(out).toBe(bridgeMessages.returnbotDone(PHONE));
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
  });
});
