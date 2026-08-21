import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import type { DeepSeekCompletionInput, DeepSeekCompletionResult } from '../services/llm/deepseek-completion.js';

const { mockRequestDeepSeekCompletion, mockCheckBudget } = vi.hoisted(() => ({
  mockRequestDeepSeekCompletion: vi.fn<(input: DeepSeekCompletionInput) => Promise<DeepSeekCompletionResult | null>>(),
  mockCheckBudget: vi.fn<() => { aiAllowed: boolean; reason?: string }>(() => ({ aiAllowed: true })),
}));

vi.mock('../services/llm/deepseek-completion.js', () => ({
  requestDeepSeekCompletion: mockRequestDeepSeekCompletion,
}));

vi.mock('../services/budget-guard.js', () => ({
  checkBudget: mockCheckBudget,
}));

import { scoreBridgeInbound } from '../services/bridge-lead-scoring.js';

const PHONE = '573001112233';
let db: Database.Database;
let repos: Repositories;

function analysisResponse(overrides: Partial<{
  intent: string;
  score_delta: number;
  confidence: number;
  buying_signals: string[];
  blockers: string[];
}> = {}): DeepSeekCompletionResult {
  return {
    content: JSON.stringify({
      intent: 'qualified',
      score_delta: 15,
      confidence: 0.9,
      buying_signals: ['asked_price'],
      blockers: [],
      after_price_interest: false,
      reservation_readiness: 'none',
      rationale: 'Cliente interesado.',
      ...overrides,
    }),
    finishReason: 'stop',
    promptTokens: 20,
    completionTokens: 10,
  };
}

beforeEach(() => {
  loadSkills();
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  mockCheckBudget.mockReturnValue({ aiAllowed: true });
});

afterEach(() => {
  vi.clearAllMocks();
  db.close();
});

describe('scoreBridgeInbound', () => {
  it('updates lead score and intent from the analyzer without sending a reply', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    mockRequestDeepSeekCompletion.mockResolvedValueOnce(analysisResponse());

    await scoreBridgeInbound(repos, PHONE, 'Cuanto cuesta el plan para dos personas?');

    const conv = repos.conversation.getByPhone(PHONE);
    expect(conv?.lead_score).toBeGreaterThan(0);
    expect(conv?.lead_intent).toBe('qualified');
    // Silent by design: no outbound message is ever written by this path.
    expect(repos.message.getRecentMessages(PHONE, 10).some(m => m.role === 'assistant')).toBe(false);
  });

  it('records ai_usage for the analyzer call', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    mockRequestDeepSeekCompletion.mockResolvedValueOnce(analysisResponse());

    await scoreBridgeInbound(repos, PHONE, 'Quiero reservar para el fin de semana');

    const usage = repos.aiUsage.getUsageByPurpose(PHONE, new Date(Date.now() - 60_000).toISOString(), null);
    expect(usage.lead_analysis.calls).toBe(1);
  });

  it('falls back to the deterministic score when the budget guard blocks AI', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', lead_score: 10 });
    mockCheckBudget.mockReturnValue({ aiAllowed: false, reason: 'daily_budget_exceeded' });

    await scoreBridgeInbound(repos, PHONE, 'Hola');

    expect(mockRequestDeepSeekCompletion).not.toHaveBeenCalled();
    const conv = repos.conversation.getByPhone(PHONE);
    expect(conv?.lead_score).toBeGreaterThanOrEqual(10);
  });

  it('falls back to the deterministic score when the analyzer returns invalid JSON', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', lead_score: 10 });
    mockRequestDeepSeekCompletion.mockResolvedValueOnce({
      content: 'not json',
      finishReason: 'stop',
      promptTokens: 5,
      completionTokens: 5,
    });

    await scoreBridgeInbound(repos, PHONE, 'Hola');

    const conv = repos.conversation.getByPhone(PHONE);
    expect(conv?.lead_intent).toBeNull();
    expect(conv?.lead_score).toBeGreaterThanOrEqual(10);
  });

  it('is a no-op for an empty or whitespace-only message', async () => {
    repos.conversation.upsert(PHONE, { language: 'es', lead_score: 10 });

    await scoreBridgeInbound(repos, PHONE, '   ');

    expect(mockCheckBudget).not.toHaveBeenCalled();
    expect(mockRequestDeepSeekCompletion).not.toHaveBeenCalled();
    expect(repos.conversation.getByPhone(PHONE)?.lead_score).toBe(10);
  });
});
