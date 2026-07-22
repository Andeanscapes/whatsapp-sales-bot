import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import type { LlmClientInput, LlmResult, LlmTurn } from '../services/llm/llm-client.js';
import type { LeadAnalysis } from '../services/lead-analyzer.js';

const { mockLlmComplete } = vi.hoisted(() => ({
  mockLlmComplete: vi.fn<(input: LlmClientInput) => Promise<LlmResult | null>>(() => Promise.resolve(null)),
}));

vi.mock('../services/llm/deepseek-llm-client.js', () => ({
  DeepSeekLlmClient: vi.fn().mockImplementation(() => ({ complete: mockLlmComplete })),
}));
vi.mock('../services/budget-guard.js', () => ({ checkBudget: vi.fn(() => ({ aiAllowed: true })) }));
vi.mock('../services/time-window-policy.js', () => ({
  checkTimeWindow: vi.fn(() => ({ isLimited: false })),
  isWithinServiceWindow: vi.fn(() => true),
}));

const { mockAnalyzeLead } = vi.hoisted(() => ({
  mockAnalyzeLead: vi.fn<() => Promise<LeadAnalysis | null>>(() => Promise.resolve(null)),
}));

vi.mock('../services/lead-analyzer.js', () => ({
  analyzeLead: mockAnalyzeLead,
}));

import { processMessage } from '../services/response-engine.js';

const PHONE = '573009998888';

const config: RoutingConfig = {
  salesLines: [
    { id: 'line2_referral', type: 'referral', label: 'Booking', weight: 100, telegramChatId: '222', agentName: 'AgentB', displayNumber: '+573001112233' },
  ],
};

const bridgeConfig: RoutingConfig = {
  salesLines: [
    { id: 'line1_bridge', type: 'bridge', label: 'Booking', weight: 100, telegramChatId: '111', agentName: 'AgentA' },
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
  mockAnalyzeLead.mockReset();
});

afterEach(() => {
  env.LEAD_ROUTING_JSON = previousRoutingJson;
  resetRoutingConfigCache();
  db.close();
});

describe('referral handoff routing', () => {
  it('alerts owner and continues with LLM reply instead of referral handoff', async () => {
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
    mockAnalyzeLead.mockResolvedValueOnce({
      intent: 'ready_to_book', scoreDelta: 80, confidence: 1.0,
      buyingSignals: ['reservation_confirm'], blockers: [],
      afterPriceInterest: true, reservationReadiness: 'strong',
      rationale: 'cliente quiere reservar', promptTokens: 50, completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: PHONE, message: 'si por favor' });

    expect(result.reply).toBeTruthy();
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('reservation_handoff');
    expect(repos.conversation.getMode(PHONE)).toBe('human_pending');
    expect(repos.conversation.getHandedOffAt(PHONE)).toBeNull();
  });

  it('alerts owner on LLM booking signal instead of handoff', async () => {
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
    mockAnalyzeLead.mockResolvedValueOnce({
      intent: 'ready_to_book', scoreDelta: 80, confidence: 1.0,
      buyingSignals: ['handoff_signal'], blockers: [],
      afterPriceInterest: true, reservationReadiness: 'strong',
      rationale: 'senial de booking', promptTokens: 50, completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: PHONE, message: 'Si' });

    expect(result.reply).toBeTruthy();
    expect(result.shouldAlertOwner).toBe(true);
    expect(repos.conversation.getMode(PHONE)).toBe('human_pending');
    expect(repos.conversation.getHandedOffAt(PHONE)).toBeNull();
  });

  it('alerts owner when "Si" confirms revision-de-reserva without handoff', async () => {
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
    mockAnalyzeLead.mockResolvedValueOnce({
      intent: 'ready_to_book', scoreDelta: 80, confidence: 1.0,
      buyingSignals: ['user_confirm'], blockers: [],
      afterPriceInterest: true, reservationReadiness: 'strong',
      rationale: 'confirma reserva', promptTokens: 50, completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: PHONE, message: 'Si' });

    expect(result.reply).toBeTruthy();
    expect(result.shouldAlertOwner).toBe(true);
    expect(repos.conversation.getMode(PHONE)).toBe('human_pending');
    expect(repos.conversation.getHandedOffAt(PHONE)).toBeNull();
  });

  it('on a bridge line, alerts owner without handoff', async () => {
    useRouting(bridgeConfig);
    seedQualifiedLead();
    mockLlmComplete.mockResolvedValueOnce(bookingTurn({ reply: 'Perfecto, confirmado.', action: 'handoff' }));
    mockAnalyzeLead.mockResolvedValueOnce({
      intent: 'ready_to_book', scoreDelta: 80, confidence: 1.0,
      buyingSignals: ['reservar_ya'], blockers: [],
      afterPriceInterest: true, reservationReadiness: 'strong',
      rationale: 'listo para reservar', promptTokens: 50, completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: PHONE, message: 'quiero reservar' });

    expect(result.reply).toBeTruthy();
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('reservation_handoff');
    expect(repos.conversation.getMode(PHONE)).toBe('human_pending');
    expect(repos.conversation.getHandedOffAt(PHONE)).toBeNull();
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

    expect(result.reply).not.toContain('AgentB');
    expect(repos.conversation.getMode(PHONE)).toBe('bot');
  });
});
