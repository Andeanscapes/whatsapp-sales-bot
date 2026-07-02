import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';

const { mockLlmComplete } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockLlmComplete: vi.fn<any>(() => Promise.resolve(null)),
}));

vi.mock('../services/llm/deepseek-llm-client.js', () => ({
  DeepSeekLlmClient: vi.fn().mockImplementation(() => ({ complete: mockLlmComplete })),
}));

vi.mock('../services/budget-guard.js', () => ({
  checkBudget: vi.fn(() => ({ aiAllowed: true })),
}));

vi.mock('../services/whatsapp-client.js', () => ({
  sendText: vi.fn(() => Promise.resolve()),
}));

import { runFollowUps } from '../services/follow-up-service.js';
import { sendText } from '../services/whatsapp-client.js';
import { checkBudget } from '../services/budget-guard.js';
import type { LlmResult } from '../services/llm/llm-client.js';

const PHONE = '573001112233';
let repos: Repositories;
let db: Database.Database;
let previousFollowHours: number;
let previousAiEnabled: boolean;

function reply(text: string): LlmResult {
  return {
    turn: {
      reply: text,
      sales_phase: 'discovery',
      action: 'qualify',
      collected_fields: { name: null, plan: null, people: null, date: null, transport_need: null, pet: null },
      lead: { intent: 'qualifying', buying_signals: [], blockers: [], score_delta: 0, confidence: 0.5 },
      img: false,
    },
    tokens: { prompt: 100, completion: 20 },
  };
}

function addMsg(direction: 'inbound' | 'outbound', body: string, offsetMs: number): void {
  db.prepare(
    'INSERT INTO messages (customer_phone, direction, message_type, body, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(PHONE, direction, 'text', body, new Date(Date.now() + offsetMs).toISOString());
}

/** Lead that received the last bot reply 4h ago, after a recent inbound. */
function seedSilentLead(): void {
  repos.conversation.upsert(PHONE, { language: 'es' });
  addMsg('inbound', 'hola, cuanto vale?', -5 * 60 * 60 * 1000);
  addMsg('outbound', 'Hola, te cuento...', -4 * 60 * 60 * 1000);
}

beforeEach(() => {
  loadSkills();
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousFollowHours = env.TIME_FOLLOW_HOURS;
  previousAiEnabled = env.AI_ENABLED;
  env.TIME_FOLLOW_HOURS = 3;
  env.AI_ENABLED = true;
  mockLlmComplete.mockReset();
  vi.mocked(sendText).mockClear();
  vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
});

afterEach(() => {
  env.TIME_FOLLOW_HOURS = previousFollowHours;
  env.AI_ENABLED = previousAiEnabled;
  db.close();
});

describe('follow-up service', () => {
  it('sends one safe follow-up and marks it sent', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValueOnce(reply('¿Quieres que revise opciones para tu fecha?'));

    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(repos.conversation.getByPhone(PHONE)?.follow_up_sent_at).toBeTruthy();
  });

  it('does not follow up twice (marks sent)', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValue(reply('¿Te ayudo con la fecha?'));

    await runFollowUps(repos);
    vi.mocked(sendText).mockClear();
    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('blocks an unsafe reservation claim and does not send', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValueOnce(reply('Tu reserva quedó confirmada para esa fecha.'));

    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
    // Marked so it does not retry the same bad generation forever.
    expect(repos.conversation.getByPhone(PHONE)?.follow_up_sent_at).toBeTruthy();
  });

  it('stays silent when the bot is paused', async () => {
    seedSilentLead();
    repos.setPaused(true);
    mockLlmComplete.mockResolvedValue(reply('¿Seguimos?'));

    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips when last message is from the customer (awaiting bot, not silent)', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    addMsg('outbound', 'Hola', -5 * 60 * 60 * 1000);
    addMsg('inbound', 'me interesa', -10 * 60 * 1000);

    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips opted-out leads', async () => {
    seedSilentLead();
    repos.optOut.setOptOut(PHONE);
    mockLlmComplete.mockResolvedValue(reply('¿Seguimos?'));

    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('skips when budget is exhausted', async () => {
    seedSilentLead();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: false, reason: 'daily_budget_exceeded' });
    mockLlmComplete.mockResolvedValue(reply('¿Seguimos?'));

    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });

  it('records first_nudge event with correct stage and score', async () => {
    seedSilentLead();
    repos.conversation.upsert(PHONE, { lead_score: 15 });
    mockLlmComplete.mockResolvedValueOnce(reply('Me acordé de ti'));

    await runFollowUps(repos);

    const event = repos.followUpEvent.getLatestByPhone(PHONE);
    expect(event).not.toBeNull();
    expect(event?.stage).toBe('first_nudge');
    expect(event?.status).toBe('sent');
    expect(event?.scoreBefore).toBe(15);
    expect(event?.repliedAt).toBeNull();
  });

  it('sends pain question when first_nudge has been replied', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', lead_score: 15 });
    // Seed a recent inbound so the service window check passes
    addMsg('inbound', 'hola cuanto vale?', -2 * 60 * 60 * 1000);

    // Directly insert a first_nudge event that is already replied
    repos.followUpEvent.insert({
      customerPhone: PHONE,
      sequenceNumber: 1,
      stage: 'first_nudge',
      sentAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      repliedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      scoreBefore: 15,
      scoreAfter: 15,
      detectedPain: null,
      status: 'replied',
    });

    vi.mocked(sendText).mockClear();
    await runFollowUps(repos);

    expect(sendText).toHaveBeenCalledTimes(1);
    const [, painMsg] = vi.mocked(sendText).mock.calls[0] ?? [];
    expect(String(painMsg)).toMatch(/precio|fecha|seguridad|transporte/i);
  });

  it('does not send pain question when first_nudge not yet replied', async () => {
    seedSilentLead();
    mockLlmComplete.mockResolvedValueOnce(reply('Me acordé de ti'));

    // Send first nudge (status = 'sent', not replied)
    await runFollowUps(repos);
    vi.mocked(sendText).mockClear();

    // Scheduler runs again — no second send
    await runFollowUps(repos);

    expect(sendText).not.toHaveBeenCalled();
  });
});
