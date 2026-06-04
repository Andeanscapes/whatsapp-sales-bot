import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import type { LlmResult, LlmTurn } from '../services/llm/llm-client.js';

const { mockLlmComplete } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockLlmComplete: vi.fn<any>(() => Promise.resolve(null)),
}));

vi.mock('../services/llm/deepseek-llm-client.js', () => ({
  DeepSeekLlmClient: vi.fn().mockImplementation(() => ({ complete: mockLlmComplete })),
}));
vi.mock('../services/budget-guard.js', () => ({ checkBudget: vi.fn(() => ({ aiAllowed: true })) }));
vi.mock('../services/time-window-policy.js', () => ({
  checkTimeWindow: vi.fn(() => ({ isLimited: false })),
  isWithinServiceWindow: vi.fn(() => true),
}));

import { processMessage } from '../services/response-engine.js';

const PHONE = '573009998888';

const config: RoutingConfig = {
  salesLines: [
    { id: 'line2_referral', type: 'referral', label: 'Booking', weight: 100, telegramChatId: '222', agentName: 'Zaret', displayNumber: '+573001112233' },
  ],
};

const bridgeConfig: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'Booking', weight: 100, telegramChatId: '111', agentName: 'Heinner' },
  ],
};

function useRouting(cfg: RoutingConfig): void {
  env.LEAD_ROUTING_JSON = JSON.stringify(cfg);
  resetRoutingConfigCache();
}

function bookingTurn(overrides?: Partial<Pick<LlmTurn, 'reply' | 'action'>> & { intent?: LlmTurn['lead']['intent'] }): LlmResult {
  const turn: LlmTurn = {
    reply: overrides?.reply ?? 'Perfecto, confirmado.',
    sales_phase: 'closing',
    action: overrides?.action ?? 'handoff',
    collected_fields: { name: 'Marta', plan: '2d1n_mining', people: 2, date: 'agosto', transport_need: 'own', pet: null },
    lead: { intent: overrides?.intent ?? 'ready_to_book', buying_signals: [], blockers: [], score_delta: 0, confidence: 0.9 },
    img: false,
  };
  return { turn, tokens: { prompt: 100, completion: 20 } };
}

function seedQualifiedLead(): void {
  repos.conversation.upsert(PHONE, {
    collected_name: 'Marta',
    collected_plan: '2d1n_mining',
    collected_people: 2,
    collected_date: 'agosto',
    collected_transport_need: 'own',
    price_given_at: new Date().toISOString(),
  });
}

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
  mockLlmComplete.mockReset();
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  resetRoutingConfigCache();
  db.close();
});

describe('referral handoff routing', () => {
  it('sets referred mode and uses the referral reply with agent + display number', async () => {
    repos.conversation.upsert(PHONE, {
      collected_name: 'Marta',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'agosto',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });
    repos.message.addMessage({
      customer_phone: PHONE,
      direction: 'outbound',
      message_type: 'text',
      body: '¿Te gustaría reservar para esa fecha?',
      created_at: new Date(Date.now() - 5_000).toISOString(),
    });
    mockLlmComplete.mockResolvedValueOnce(bookingTurn());

    const result = await processMessage({ repos, customerPhone: PHONE, message: 'si por favor' });

    expect(result.reply).toContain('Zaret');
    expect(result.reply).toContain('+573001112233');
    expect(repos.conversation.getMode(PHONE)).toBe('referred');
  });

  it('hands off on the LLM booking signal even when the customer message lacks regex intent', async () => {
    seedQualifiedLead();
    // Bot's own soft-close question that the regex confirmation patterns missed.
    repos.message.addMessage({
      customer_phone: PHONE,
      direction: 'outbound',
      message_type: 'text',
      body: '¿Quieres que lo dejemos para revisión de reserva?',
      created_at: new Date(Date.now() - 5_000).toISOString(),
    });
    // LLM reply has no booking keywords, but its structured signal says handoff.
    mockLlmComplete.mockResolvedValueOnce(bookingTurn({ reply: 'Perfecto, lo dejo anotado.', action: 'handoff' }));

    const result = await processMessage({ repos, customerPhone: PHONE, message: 'Si' });

    expect(result.reply).toContain('Zaret');
    expect(result.shouldAlertOwner).toBe(true);
    expect(repos.conversation.getMode(PHONE)).toBe('referred');
  });

  it('hands off when "Si" confirms the bot\'s revision-de-reserva question (regex path)', async () => {
    seedQualifiedLead();
    repos.message.addMessage({
      customer_phone: PHONE,
      direction: 'outbound',
      message_type: 'text',
      body: '¿Quieres que lo dejemos para revisión de reserva?',
      created_at: new Date(Date.now() - 5_000).toISOString(),
    });
    // LLM gives a neutral, non-booking action — only the regex confirmation should drive handoff.
    mockLlmComplete.mockResolvedValueOnce(bookingTurn({ reply: 'Anotado.', action: 'answer', intent: 'qualifying' }));

    const result = await processMessage({ repos, customerPhone: PHONE, message: 'Si' });

    expect(result.reply).toContain('Zaret');
    expect(repos.conversation.getMode(PHONE)).toBe('referred');
  });

  it('on a bridge line, keeps the default reply and switches to bridge_active (no referral text)', async () => {
    useRouting(bridgeConfig);
    seedQualifiedLead();
    mockLlmComplete.mockResolvedValueOnce(bookingTurn({ reply: 'Perfecto, confirmado.', action: 'handoff' }));

    const result = await processMessage({ repos, customerPhone: PHONE, message: 'quiero reservar' });

    // Bridge lines do not expose a referral agent/number to the customer.
    expect(result.reply).not.toContain('Zaret');
    expect(result.reply).not.toContain('+573001112233');
    expect(result.shouldAlertOwner).toBe(true);
    expect(repos.conversation.getMode(PHONE)).toBe('bridge_active');
  });

  it('does NOT hand off when the LLM signals booking but price was never presented', async () => {
    repos.conversation.upsert(PHONE, {
      collected_name: 'Marta',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'agosto',
      collected_transport_need: 'own',
      // no price_given_at — gate must hold
    });
    mockLlmComplete.mockResolvedValueOnce(bookingTurn({ reply: 'Listo.', action: 'handoff' }));

    const result = await processMessage({ repos, customerPhone: PHONE, message: 'Si' });

    expect(result.reply).not.toContain('Zaret');
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
  });
});
