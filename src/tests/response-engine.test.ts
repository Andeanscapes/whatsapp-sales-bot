import { describe, it, expect, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { processMessage } from '../services/response-engine.js';
import { addMessage } from '../services/conversation-store.js';

vi.mock('../services/deepseek-client.js', async () => {
  const actual = await vi.importActual('../services/deepseek-client.js');
  return { ...actual, callDeepSeek: vi.fn() };
});

vi.mock('../services/budget-guard.js', () => ({
  checkBudget: vi.fn(() => ({ aiAllowed: true })),
}));

vi.mock('../services/time-window-policy.js', () => ({
  checkTimeWindow: vi.fn(() => ({ isLimited: false })),
}));

import * as deepseekClient from '../services/deepseek-client.js';
import { checkBudget } from '../services/budget-guard.js';
import { checkTimeWindow } from '../services/time-window-policy.js';

let db: Database.Database;

beforeAll(() => {
  loadSkills();
  db = new Database(':memory:');
  migrate(db);
});

describe('processMessage', () => {
  it('handles opt-out keyword stop', async () => {
    vi.mocked(deepseekClient.callDeepSeek).mockReset();
    const phone = '573009990001';
    const result = await processMessage({ db, customerPhone: phone, message: 'stop' });
    expect(result.reply).toContain("won't send");
    expect(result.shouldSendReply).toBe(true);
    expect(result.leadScore).toBe(0);
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.usedAi).toBe(false);
  });

  it('prevents replies for opted-out customer', async () => {
    vi.mocked(deepseekClient.callDeepSeek).mockReset();
    const phone = '573009990002';
    await processMessage({ db, customerPhone: phone, message: 'stop' });
    const result = await processMessage({ db, customerPhone: phone, message: 'How much?' });
    expect(result.reply).toBe('');
    expect(result.shouldSendReply).toBe(false);
  });

  it('returns AI reply when DeepSeek succeeds', async () => {
    vi.mocked(deepseekClient.callDeepSeek).mockReset();
    vi.mocked(deepseekClient.callDeepSeek).mockResolvedValueOnce({
      response: {
        reply: 'Hola, soy Owner de Andean Scapes. Tenemos una experiencia minera en Chivor. Para ayudarte: cuantas personas serian?',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 80,
    });
    const result = await processMessage({ db, customerPhone: '573001112233', message: 'Hola' });
    expect(result.reply).toContain('Owner');
    expect(result.shouldSendReply).toBe(true);
    expect(result.usedAi).toBe(true);
  });

  it('returns graceful reply and alerts owner when DeepSeek fails', async () => {
    vi.mocked(deepseekClient.callDeepSeek).mockReset();
    vi.mocked(deepseekClient.callDeepSeek).mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    const result = await processMessage({ db, customerPhone: '573001112234', message: 'Tell me about your tours' });
    expect(result.reply).toContain('few minutes');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.usedAi).toBe(false);
  });

  it('returns graceful reply and alerts owner when DeepSeek returns null reply', async () => {
    vi.mocked(deepseekClient.callDeepSeek).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(deepseekClient.callDeepSeek).mockResolvedValueOnce({
      response: {
        reply: null,
        intent: 'unclear',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: true,
        missing_fields: ['user_request_unclear'],
        collected_fields: {},
      },
      promptTokens: 400,
      completionTokens: 30,
    });
    const result = await processMessage({ db, customerPhone: '573001112235', message: 'asdfghjkl' });
    expect(result.reply).toContain('validar');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('computes lead score and returns AI reply', async () => {
    vi.mocked(deepseekClient.callDeepSeek).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(deepseekClient.callDeepSeek).mockResolvedValueOnce({
      response: {
        reply: 'Perfecto, para esa fecha tenemos el plan. El valor es 190.000 COP por persona. Te gustaria que confirme disponibilidad?',
        intent: 'pricing',
        lead_score_delta: 15,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: { people: 2, date: 'june' },
      },
      promptTokens: 600,
      completionTokens: 100,
    });
    const result = await processMessage({
      db,
      customerPhone: '573001112236',
      message: 'Quiero reservar junio 8 para 2 personas con transporte desde Bogota',
    });
    expect(result.leadScore).toBeGreaterThan(0);
    expect(result.reply).toBeTruthy();
    expect(result.usedAi).toBe(true);
  });

  it('alerts owner when lead score is high', async () => {
    vi.mocked(deepseekClient.callDeepSeek).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(deepseekClient.callDeepSeek).mockResolvedValueOnce({
      response: {
        reply: 'Listo, te confirmo que el equipo revisara disponibilidad. En breve te contactamos.',
        intent: 'reservation',
        lead_score_delta: 85,
        should_send_image: false,
        needs_human: true,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 50,
    });
    const result = await processMessage({ db, customerPhone: '573001112237', message: 'Quiero reservar mayo 18 para 4 personas' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.reply).toBeTruthy();
  });

  it('uses conversation context in DeepSeek call', async () => {
    vi.mocked(deepseekClient.callDeepSeek).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(deepseekClient.callDeepSeek).mockResolvedValueOnce({
      response: {
        reply: 'Para esas fechas tenemos el 18 y 25 de mayo y el 8 de junio disponibles. Cual te queda mejor?',
        intent: 'availability',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 700,
      completionTokens: 60,
    });
    const phone = '573001112238';
    addMessage(db, { customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Hola', created_at: new Date(Date.now() - 60000).toISOString() });
    addMessage(db, { customer_phone: phone, direction: 'outbound', message_type: 'text', body: 'Hola, soy Owner de Andean Scapes. En que te puedo ayudar?', created_at: new Date(Date.now() - 50000).toISOString() });
    addMessage(db, { customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Quiero saber fechas disponibles', created_at: new Date(Date.now() - 40000).toISOString() });

    const result = await processMessage({ db, customerPhone: phone, message: 'fecha' });
    expect(result.reply).toContain('disponibles');
    expect(result.usedAi).toBe(true);

    const callArgs = vi.mocked(deepseekClient.callDeepSeek).mock.lastCall;
    expect(callArgs).toBeDefined();
    if (callArgs) {
      const recentMsgs = callArgs[2] as Array<{ role: string; content: string }> | undefined;
      expect(recentMsgs).toBeDefined();
      if (recentMsgs) {
        expect(recentMsgs.length).toBeGreaterThan(0);
      }
    }
  });

  it('alerts owner when budget is blocked', async () => {
    vi.mocked(deepseekClient.callDeepSeek).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: false, reason: 'daily_budget_exceeded' });
    const result = await processMessage({ db, customerPhone: '573001112239', message: 'Hola' });
    expect(result.reply).toContain('validar');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('alerts owner when time limit is reached', async () => {
    vi.mocked(deepseekClient.callDeepSeek).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: true, reason: 'hourly_limit' });
    const result = await processMessage({ db, customerPhone: '573001112240', message: 'Hola de nuevo' });
    expect(result.reply).toContain('validar');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('accepts null values in collected_fields', async () => {
    vi.mocked(deepseekClient.callDeepSeek).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(deepseekClient.callDeepSeek).mockResolvedValueOnce({
      response: {
        reply: 'Gracias por tu interes. El equipo revisara y te contactara pronto.',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: { name: null, people: null, date: null, transport_need: null, lodging_need: null, language: null },
      },
      promptTokens: 500,
      completionTokens: 60,
    });
    const result = await processMessage({ db, customerPhone: '573001112241', message: 'Hola' });
    expect(result.reply).toBeTruthy();
    expect(result.shouldSendReply).toBe(true);
    expect(result.usedAi).toBe(true);
  });

  it('marks handed_off and prevents further AI calls after NEEDS_HUMAN', async () => {
    vi.mocked(deepseekClient.callDeepSeek).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112242';

    vi.mocked(deepseekClient.callDeepSeek).mockResolvedValueOnce({
      response: {
        reply: 'Dame unos minuticos, termino de validar con el equipo de reservas.',
        intent: 'reservation',
        lead_score_delta: 40,
        should_send_image: false,
        needs_human: true,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 40,
    });

    const result1 = await processMessage({ db, customerPhone: phone, message: 'Quiero reservar ya' });
    expect(result1.shouldAlertOwner).toBe(true);
    expect(result1.shouldSendReply).toBe(true);

    vi.mocked(deepseekClient.callDeepSeek).mockReset();

    const result2 = await processMessage({ db, customerPhone: phone, message: 'Pero a que hora es?' });
    expect(result2.reply).toContain('equipo');
    expect(result2.shouldSendReply).toBe(true);
    expect(result2.usedAi).toBe(false);
    expect(result2.shouldAlertOwner).toBe(false);
  });
});
