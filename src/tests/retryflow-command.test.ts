import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';

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

vi.mock('../services/time-window-policy.js', () => ({
  checkTimeWindow: vi.fn(() => ({ isLimited: false })),
  isWithinServiceWindow: vi.fn(() => true),
}));

vi.mock('../services/whatsapp-client.js', () => ({
  sendText: vi.fn(() => Promise.resolve()),
}));

import { retryflowHandler } from '../commands/retryflow.command.js';
import { sendText } from '../services/whatsapp-client.js';
import { isWithinServiceWindow } from '../services/time-window-policy.js';
import type { LlmResult } from '../services/llm/llm-client.js';

const PHONE = '573001112233';
let repos: Repositories;
let db: Database.Database;

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

beforeEach(() => {
  loadSkills();
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  mockLlmComplete.mockReset();
  vi.mocked(sendText).mockClear();
  vi.mocked(isWithinServiceWindow).mockReturnValue(true);
});

afterEach(() => {
  db.close();
});

describe('/retryflow', () => {
  it('returns usage with no phone', async () => {
    expect(await retryflowHandler({ repos, args: [], chatId: 111 })).toContain('Uso:');
  });

  it('rejects when outside the service window', async () => {
    vi.mocked(isWithinServiceWindow).mockReturnValue(false);
    const out = await retryflowHandler({ repos, args: [PHONE], chatId: 111 });
    expect(out).toContain('24h');
    expect(sendText).not.toHaveBeenCalled();
  });

  it('reports when there is no inbound message', async () => {
    const out = await retryflowHandler({ repos, args: [PHONE], chatId: 111 });
    expect(out).toContain('No hay mensaje entrante');
  });

  it('replays the last inbound and sends a reply without duplicating the inbound row', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    addMsg('inbound', 'cuanto vale el tour?', -1000);
    mockLlmComplete.mockResolvedValueOnce(reply('Con gusto te cuento, ¿cuántas personas?'));

    const inboundBefore = (db.prepare(
      "SELECT COUNT(*) c FROM messages WHERE customer_phone = ? AND direction = 'inbound'"
    ).get(PHONE) as { c: number }).c;

    const out = await retryflowHandler({ repos, args: [PHONE], chatId: 111 });

    const inboundAfter = (db.prepare(
      "SELECT COUNT(*) c FROM messages WHERE customer_phone = ? AND direction = 'inbound'"
    ).get(PHONE) as { c: number }).c;

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(out).toContain('Reenviado a flujo bot');
    expect(inboundAfter).toBe(inboundBefore);
  });

  it('is idempotent: rejects a second retry once a reply was stored', async () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    addMsg('inbound', 'cuanto vale el tour?', -1000);
    mockLlmComplete.mockResolvedValue(reply('Con gusto te cuento, ¿cuántas personas?'));

    await retryflowHandler({ repos, args: [PHONE], chatId: 111 });
    vi.mocked(sendText).mockClear();

    const out = await retryflowHandler({ repos, args: [PHONE], chatId: 111 });

    expect(out).toContain('ya tuvo respuesta');
    expect(sendText).not.toHaveBeenCalled();
  });
});
