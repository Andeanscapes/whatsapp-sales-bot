import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import type { LlmClientInput, LlmResult } from '../services/llm/llm-client.js';
import type { LeadAnalysis } from '../services/lead-analyzer.js';
import { getSkills } from '../services/skill-loader.js';
import { useAllSitesActive } from './helpers/all-sites-catalog.js';

// P0 2026-11-26, synthetic replay through the real entry point (mocked LLM, real repos):
// solo PRIME Chivor quoted at 960.000, then "¿cuánto para 3? ¿incluye transporte?" and
// "¿total para 4 con transporte?". Live the bot answered 1.440.000 and 1.920.000/3.620.000.

const { mockComplete } = vi.hoisted(() => ({
  mockComplete: vi.fn<(input: LlmClientInput) => Promise<LlmResult | null>>(),
}));
const { mockAnalyzeLead } = vi.hoisted(() => ({
  mockAnalyzeLead: vi.fn<() => Promise<LeadAnalysis | null>>(() => Promise.resolve(null)),
}));

vi.mock('../services/llm/deepseek-llm-client.js', () => ({
  DeepSeekLlmClient: vi.fn().mockImplementation(() => ({ complete: mockComplete })),
}));
vi.mock('../services/budget-guard.js', () => ({ checkBudget: vi.fn(() => ({ aiAllowed: true })) }));
vi.mock('../services/time-window-policy.js', () => ({ checkTimeWindow: vi.fn(() => ({ isLimited: false })) }));
vi.mock('../services/lead-analyzer.js', () => ({ analyzeLead: mockAnalyzeLead }));

import { processMessage } from '../services/response-engine.js';

beforeAll(() => {
  useAllSitesActive();
});

afterEach(() => {
  mockComplete.mockReset();
});

function llmResult(reply: string): LlmResult {
  return {
    turn: {
      reply,
      sales_phase: 'discovery',
      action: 'qualify',
      collected_fields: { name: null, plan: null, people: null, date: null, transport_need: null, pet: null },
      lead: { intent: 'curious', buying_signals: [], blockers: [], score_delta: 0, confidence: 0.5 },
      img: false,
    },
    tokens: { prompt: 1, completion: 1 },
  };
}

function runtimeOf(call: number): string {
  return mockComplete.mock.calls[call]?.[0].systemPrompt.split('\nRUNTIME:\n').at(-1) ?? '';
}

const PHONE = '573009990601';

function seedSoloQuote(repos: Repositories): void {
  repos.conversation.upsert(PHONE, {
    language: 'es', collected_plan: 'prime_2d1n_chivor', collected_people: 1,
    price_given_at: new Date(Date.now() - 120_000).toISOString(),
    quote_key: JSON.stringify({ people: 1, privateTransport: false }),
  });
  repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'Voy solo, quiero el de dos minas y cabalgata', created_at: new Date(Date.now() - 100_000).toISOString() });
  repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: 'Para 1 persona, el plan queda en $960.000 COP. ¿Les reviso cupo?', created_at: new Date(Date.now() - 90_000).toISOString() });
}

describe('P0 quote flow (synthetic)', () => {
  it('quotes 3 at the group rate with transport apart, after blocking the solo-rate draft', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    seedSoloQuote(repos);
    mockComplete
      .mockResolvedValueOnce(llmResult('Para 3 personas el PRIME queda en $1.440.000 COP y el transporte va aparte. ¿Les reviso cupo?'))
      .mockResolvedValueOnce(llmResult('Para 3 personas, el plan queda en $2.550.000 COP. El transporte privado desde Bogotá va aparte: $1.700.000 COP por vehículo, hasta 4 pasajeros. ¿Les reviso cupo?'));

    const result = await processMessage({ repos, customerPhone: PHONE, message: '¿cuánto para 3? ¿incluye transporte?' });

    const runtime = runtimeOf(0);
    expect(runtime).toContain('QUOTE LOCK (cotización pedida este turno)');
    expect(runtime).toContain('Para 3 personas, el plan queda en $2.550.000 COP');
    expect(runtime).toMatch(/transporte \$1\.700\.000 COP \([^)]+\) por vehículo, hasta 4 pasajeros = \$4\.250\.000 COP/);
    expect(runtime).not.toContain('PRECIO YA ENTREGADO');
    expect(runtimeOf(1)).toContain('CORRECCION PRECIO');
    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(result.reply).toContain('$2.550.000');
    expect(result.reply).not.toContain('1.440.000');
    // A what-if size never replaces the agreed group.
    expect(repos.conversation.getByPhone(PHONE)?.collected_people).toBe(1);
    db.close();
  });

  it('never sends 1.920.000 or 3.620.000 for 4 with transport: a persistent miss is blocked', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    seedSoloQuote(repos);
    const before = repos.conversation.getByPhone(PHONE);
    const bad = 'Para 4 personas el plan queda en $1.920.000 COP, con transporte $3.620.000 COP. ¿Les reviso cupo?';
    mockComplete.mockResolvedValue(llmResult(bad));

    const result = await processMessage({ repos, customerPhone: PHONE, message: '¿Total para 4 con transporte?' });

    expect(runtimeOf(0)).toMatch(/plan \$3\.400\.000 COP \+ transporte \$1\.700\.000 COP \([^)]+\) por vehículo, hasta 4 pasajeros = \$5\.100\.000 COP/);
    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(result.reply).not.toMatch(/1\.920\.000|3\.620\.000|\$/);
    expect(result.reply).toBe(getSkills().fallbackReplies.es.aiFailureQualified);
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('quote_mismatch_blocked');
    expect(result.priceJustGiven).toBe(false);
    const after = repos.conversation.getByPhone(PHONE);
    expect(after?.price_given_at).toBe(before?.price_given_at);
    expect(after?.quote_key).toBe(before?.quote_key);
    expect(after?.collected_people).toBe(1);
    db.close();
  });

  it('a declared group change re-opens QUOTE LOCK for the new size', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    seedSoloQuote(repos);
    mockComplete.mockResolvedValueOnce(llmResult('Para 4 personas, el plan queda en $3.400.000 COP. ¿Les reviso cupo?'));

    const result = await processMessage({ repos, customerPhone: PHONE, message: 'al final somos 4' });

    expect(repos.conversation.getByPhone(PHONE)?.collected_people).toBe(4);
    expect(runtimeOf(0)).toContain('QUOTE LOCK: escribe "Para 4 personas, el plan queda en $3.400.000 COP"');
    expect(runtimeOf(0)).not.toContain('PRECIO YA ENTREGADO');
    expect(result.reply).toContain('$3.400.000');
    expect(JSON.parse(repos.conversation.getByPhone(PHONE)?.quote_key ?? '{}')).toEqual({ people: 4, privateTransport: false });
    db.close();
  });

  it('back from 4 to 3 re-quotes 3, never the 4 total', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    repos.conversation.upsert(PHONE, {
      language: 'es', collected_plan: 'prime_2d1n_chivor', collected_people: 4,
      price_given_at: new Date(Date.now() - 120_000).toISOString(),
      quote_key: JSON.stringify({ people: 4, privateTransport: false }),
    });
    mockComplete.mockResolvedValueOnce(llmResult('Para 3 personas, el plan queda en $2.550.000 COP. ¿Les reviso cupo?'));

    const result = await processMessage({ repos, customerPhone: PHONE, message: 'mejor somos 3' });

    expect(runtimeOf(0)).toContain('Para 3 personas, el plan queda en $2.550.000 COP');
    expect(result.reply).toContain('$2.550.000');
    db.close();
  });

  it('"Empareja por ahora" after the group question stores 2 and CORE quotes 950.000', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    repos.conversation.upsert(PHONE, { language: 'es', collected_plan: 'core_2d1n_chivor' });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: '¿Viajan solos, en pareja o en grupo?', created_at: new Date(Date.now() - 60_000).toISOString() });
    mockComplete.mockResolvedValueOnce(llmResult('Para 2 personas, el plan queda en $950.000 COP. ¿Les reviso cupo?'));

    const result = await processMessage({ repos, customerPhone: PHONE, message: 'Empareja por ahora' });

    expect(repos.conversation.getByPhone(PHONE)?.collected_people).toBe(2);
    expect(runtimeOf(0)).toContain('Para 2 personas, el plan queda en $950.000 COP');
    expect(result.reply).toContain('$950.000');
    db.close();
  });

  it('quotes both sizes for "una o dos parejas" without storing either', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    repos.conversation.upsert(PHONE, { language: 'es', collected_plan: 'core_2d1n_coscuez', collected_people: 2 });
    mockComplete.mockResolvedValueOnce(llmResult('Para 2 personas, el plan queda en $1.004.000 COP; para 4 personas, $2.008.000 COP. ¿Cuál les sirve?'));

    const result = await processMessage({ repos, customerPhone: PHONE, message: '¿cuánto sería en una o dos parejas?' });

    const runtime = runtimeOf(0);
    expect(runtime).toContain('Para 2 personas, el plan queda en $1.004.000 COP');
    expect(runtime).toContain('Para 4 personas, el plan queda en $2.008.000 COP');
    expect(result.reply).toContain('$2.008.000');
    expect(repos.conversation.getByPhone(PHONE)?.collected_people).toBe(2);
    db.close();
  });
});
