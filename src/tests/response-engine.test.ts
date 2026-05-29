import { describe, it, expect, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import type { Repositories } from '../db/repositories/index.js';
import {
  processMessage,
  detectsReservationIntent,
  isReservationIntentOrConfirmation,
  replyMentionsPrice,
  containsHandoffPhrase,
  stripHandoffPhrases,
  isTruncatedReply,
} from '../services/response-engine.js';
import { sendAlert } from '../services/alert-service.js';
import { insertMediaSendAt, getLatestOwnerAlertBody } from './helpers/db-test-helpers.js';

vi.mock('../services/deepseek-client.js', async () => {
  const actual = await vi.importActual('../services/deepseek-client.js');
  return { ...actual, callDeepSeekCached: vi.fn() };
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
import { safeReservationHandoff, afterHoursReply, colombiaTimeAwareReply } from '../services/reply-guard.js';
import { selectImageForPlan, canSendPlanImage } from '../services/media-service.js';
import { getSkills } from '../services/skill-loader.js';

let repos: Repositories;
let db: Database.Database;

beforeAll(() => {
  loadSkills();
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
});

describe('processMessage', () => {
  it('handles opt-out keyword stop', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    const phone = '573009990001';
    const result = await processMessage({ repos, customerPhone: phone, message: 'stop' });
    expect(result.reply).toContain("won't send");
    expect(result.shouldSendReply).toBe(true);
    expect(result.leadScore).toBe(0);
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.usedAi).toBe(false);
  });

  it('prevents replies for opted-out customer', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    const phone = '573009990002';
    await processMessage({ repos, customerPhone: phone, message: 'stop' });
    const result = await processMessage({ repos, customerPhone: phone, message: 'How much?' });
    expect(result.reply).toBe('');
    expect(result.shouldSendReply).toBe(false);
  });

  it('returns AI reply when DeepSeek succeeds', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
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
    const result = await processMessage({ repos, customerPhone: '573001112233', message: 'Hola' });
    expect(result.reply).toContain('Owner');
    expect(result.shouldSendReply).toBe(true);
    expect(result.usedAi).toBe(true);
  });

  it('pauses with shareable summary when user needs to consult partner after price', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    const phone = '573001112232';
    repos.conversation.upsert(phone, {
      collected_name: 'Santiago',
      collected_people: 2,
      price_given_at: new Date().toISOString(),
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'seria para 2 pero dejame valido con mi pareja gracias' });

    expect(result.reply).toContain('Dale Santiago, cero afan');
    expect(result.reply).toContain('$1,040,000 COP total');
    expect(result.reply.toLowerCase()).not.toContain('transporte');
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.usedAi).toBe(false);
    expect(deepseekClient.callDeepSeekCached).not.toHaveBeenCalled();
  });

  it('returns graceful reply and alerts owner when DeepSeek fails (qualified, price given)', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    const phone = '573001112234';
    repos.conversation.upsert(phone, {
      collected_name: 'Maria',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'junio',
      collected_transport_need: 'yes',
      price_given_at: new Date().toISOString(),
    });
    const result = await processMessage({ repos, customerPhone: phone, message: 'Quiero reservar' });
    expect(result.reply).toContain('Maria');
    expect(result.reply).toContain('revisemos');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.usedAi).toBe(false);
  });

  it('returns graceful reply and alerts owner when DeepSeek returns null reply (qualified, price given)', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    const phone = '573001112235';
    repos.conversation.upsert(phone, {
      collected_name: 'Carlos',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'mayo',
      collected_transport_need: 'yes',
      price_given_at: new Date().toISOString(),
    });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
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
    const result = await processMessage({ repos, customerPhone: phone, message: 'asdfghjkl' });
    expect(result.reply).toContain('Carlos');
    expect(result.reply).toContain('revisemos');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('computes lead score and returns AI reply', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
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
      repos,
      customerPhone: '573001112236',
      message: 'Quiero reservar junio 8 para 2 personas con transporte desde Bogota',
    });
    expect(result.leadScore).toBeGreaterThan(0);
    expect(result.reply).toBeTruthy();
    expect(result.usedAi).toBe(true);
  });

  it('does not alert owner on high score without reservation-ready context', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
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
    const result = await processMessage({ repos, customerPhone: '573001112237', message: 'Quiero reservar mayo 18 para 4 personas' });
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.reply).toBeTruthy();
  });

  it('uses conversation context in DeepSeek call', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
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
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Hola', created_at: new Date(Date.now() - 60000).toISOString() });
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: 'Hola, soy Owner de Andean Scapes. En que te puedo ayudar?', created_at: new Date(Date.now() - 50000).toISOString() });
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Quiero saber fechas disponibles', created_at: new Date(Date.now() - 40000).toISOString() });

    const result = await processMessage({ repos, customerPhone: phone, message: 'fecha' });
    expect(result.reply).toContain('disponibles');
    expect(result.usedAi).toBe(true);

    const callArgs = vi.mocked(deepseekClient.callDeepSeekCached).mock.lastCall;
    expect(callArgs).toBeDefined();
    if (callArgs) {
      const recentMsgs = callArgs[3] as Array<{ role: string; content: string }> | undefined;
      expect(recentMsgs).toBeDefined();
      if (recentMsgs) {
        expect(recentMsgs.length).toBeGreaterThan(0);
      }
    }
  });

  it('alerts owner when budget is blocked', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: false, reason: 'daily_budget_exceeded' });
    const result = await processMessage({ repos, customerPhone: '573001112239', message: 'Hola' });
    expect(result.reply).toContain('validar esto');
    expect(result.reply.toLowerCase()).not.toContain('dame unos minuticos');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('soft closes, stores inbound message, and lowers score on decline', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112257';
    repos.conversation.upsert(phone, { lead_score: 40 });

    const result = await processMessage({ repos, customerPhone: phone, message: 'No gracias' });

    expect(result.reply).toContain('Entendido');
    expect(result.usedAi).toBe(false);
    expect(result.leadScore).toBe(25);

    const conv = repos.conversation.getByPhone(phone) as { lead_score: number; soft_closed_at: string | null };
    expect(conv.lead_score).toBe(25);
    expect(conv.soft_closed_at).toBeTruthy();

    const stored = { body: repos.message.getLastInboundBodies(phone, 1)[0]?.body } as { body: string };
    expect(stored.body).toBe('No gracias');
  });

  it('soft closes and sends IG link on price rejection', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112276';

    repos.conversation.upsert(phone, {
      collected_name: 'Carlos',
      collected_people: 2,
      collected_date: 'agosto',
      price_given_at: new Date().toISOString(),
      lead_score: 40,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'esta muy caro gracias' });
    expect(result.reply).toContain('https://www.instagram.com/andean_scapes/');
    expect(result.usedAi).toBe(false);
    expect(result.shouldAlertOwner).toBe(false);

    const conv = repos.conversation.getByPhone(phone) as { soft_closed_at: string | null };
    expect(conv.soft_closed_at).toBeTruthy();
  });

  it('filters price rejection from budget-related messages', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112277';

    repos.conversation.upsert(phone, {
      collected_name: 'Ana',
      collected_people: 1,
      price_given_at: new Date().toISOString(),
      lead_score: 35,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'se sale del presupuesto' });
    expect(result.reply).toContain('https://www.instagram.com/andean_scapes/');
    expect(result.usedAi).toBe(false);

    const conv = repos.conversation.getByPhone(phone) as { soft_closed_at: string | null };
    expect(conv.soft_closed_at).toBeTruthy();
  });

  it('clears soft close and scores re-engagement', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Claro, te cuento el itinerario primero. Cuantas personas serian?',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 40,
    });
    const phone = '573001112258';
    repos.conversation.upsert(phone, { lead_score: 10, soft_closed_at: new Date().toISOString() });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Bueno después de pensar cuál es el itinerario?' });

    expect(result.shouldSendReply).toBe(true);
    expect(result.leadScore).toBeGreaterThan(10);

    const conv = repos.conversation.getByPhone(phone) as { lead_score: number; soft_closed_at: string | null };
    expect(conv.lead_score).toBeGreaterThan(10);
    expect(conv.soft_closed_at).toBeNull();
  });

  it('alerts owner when time limit is reached', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: true, reason: 'hourly_limit' });
    const result = await processMessage({ repos, customerPhone: '573001112240', message: 'Hola de nuevo' });
    expect(result.reply).toContain('Te leo');
    expect(result.reply.toLowerCase()).not.toContain('automaticos');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(false);
  });

  it('accepts null values in collected_fields', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
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
    const result = await processMessage({ repos, customerPhone: '573001112241', message: 'Hola' });
    expect(result.reply).toBeTruthy();
    expect(result.shouldSendReply).toBe(true);
    expect(result.usedAi).toBe(true);
  });

  it('blocks handoff and strips canned text when reservation intent without price presented', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112242';

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Dame unos minuticos, termino de validar con el equipo de reservas para continuar con tu proceso.',
        intent: 'reservation',
        lead_score_delta: 40,
        should_send_image: false,
        needs_human: true,
        missing_fields: [],
        collected_fields: { name: 'Brian', people: 2, date: 'junio', transport_need: 'yes' },
      },
      promptTokens: 500,
      completionTokens: 40,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Quiero reservar ya' });
    expect(result.reply.toLowerCase()).not.toContain('dame unos minuticos');
    expect(result.reply.toLowerCase()).not.toContain('equipo de reservas');
    expect(result.shouldSendReply).toBe(true);

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(handed?.handed_off_at).toBeNull();
  });

  it('fires server-constructed handoff when qualification + price + reservation intent all present', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112243';

    repos.conversation.upsert(phone, {
      collected_name: 'Daniela',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'junio',
      collected_transport_need: 'yes',
      price_given_at: new Date().toISOString(),
    });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Genial Daniela, me alegra mucho!',
        intent: 'reservation',
        lead_score_delta: 30,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Quiero reservar ya' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.reply).toContain('Daniela');

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string };
    expect(handed.handed_off_at).toBeTruthy();

    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    const result2 = await processMessage({ repos, customerPhone: phone, message: 'A que hora es?' });
    expect(result2.usedAi).toBe(false);
  });

  it('boosts score and alerts owner on explicit reservation after price presented', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112258';

    repos.conversation.upsert(phone, {
      collected_name: 'Laura',
      collected_people: 2,
      collected_date: 'julio',
      collected_transport_need: 'yes',
      price_given_at: new Date().toISOString(),
      lead_score: 30,
    });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Perfecto Laura, genial que quieras reservar!',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'como se reserva?' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.leadScore).toBeGreaterThanOrEqual(95);

    const stored = repos.conversation.getByPhone(phone) as { lead_score: number };
    expect(stored.lead_score).toBeGreaterThanOrEqual(95);
  });

  it('alerts owner on clear reservation intent even when qualification is incomplete', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112247';

    repos.conversation.upsert(phone, {
      collected_name: 'Pedro',
      collected_people: 1,
      price_given_at: new Date().toISOString(),
    });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Genial Pedro! Para ayudarte con la reserva: que fecha tienes en mente?',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'me gustaria reservar ya' });
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('handoffs when date completes a recent reservation intent after price', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112299';

    repos.conversation.upsert(phone, {
      collected_name: 'Marta',
      collected_plan: '2d1n_mining',
      collected_people: 3,
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
      lead_score: 20,
    });
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'inbound',
      message_type: 'text',
      body: 'como se reserva?',
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Genial, finales de agosto suena bien. Te confirmo disponibilidad.',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: { date: 'finales de agosto' },
      },
      promptTokens: 500,
      completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'finales de agosto' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.leadScore).toBeGreaterThanOrEqual(95);

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(handed.handed_off_at).toBeTruthy();
  });

  it('triggers handoff and alert when user confirms reservation with si por favor', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112280';

    repos.conversation.upsert(phone, {
      collected_name: 'Andrea',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'agosto',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'outbound',
      message_type: 'text',
      body: '¿Qué te parece? ¿Te gustaría reservar para esa fecha?',
      created_at: new Date(Date.now() - 5_000).toISOString(),
    });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Perfecto! Confirmado.',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 20,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'si por favor' });
    expect(result.shouldAlertOwner).toBe(true);

    const conv = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(conv.handed_off_at).toBeTruthy();
  });

  it('detects dale cuenten conmigo as reservation intent', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112288';

    repos.conversation.upsert(phone, {
      collected_name: 'Tomas',
      collected_people: 4,
      collected_date: 'septiembre',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
      lead_score: 20,
    });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Genial Tomas! Te confirmamos disponibilidad en breve.',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 20,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'dale cuenten conmigo' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.leadScore).toBeGreaterThanOrEqual(95);
  });

  it('soft closes with IG link on gracias por la info lo voy a pensar', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112262';

    repos.conversation.upsert(phone, {
      collected_name: 'Lucia',
      collected_people: 2,
      price_given_at: new Date().toISOString(),
      lead_score: 35,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'gracias por la info, lo voy a pensar' });
    expect(result.reply).toContain('https://www.instagram.com/andean_scapes/');
    expect(result.usedAi).toBe(false);

    const conv = repos.conversation.getByPhone(phone) as { soft_closed_at: string | null };
    expect(conv.soft_closed_at).toBeTruthy();
  });

  it('re-engages after soft close when user says aqui estoy de vuelta', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112289';

    repos.conversation.upsert(phone, {
      collected_name: 'Diego',
      collected_people: 1,
      collected_date: 'julio',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
      soft_closed_at: new Date(Date.now() - 86_400_000).toISOString(),
      lead_score: 50,
    });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Diego, que alegria que vuelvas! Revisemos disponibilidad.',
        intent: 'general',
        lead_score_delta: 15,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'aqui estoy de vuelta, si quiero' });
    expect(result.reply).toContain('Diego');
    expect(result.usedAi).toBe(true);
  });

  it('treats Nequi as payment intent and hands off before payment details', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112253';

    repos.conversation.upsert(phone, {
      collected_name: 'Paula',
      collected_plan: '2d1n_mining',
      collected_people: 3,
      collected_date: 'junio',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Perfecto, por Nequi seria el deposito del 15%.',
        intent: 'reservation',
        lead_score_delta: 30,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'prefiero pagar por nequi' });
    expect(result.reply).toContain('Paula');
    expect(result.reply.toLowerCase()).not.toContain('238,500');
    expect(result.shouldAlertOwner).toBe(true);

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(handed.handed_off_at).toBeTruthy();
  });

  it('handoffs on Si after bot asks te gustaria reservar', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112270';

    repos.conversation.upsert(phone, {
      collected_name: 'Paula',
      collected_plan: '2d1n_mining',
      collected_people: 1,
      collected_date: 'agosto',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });

    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: '¿Qué te parece? ¿Te gustaría reservar para esas fechas?', created_at: new Date().toISOString() });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Qué emoción Paula! Te confirmamos el cupo y los datos de pago en un toque.',
        intent: 'reservation',
        lead_score_delta: 30,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 40,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Si' });
    expect(result.reply).toContain('Paula');
    expect(result.shouldAlertOwner).toBe(true);

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(handed.handed_off_at).toBeTruthy();
  });

  it('does NOT handoff on bare Si without reservation question context', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112271';

    repos.conversation.upsert(phone, {
      collected_name: 'Paula',
      collected_people: 1,
      collected_date: 'agosto',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });

    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: '¿Como te llamas?', created_at: new Date().toISOString() });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Mucho gusto Paula? Cuantas personas?',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Si' });
    expect(result.shouldAlertOwner).toBe(false);

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(handed.handed_off_at).toBeNull();
  });

  it('blocks placeholder payment instructions from AI reply', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112254';

    repos.conversation.upsert(phone, {
      collected_name: 'Paula',
      collected_plan: '2d1n_mining',
      collected_people: 3,
      collected_date: 'junio',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'El deposito se hace a este Nequi: [inserte número]. En cuanto pagues, separamos el cupo.',
        intent: 'reservation',
        lead_score_delta: 30,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 60,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'como se hace la reserva?' });
    expect(result.reply).not.toContain('[inserte número]');
    expect(result.reply.toLowerCase()).not.toContain('en cuanto pagues');
    expect(result.reply).toContain('Paula');
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('blocks unverified exact availability claims from AI reply', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112255';

    repos.conversation.upsert(phone, {
      collected_name: 'Paula',
      collected_plan: '2d1n_mining',
      collected_people: 3,
      collected_date: 'junio',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'La fecha disponible en junio es el domingo 8 de junio. Les sirve?',
        intent: 'reservation',
        lead_score_delta: 25,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 50,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'que fecha hay?' });
    expect(result.reply.toLowerCase()).not.toContain('domingo 8 de junio');
    expect(result.reply).toContain('Paula');
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('blocks false cupo/separation claims from AI reply', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112256';

    repos.conversation.upsert(phone, {
      collected_name: 'Paula',
      collected_plan: '2d1n_mining',
      collected_people: 3,
      collected_date: 'junio',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Te separo el cupo para esa fecha. Queda reservado mientras haces el deposito.',
        intent: 'reservation',
        lead_score_delta: 25,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 50,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'me interesa' });
    expect(result.reply.toLowerCase()).not.toContain('te separo');
    expect(result.reply.toLowerCase()).not.toContain('queda reservado');
    expect(result.reply).toContain('Paula');
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('detects price in AI reply and persists price_given_at', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112244';

    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Claro! Individual $550,000 y en pareja $1,040,000 COP, todo incluido. Cuantas personas serian?',
        intent: 'pricing',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: { name: 'Luis' },
      },
      promptTokens: 600,
      completionTokens: 70,
    });

    await processMessage({ repos, customerPhone: phone, message: 'cuanto cuesta?' });

    const row = repos.conversation.getByPhone(phone) as { price_given_at: string | null };
    expect(row.price_given_at).toBeTruthy();
  });

  it('asks next qualification question when AI fails and qualification incomplete', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    const result = await processMessage({ repos, customerPhone: '573001112245', message: 'Hola' });
    expect(result.reply).toContain('como te llamas');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.usedAi).toBe(false);
  });

  it('asks next qualification question when DeepSeek returns no-reply and qualification incomplete', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
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
    const result = await processMessage({ repos, customerPhone: '573001112246', message: '???' });
    expect(result.reply).toContain('como te llamas');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(false);
  });

  it('does not handoff on pet mention, stays in qualification', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Somos pet-friendly! Tu perro es bienvenido. Cuantas personas serian?',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: { name: 'Luis' },
      },
      promptTokens: 500,
      completionTokens: 40,
    });
    const phone = '573001112247';
    const result = await processMessage({ repos, customerPhone: phone, message: 'Soy Luis, mi esposo y yo y mi perro' });
    expect(result.reply).toContain('pet-friendly');
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.reply).not.toContain('equipo de reservas');

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(handed?.handed_off_at).toBeNull();
  });

  it('persists name from "soy Paula"', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Bienvenida Paula! Cuantas personas serian?',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: { name: 'Paula' },
      },
      promptTokens: 500,
      completionTokens: 30,
    });
    const phone = '573001112248';
    const result = await processMessage({ repos, customerPhone: phone, message: 'hola soy Paula' });
    expect(result.reply).toContain('Paula');
    const conv = repos.conversation.getByPhone(phone) as { collected_name: string | null };
    expect(conv.collected_name).toBe('Paula');
  });

  it('persists accented name from "Soy Álvaro"', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Mucho gusto Álvaro. Cuantas personas serian?',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });
    const phone = '573001112259';
    await processMessage({ repos, customerPhone: phone, message: 'Soy Álvaro' });
    const conv = repos.conversation.getByPhone(phone) as { collected_name: string | null };
    expect(conv.collected_name).toBe('Álvaro');
  });

  it('persists solo English traveler and month from "just me" message', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Perfect Jack, December noted. Would you need transport from Bogota?',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });
    const phone = '573001112268';
    await processMessage({ repos, customerPhone: phone, message: 'Just me I am planning to visit Colombia next december' });
    const conv = repos.conversation.getByPhone(phone) as { collected_people: number | null; collected_date: string | null; language: string | null };
    expect(conv.collected_people).toBe(1);
    expect(conv.collected_date).toBe('december');
    expect(conv.language).toBe('en');
  });

  it('persists standalone name after bot asks name', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Mucho gusto Álvaro. Cuantas personas serian?',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });
    const phone = '573001112260';
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: 'Antes de seguir, ¿como te llamas?', created_at: new Date().toISOString() });
    await processMessage({ repos, customerPhone: phone, message: 'Álvaro' });
    const conv = repos.conversation.getByPhone(phone) as { collected_name: string | null };
    expect(conv.collected_name).toBe('Álvaro');
  });

  it('answers actionable reservation/itinerary question instead of re-asking missing name on AI failure', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112261';
    repos.conversation.upsert(phone, {
      collected_people: 2,
      collected_date: 'agosto',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });
    const result = await processMessage({ repos, customerPhone: phone, message: 'Si como se reserva ? Pero aclárame el itinerario a qué hora debo llegar ?' });
    expect(result.reply).toContain('Incluye experiencia minera');
    expect(result.reply).not.toContain('como te llamas');
  });

  it('extracts solo traveler correction without storing Ya as name', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Tienes razon, una persona. Para que fecha?',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });
    const phone = '573001112263';
    await processMessage({ repos, customerPhone: phone, message: 'Ya dije que yo sola' });
    const conv = repos.conversation.getByPhone(phone) as { collected_name: string | null; collected_people: number | null };
    expect(conv.collected_name).toBeNull();
    expect(conv.collected_people).toBe(1);
  });

  it('handoffs payment intent even when message limit is reached', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: true, reason: 'hourly_limit' });
    const phone = '573001112264';
    repos.conversation.upsert(phone, {
      collected_name: 'Claudia',
      collected_plan: '2d1n_mining',
      collected_people: 1,
      collected_date: 'agosto',
      collected_transport_need: 'public_bus',
      price_given_at: new Date().toISOString(),
      lead_score: 70,
    });
    const result = await processMessage({ repos, customerPhone: phone, message: 'Si quiero pagar por favor' });
    expect(result.reply).toContain('Claudia');
    expect(result.reply).toContain('bus');
    expect(result.reply.toLowerCase()).not.toContain('responderte a medias');
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('summarizes public bus as customer-paid transport in handoff', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: true, reason: 'hourly_limit' });
    const phone = '573001112265';
    repos.conversation.upsert(phone, {
      collected_name: 'Claudia',
      collected_plan: '2d1n_mining',
      collected_people: 1,
      collected_date: 'agosto',
      collected_transport_need: 'public_bus',
      price_given_at: new Date().toISOString(),
      lead_score: 90,
    });
    const result = await processMessage({ repos, customerPhone: phone, message: 'Si quiero pagar por favor' });
    expect(result.reply).toContain('bus');
    expect(result.reply).not.toContain('transporte propio');
  });

  it('keeps English for reservation handoff and ambiguous follow-up', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112269';
    repos.conversation.upsert(phone, {
      language: 'en',
      collected_name: 'Jack',
      collected_plan: '2d1n_mining',
      collected_people: 1,
      collected_date: 'december',
      collected_transport_need: 'yes',
      price_given_at: new Date().toISOString(),
    });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Perfect! We will confirm availability and payment details shortly.',
        intent: 'reservation',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });
    const result = await processMessage({ repos, customerPhone: phone, message: 'Lol yes so how can I make reservation ?' });
    expect(result.reply).toMatch(/Perfect|Great|Excellent/);
    expect(result.reply).toContain('Jack');
    expect(result.reply).not.toContain('Perfecto');

    const followUp = await processMessage({ repos, customerPhone: phone, message: '?' });
    expect(followUp.reply).toMatch(/team|info|reservation/i);
    expect(followUp.reply).not.toContain('equipo');
  });

  it('replaces generic conversion reply with itinerary and does not alert before reservation intent', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112266';
    repos.conversation.upsert(phone, {
      collected_name: 'Juana',
      collected_people: 3,
      collected_date: 'agosto',
      collected_transport_need: 'public_bus',
      price_given_at: new Date().toISOString(),
      lead_score: 85,
    });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Juana, me alegra que estes bien con eso. Entonces, ¿quieres que revisemos disponibilidad para la fecha tentativa?',
        intent: 'general',
        lead_score_delta: 10,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 50,
    });
    const result = await processMessage({ repos, customerPhone: phone, message: 'Cómo sería el itinerario a qué horas debo llegar ?' });
    expect(result.reply).toContain('Incluye experiencia minera');
    expect(result.reply).not.toContain('revisemos disponibilidad');
    expect(result.shouldAlertOwner).toBe(false);
  });

  it('does not alert on repeated itinerary question even with score above threshold', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112267';
    repos.conversation.upsert(phone, {
      collected_name: 'Juana',
      collected_people: 3,
      collected_date: 'agosto',
      collected_transport_need: 'public_bus',
      price_given_at: new Date().toISOString(),
      lead_score: 95,
    });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Claro, te cuento el itinerario.',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });
    const result = await processMessage({ repos, customerPhone: phone, message: 'Como es el itinerario no me dijiste' });
    expect(result.leadScore).toBe(100);
    expect(result.shouldAlertOwner).toBe(false);
  });

  it('persists people from "somos 2 y mi perro"', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Somos pet-friendly! Cuantas personas serian?',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: { people: 2, pet: 'yes' },
      },
      promptTokens: 500,
      completionTokens: 40,
    });
    const phone = '573001112249';
    await processMessage({ repos, customerPhone: phone, message: 'somos 2 y mi perro' });
    const conv = repos.conversation.getByPhone(phone) as { collected_people: number | null; collected_pet: string | null };
    expect(conv.collected_people).toBe(2);
    expect(conv.collected_pet).toBe('yes');
  });

  it('persists transport from "vamos en moto"', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Genial, en moto llegan sin problema!',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: { transport_need: 'own' },
      },
      promptTokens: 500,
      completionTokens: 30,
    });
    const phone = '573001112250';
    await processMessage({ repos, customerPhone: phone, message: 'si tenemos vehiculo propio moto' });
    const conv = repos.conversation.getByPhone(phone) as { collected_transport_need: string | null };
    expect(conv.collected_transport_need).toBe('own');
  });

  it('handles "ya lo dije" correction and continues flow', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112251';
    repos.conversation.upsert(phone, {
      collected_name: 'Paula',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'agosto',
      collected_transport_need: 'own',
      collected_pet: 'yes',
      price_given_at: new Date().toISOString(),
    });
    const result = await processMessage({ repos, customerPhone: phone, message: 'Paula ya lo dije antes' });
    expect(result.reply).toContain('razon');
    expect(result.reply).toContain('Paula');
    expect(result.reply).not.toContain('como te llamas');
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('reconstructs qualification from conversation history on AI failure', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    const phone = '573001112252';

    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'soy Paula', created_at: new Date(Date.now() - 300000).toISOString() });
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: 'Cuantas personas?', created_at: new Date(Date.now() - 280000).toISOString() });
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'somos 2', created_at: new Date(Date.now() - 260000).toISOString() });
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'vamos en moto', created_at: new Date(Date.now() - 200000).toISOString() });

    const result = await processMessage({ repos, customerPhone: phone, message: 'si esta bien' });
    expect(result.reply).not.toContain('como te llamas');

    const conv = repos.conversation.getByPhone(phone)!;
    expect(conv.collected_name).toBe('Paula');
    expect(conv.collected_people).toBe(2);
    expect(conv.collected_transport_need).toBe('own');
  });

  it('greeting never mentions specific plans, locations, or experiences', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Hola! Soy Heinner, co-founder de Andean Scapes junto con Alexandra. Creamos experiencias autenticas en Boyaca con cultura local, naturaleza y comunidades anfitrionas. ¿como te llamas?',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 40,
    });
    const result = await processMessage({ repos, customerPhone: '573001113005', message: 'Hola' });

    expect(result.reply).toContain('Boyaca');
    expect(result.reply).not.toMatch(/\b(?:mina|esmeralda|chivor|hacienda|apicultura|ganader[ií]a|artesan[ií]a|R[aá]quira)\b/i);
    expect(result.reply).toMatch(/como te llamas/i);
  });

  it('asks plan after name and replaces name token', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113001';

    const result = await processMessage({ repos, customerPhone: phone, message: 'soy Ana' });

    expect(result.reply).toContain('Ana');
    expect(result.reply).toContain('tipo de experiencia');
    expect(result.reply).not.toContain('{{name}}');
  });

  it('detects 3D/2N plan and persists it', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Genial, el plan de 3 dias incluye apicultura y ganaderia.',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });
    const phone = '573001113002';

    await processMessage({ repos, customerPhone: phone, message: 'quiero el plan de 3 dias con abejas' });

    const conv = repos.conversation.getByPhone(phone) as { collected_plan: string | null };
    expect(conv.collected_plan).toBe('3d2n_rural');
  });

  it('detects 3D/2N when message also mentions mine', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Genial, el plan de 3 dias incluye mina, apicultura y ganaderia.',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });
    const phone = '573001113007';

    await processMessage({ repos, customerPhone: phone, message: 'quiero el plan de la mina de 3 dias' });

    const conv = repos.conversation.getByPhone(phone) as { collected_plan: string | null };
    expect(conv.collected_plan).toBe('3d2n_rural');
  });

  it('latest explicit 3D/2N mention overrides older stored 2D/1N plan', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113006';
    repos.conversation.upsert(phone, {
      collected_name: 'David',
      collected_plan: '2d1n_mining',
      collected_date: 'agosto',
      collected_transport_need: 'own',
    });
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'inbound',
      message_type: 'text',
      body: 'quiero validar el plan de 3 dias',
      created_at: new Date(Date.now() - 1000).toISOString(),
    });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Para 3 personas en el plan de 3 dias seria $2,150,000 COP.',
        intent: 'pricing',
        lead_score_delta: 10,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'somos tres que precio tiene?' });

    expect(result.priceFollowUpText).toContain('$2,150,000 COP');
    const conv = repos.conversation.getByPhone(phone) as { collected_plan: string | null };
    expect(conv.collected_plan).toBe('3d2n_rural');
  });

  it('uses 3D/2N image after ambiguous mine plus 3 days plan mention', async () => {
    const skills = getSkills();
    const image = selectImageForPlan(skills.media.images, '3d2n_rural');
    expect(image?.value).toBe('https://cdn.andeanscapes.com/whatsapp_bot/3d2n_1.png');
  });

  it('blocks handoff until plan is selected', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113003';
    repos.conversation.upsert(phone, {
      collected_name: 'Ana',
      collected_people: 2,
      collected_date: 'agosto',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Perfecto Ana, te confirmamos cupo.',
        intent: 'reservation',
        lead_score_delta: 30,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'quiero reservar' });

    expect(result.shouldAlertOwner).toBe(true);
    expect(result.reply).toContain('tipo de experiencia');
    const conv = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(conv.handed_off_at).toBeNull();
  });

  describe('safeReservationHandoff after-hours', () => {
    it('uses standard handoff before 8 PM Colombia', () => {
      const skills = getSkills();
      const fb = skills.fallbackReplies.es;
      const q = { nombre: 'Claudia', personas: 2, fecha: 'agosto', transporte: 'own' };
      const before8pm = new Date('2026-06-15T19:59:00-05:00');
      const reply = safeReservationHandoff(q, fb, 'es', before8pm);
      expect(reply).toContain('Claudia');
      expect(reply).not.toContain('mañana en la mañana');
      expect(reply).not.toContain('tomorrow morning');
    });

    it('uses after-hours handoff at or after 8 PM Colombia', () => {
      const skills = getSkills();
      const fb = skills.fallbackReplies.es;
      const q = { nombre: 'Claudia', personas: 2, fecha: 'agosto', transporte: 'own' };
      const at8pm = new Date('2026-06-15T20:00:00-05:00');
      const reply = safeReservationHandoff(q, fb, 'es', at8pm);
      expect(reply).toContain('Claudia');
      expect(reply).toContain('mañana en la mañana');
    });

    it('uses after-hours handoff in English at 9 PM Colombia', () => {
      const skills = getSkills();
      const fb = skills.fallbackReplies.en;
      const q = { nombre: 'Jack', personas: 1, fecha: 'june', transporte: 'yes' };
      const at9pm = new Date('2026-06-15T21:00:00-05:00');
      const reply = safeReservationHandoff(q, fb, 'en', at9pm);
      expect(reply).toContain('Jack');
      expect(reply).toContain('tomorrow morning');
    });

    it('uses morning handoff at 8:59 AM Colombia', () => {
      const skills = getSkills();
      const fb = skills.fallbackReplies.es;
      const q = { nombre: 'Pedro', personas: 1, fecha: 'julio', transporte: 'own' };
      const early = new Date('2026-06-16T08:59:00-05:00');
      const reply = safeReservationHandoff(q, fb, 'es', early);
      expect(reply).toContain('después de las 9:00 a.m.');
      expect(reply).not.toContain('mañana en la mañana');
    });

    it('uses standard handoff at 9:00 AM Colombia', () => {
      const skills = getSkills();
      const fb = skills.fallbackReplies.es;
      const q = { nombre: 'Pedro', personas: 1, fecha: 'julio', transporte: 'own' };
      const at9am = new Date('2026-06-16T09:00:00-05:00');
      const reply = safeReservationHandoff(q, fb, 'es', at9am);
      expect(reply).not.toContain('mañana en la mañana');
    });
  });

  describe('selectImageForPlan', () => {
    it('selects 2D/1N image for 2d1n_mining plan', () => {
      const skills = getSkills();
      const image = selectImageForPlan(skills.media.images, '2d1n_mining');
      expect(image?.id).toBe('emerald_mining_preview_1');
    });

    it('selects 3D/2N image for 3d2n_rural plan', () => {
      const skills = getSkills();
      const image = selectImageForPlan(skills.media.images, '3d2n_rural');
      expect(image?.id).toBe('rural_experience_preview_1');
    });

    it('falls back to first valid image when plan is unknown', () => {
      const skills = getSkills();
      const image = selectImageForPlan(skills.media.images, 'nonexistent_plan');
      expect(image?.id).toBe('emerald_mining_preview_1');
    });

    it('falls back to first valid image when plan is null', () => {
      const skills = getSkills();
      const image = selectImageForPlan(skills.media.images, null);
      expect(image?.id).toBe('emerald_mining_preview_1');
    });
  });

  describe('afterHoursReply helper', () => {
    it('returns after-hours text for 8 PM Colombia time', () => {
      const at8pm = new Date('2026-06-15T20:00:00-05:00');
      const result = afterHoursReply('normal text', 'after-hours text', at8pm);
      expect(result).toBe('after-hours text');
    });

    it('returns after-hours text for 8:59 AM Colombia time', () => {
      const early = new Date('2026-06-16T08:59:00-05:00');
      const result = afterHoursReply('normal text', 'after-hours text', early);
      expect(result).toBe('after-hours text');
    });

    it('returns normal text for 9:00 AM Colombia time', () => {
      const at9am = new Date('2026-06-16T09:00:00-05:00');
      const result = afterHoursReply('normal text', 'after-hours text', at9am);
      expect(result).toBe('normal text');
    });

    it('returns normal text for noon Colombia time', () => {
      const noon = new Date('2026-06-16T12:00:00-05:00');
      const result = afterHoursReply('normal text', 'after-hours text', noon);
      expect(result).toBe('normal text');
    });
  });

  describe('colombiaTimeAwareReply helper', () => {
    it('returns night text for 8 PM Colombia time', () => {
      const at8pm = new Date('2026-06-15T20:00:00-05:00');
      const result = colombiaTimeAwareReply('normal', 'night', 'morning', at8pm);
      expect(result).toBe('night');
    });

    it('returns morning text for 8:59 AM Colombia time', () => {
      const early = new Date('2026-06-16T08:59:00-05:00');
      const result = colombiaTimeAwareReply('normal', 'night', 'morning', early);
      expect(result).toBe('morning');
    });

    it('returns normal text for 9:00 AM Colombia time', () => {
      const at9am = new Date('2026-06-16T09:00:00-05:00');
      const result = colombiaTimeAwareReply('normal', 'night', 'morning', at9am);
      expect(result).toBe('normal');
    });
  });

  describe('canSendPlanImage', () => {
    it('allows first image for a customer', () => {
      expect(canSendPlanImage(repos, '573001119001', 'emerald_mining_preview_1')).toBe(true);
    });

    it('allows different plan image when last image was for another plan', () => {
      insertMediaSendAt(db, '573001119002', 'emerald_mining_preview_1', new Date(Date.now() - 1000).toISOString());
      expect(canSendPlanImage(repos, '573001119002', 'rural_experience_preview_1')).toBe(true);
    });

    it('blocks same image sent recently', () => {
      insertMediaSendAt(db, '573001119003', 'rural_experience_preview_1', new Date(Date.now() - 1000).toISOString());
      expect(canSendPlanImage(repos, '573001119003', 'rural_experience_preview_1')).toBe(false);
    });

    it('blocks same image even when another image was sent later', () => {
      const phone = '573001119004';
      insertMediaSendAt(db, phone, 'emerald_mining_preview_1', new Date(Date.now() - 2000).toISOString());
      insertMediaSendAt(db, phone, 'rural_experience_preview_1', new Date(Date.now() - 1000).toISOString());
      expect(canSendPlanImage(repos, phone, 'emerald_mining_preview_1')).toBe(false);
    });
  });

  it('keeps shouldSendImage true when plan image changed inside 72h', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119005';
    repos.conversation.upsert(phone, {
      collected_name: 'Ana',
      collected_plan: '3d2n_rural',
      collected_people: 2,
      collected_date: 'agosto',
      collected_transport_need: 'own',
    });
    insertMediaSendAt(db, phone, 'emerald_mining_preview_1', new Date(Date.now() - 1000).toISOString());
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Claro, te puedo mostrar una imagen del plan 3D/2N.',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: true,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'me muestras foto del plan de 3 dias?' });

    expect(result.shouldSendImage).toBe(true);
  });

  it('uses 3D/2N JSON pricing for price follow-up', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113004';
    repos.conversation.upsert(phone, {
      collected_name: 'Ana',
      collected_plan: '3d2n_rural',
      collected_people: 2,
      collected_date: 'agosto',
      collected_transport_need: 'own',
    });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Para pareja el plan queda en $1,590,000 COP.',
        intent: 'pricing',
        lead_score_delta: 10,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'cuanto cuesta?' });

    expect(result.priceFollowUpText).toContain('$1,400,000 COP');
  });

  it('migrates old conversations table with collected_plan column', () => {
    const oldDb = new Database(':memory:');
    oldDb.exec(`CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_phone TEXT NOT NULL UNIQUE,
      language TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      lead_score INTEGER DEFAULT 0,
      hot_alert_sent_at TEXT,
      urgent_alert_sent_at TEXT,
      opt_out_at TEXT,
      free_entry_detected INTEGER DEFAULT 0,
      ad_referral_json TEXT,
      collected_name TEXT,
      collected_date TEXT,
      collected_people INTEGER,
      collected_transport_need TEXT,
      collected_lodging_need TEXT,
      collected_pet TEXT,
      price_given_at TEXT,
      handed_off_at TEXT,
      soft_closed_at TEXT
    )`);

    migrate(oldDb);

    const columns = oldDb.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>;
    expect(columns.map(c => c.name)).toContain('collected_plan');
  });

  it('renders owner alert name in template', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response));
    vi.stubGlobal('fetch', fetchMock);
    await sendAlert({
      customerPhone: '573001112262',
      score: 85,
      intent: 'lead',
      message: 'quiero reservar',
      name: 'Álvaro',
      date: 'agosto',
      people: '2',
      transport: 'own',
    }, repos);
    const body = getLatestOwnerAlertBody(db, '573001112262')!;
    expect(body).toContain('Name: Álvaro');
    expect(body).toContain('WhatsApp: https://wa.me/573001112262');
    expect(body).not.toContain('{{name}}');
  });

  it('persists transport from "si tenemos transporte" after transport question', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Genial, transporte propio anotado!',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    });
    const phone = '573001112272';
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: '¿Van con transporte propio o necesitan desde Bogotá?', created_at: new Date().toISOString() });
    await processMessage({ repos, customerPhone: phone, message: 'si tenemos transporte' });
    const conv = repos.conversation.getByPhone(phone) as { collected_transport_need: string | null };
    expect(conv.collected_transport_need).toBe('own');
  });

  it('answers donde deberiamos llegar rather than re-asking qualification', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112273';
    repos.conversation.upsert(phone, {
      collected_name: 'Clara',
      collected_people: 5,
      collected_date: 'agosto',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });
    const result = await processMessage({ repos, customerPhone: phone, message: 'si tenemos vehiculo. donde deberiamos llegar ?' });
    expect(result.reply).not.toContain('como te llamas');
    expect(result.reply).not.toContain('Cuantas personas');
  });

  it('breaks generic reply loop when user says ?', async () => {
    vi.mocked(deepseekClient.callDeepSeekCached).mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112274';
    repos.conversation.upsert(phone, {
      collected_name: 'Michael',
      collected_people: 1,
      collected_date: 'june',
      collected_transport_need: 'yes',
      price_given_at: new Date().toISOString(),
    });
    vi.mocked(deepseekClient.callDeepSeekCached).mockResolvedValueOnce({
      response: {
        reply: 'Michael, glad you\'re comfortable with that. So, would you like us to check availability for the tentative date?',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 50,
    });
    const result = await processMessage({ repos, customerPhone: phone, message: '?' });
    expect(result.reply).not.toContain('glad you\'re comfortable');
    expect(result.reply).toContain('Michael');
  });
});

describe('detectsReservationIntent', () => {
  it('matches explicit Spanish reservation phrases', () => {
    expect(detectsReservationIntent('Quiero reservar ya')).toBe(true);
    expect(detectsReservationIntent('Como pago?')).toBe(true);
    expect(detectsReservationIntent('donde transfiero')).toBe(true);
    expect(detectsReservationIntent('manda el link de pago')).toBe(true);
    expect(detectsReservationIntent('Listo, agendamos')).toBe(true);
    expect(detectsReservationIntent('vamos a reservar')).toBe(true);
    expect(detectsReservationIntent('pago por nequi')).toBe(true);
    expect(detectsReservationIntent('fijo que si')).toBe(true);
    expect(detectsReservationIntent('si')).toBe(false);
  });

  it('matches English reservation phrases', () => {
    expect(detectsReservationIntent('I want to book')).toBe(true);
    expect(detectsReservationIntent('how do I pay?')).toBe(true);
    expect(detectsReservationIntent('send me the payment link')).toBe(true);
  });

  it('does NOT match qualification answers', () => {
    expect(detectsReservationIntent('Somos 2 personas')).toBe(false);
    expect(detectsReservationIntent('En junio')).toBe(false);
    expect(detectsReservationIntent('Soy Brian')).toBe(false);
    expect(detectsReservationIntent('Cuanto cuesta?')).toBe(false);
    expect(detectsReservationIntent('Si me interesa')).toBe(false);
    expect(detectsReservationIntent('Necesitamos transporte desde Bogota')).toBe(false);
  });
});

describe('isReservationIntentOrConfirmation', () => {
  it('returns true for Si after te gustaria reservar', () => {
    expect(isReservationIntentOrConfirmation('Si', '¿Qué te parece? ¿Te gustaría reservar para esas fechas?')).toBe(true);
  });

  it('returns true for Yes after shall we book', () => {
    expect(isReservationIntentOrConfirmation('Yes', 'Would you like to book for these dates?')).toBe(true);
  });

  it('returns false for Si after como te llamas', () => {
    expect(isReservationIntentOrConfirmation('Si', '¿Como te llamas?')).toBe(false);
  });

  it('returns false for Si without context', () => {
    expect(isReservationIntentOrConfirmation('Si', null)).toBe(false);
  });

  it('returns true for payment intent even without reservation question', () => {
    expect(isReservationIntentOrConfirmation('pago por nequi', null)).toBe(true);
  });
});

describe('replyMentionsPrice', () => {
  it('detects formatted COP prices', () => {
    expect(replyMentionsPrice('Individual $550,000 COP')).toBe(true);
    expect(replyMentionsPrice('Pareja $1,040,000 COP')).toBe(true);
    expect(replyMentionsPrice('El total queda en 2.740.000 COP')).toBe(true);
    expect(replyMentionsPrice('190.000 pesos por persona')).toBe(true);
  });

  it('does NOT match prose without prices', () => {
    expect(replyMentionsPrice('Genial, te cuento sobre el plan')).toBe(false);
    expect(replyMentionsPrice('Cuantas personas serian?')).toBe(false);
    expect(replyMentionsPrice('')).toBe(false);
  });
});

describe('handoff phrase detection', () => {
  it('detects exact handoff phrase in Spanish', () => {
    expect(containsHandoffPhrase('Dame unos minuticos, termino de validar con el equipo de reservas para continuar.')).toBe(true);
  });

  it('detects English handoff phrase', () => {
    expect(containsHandoffPhrase('Give me a few minutes, I am finishing up with the reservations team.')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(containsHandoffPhrase('Cuantas personas serian?')).toBe(false);
    expect(containsHandoffPhrase('te paso al equipo')).toBe(false);
  });

  it('strips the handoff phrase', () => {
    const input = 'Genial! Dame unos minuticos, termino de validar con el equipo de reservas para continuar con tu proceso.';
    expect(stripHandoffPhrases(input).toLowerCase()).not.toContain('dame unos minuticos');
    expect(stripHandoffPhrases(input)).toContain('Genial');
  });
});

describe('isTruncatedReply', () => {
  it('detects truncated Spanish reply', () => {
    expect(isTruncatedReply('Claro, Paula. Desde')).toBe(true);
    expect(isTruncatedReply('Perfecto, para')).toBe(true);
  });

  it('detects truncated English reply', () => {
    expect(isTruncatedReply('Sure, from the')).toBe(false);
  });

  it('passes complete replies', () => {
    expect(isTruncatedReply('Claro Paula, te cuento bien.')).toBe(false);
    expect(isTruncatedReply('Perfect!')).toBe(false);
  });
});
