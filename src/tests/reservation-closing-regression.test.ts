import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { getActiveExperience } from '../services/product-registry.js';
import { getSkills, loadSkills } from '../services/skill-loader.js';
import type { LlmClientInput, LlmResult } from '../services/llm/llm-client.js';
import type { LeadAnalysis } from '../services/lead-analyzer.js';

const { mockComplete } = vi.hoisted(() => ({
  mockComplete: vi.fn<(input: LlmClientInput) => Promise<LlmResult | null>>(),
}));
const { mockAnalyzeLead } = vi.hoisted(() => ({
  mockAnalyzeLead: vi.fn<() => Promise<LeadAnalysis | null>>(() => Promise.resolve(null)),
}));
const { mockSendBridgeReply } = vi.hoisted(() => ({
  mockSendBridgeReply: vi.fn(async (_repos: unknown, _phone: string, _body: string) => ({ ok: true as const, message: 'sent' })),
}));
const { mockCreatePreference } = vi.hoisted(() => ({
  mockCreatePreference: vi.fn(async () => ({
    paymentUrl: 'https://www.mercadopago.com/checkout/v1/redirect?pref_id=pref-1',
    preferenceId: 'pref-1',
  })),
}));

vi.mock('../services/llm/deepseek-llm-client.js', () => ({
  DeepSeekLlmClient: vi.fn().mockImplementation(() => ({ complete: mockComplete })),
}));

vi.mock('../services/budget-guard.js', () => ({
  checkBudget: vi.fn(() => ({ aiAllowed: true })),
}));

vi.mock('../services/time-window-policy.js', () => ({
  checkTimeWindow: vi.fn(() => ({ isLimited: false })),
}));

vi.mock('../services/lead-analyzer.js', () => ({
  analyzeLead: mockAnalyzeLead,
}));

vi.mock('../services/bridge-service.js', () => ({
  sendBridgeReply: mockSendBridgeReply,
}));

vi.mock('../services/mercadopago-service.js', () => ({
  createMercadoPagoPreference: mockCreatePreference,
}));

import { processMessage } from '../services/response-engine.js';
import { paymentHandler } from '../commands/payment.command.js';
import { env } from '../config/env.js';
import { isDynamicDataFresh } from '../services/skill-loader.js';

beforeAll(() => loadSkills());

afterEach(() => {
  mockComplete.mockReset();
  mockAnalyzeLead.mockReset();
  mockAnalyzeLead.mockResolvedValue(null);
  mockSendBridgeReply.mockReset();
  mockSendBridgeReply.mockResolvedValue({ ok: true, message: 'sent' });
  mockCreatePreference.mockReset();
  mockCreatePreference.mockResolvedValue({
    paymentUrl: 'https://www.mercadopago.com/checkout/v1/redirect?pref_id=pref-1',
    preferenceId: 'pref-1',
  });
});

function llmResult(reply = 'Perfecto, revisemos el siguiente paso.'): LlmResult {
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

function withLimitedAvailability(dates: Array<{ date: string; status: 'available' | 'limited'; slotsApprox?: number }>): () => void {
  const experience = getActiveExperience(getSkills());
  const original = experience.availability;
  experience.availability = {
    ...original,
    availableDates: dates.map(d => ({ date: d.date, status: d.status, slotsApprox: d.slotsApprox ?? 2 })),
    botRule: 'Availability is authoritative for this test.',
  };
  return () => {
    experience.availability = original;
  };
}

describe('reservation closing regression', () => {

  it('does not hand off or raise score for negated reservation intent', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234560';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan', collected_plan: '2d1n_mining', collected_people: 2,
      collected_date: 'sábado 14 de noviembre', collected_transport_need: 'own',
      price_given_at: new Date().toISOString(), lead_score: 40,
    });
    mockComplete.mockResolvedValueOnce(llmResult('Entiendo, no avanzamos con la reserva.'));

    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'No quiero reservar' });
      expect(result.leadScore).toBe(40);
      expect(result.shouldAlertOwner).toBe(false);
      expect(repos.conversation.getMode(phone)).toBe('bot');
    } finally {
      db.close();
    }
  });

  it('does not hand off or set ready intent for negated availability confirmation', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234564';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan', collected_plan: '2d1n_mining', collected_people: 2,
      collected_date: 'sábado 14 de noviembre', collected_transport_need: 'own',
      price_given_at: new Date().toISOString(), lead_score: 40,
    });
    mockComplete.mockResolvedValueOnce(llmResult('Entiendo, no validamos disponibilidad.'));

    try {
      const result = await processMessage({
        repos,
        customerPhone: phone,
        message: 'No quiero confirmar disponibilidad',
      });
      expect(result.shouldAlertOwner).toBe(false);
      expect(repos.conversation.getMode(phone)).toBe('bot');
      expect(repos.conversation.getByPhone(phone)?.lead_intent).not.toBe('ready_to_book');
    } finally {
      db.close();
    }
  });

  it('does not hand off for conjugated negated availability confirmation', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234565';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan', collected_plan: '2d1n_mining', collected_people: 2,
      collected_date: 'sábado 14 de noviembre', collected_transport_need: 'own',
      price_given_at: new Date().toISOString(), lead_score: 40,
    });
    mockComplete.mockResolvedValueOnce(llmResult('Entiendo, no revisamos disponibilidad.'));

    try {
      await processMessage({ repos, customerPhone: phone, message: 'No confirmemos disponibilidad' });
      expect(repos.conversation.getMode(phone)).toBe('bot');
      expect(repos.conversation.getByPhone(phone)?.lead_intent).not.toBe('ready_to_book');
    } finally {
      db.close();
    }
  });

  it('does not hand off when the customer does not want availability validation', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234566';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan', collected_plan: '2d1n_mining', collected_people: 2,
      collected_date: 'sábado 14 de noviembre', collected_transport_need: 'own',
      price_given_at: new Date().toISOString(), lead_score: 40,
    });
    mockComplete.mockResolvedValueOnce(llmResult('Entiendo, no validamos disponibilidad.'));

    try {
      await processMessage({ repos, customerPhone: phone, message: 'No quiero validar disponibilidad' });
      expect(repos.conversation.getMode(phone)).toBe('bot');
      expect(repos.conversation.getByPhone(phone)?.lead_intent).not.toBe('ready_to_book');
    } finally {
      db.close();
    }
  });

  it('honors a later explicit reservation request after declining availability validation', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234567';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan', collected_plan: '2d1n_mining', collected_people: 2,
      collected_date: 'sábado 14 de noviembre', collected_transport_need: 'own',
      price_given_at: new Date().toISOString(), lead_score: 40,
    });
    mockComplete.mockResolvedValueOnce(llmResult('Perfecto, revisamos el siguiente paso.'));

    try {
      await processMessage({
        repos,
        customerPhone: phone,
        message: 'No quiero validar disponibilidad, quiero reservar ya',
      });
      expect(repos.conversation.getMode(phone)).toBe('human_pending');
      expect(repos.conversation.getByPhone(phone)?.lead_intent).toBe('ready_to_book');
    } finally {
      db.close();
    }
  });

  it('does not let stale reservation intent override a current rejection', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234561';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan', collected_plan: '2d1n_mining', collected_people: 2,
      collected_date: 'sábado 14 de noviembre', collected_transport_need: 'own',
      price_given_at: new Date().toISOString(), lead_score: 40,
    });
    repos.message.addMessage({
      customer_phone: phone, direction: 'inbound', message_type: 'text',
      body: 'Quiero reservar', created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    mockComplete.mockResolvedValueOnce(llmResult('Entiendo que el presupuesto no les encaja.'));

    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'No gracias, está muy caro' });
      expect(result.shouldAlertOwner).toBe(false);
      expect(result.leadScore).toBeLessThan(40);
      expect(repos.conversation.getLeadScore(phone)).toBe(result.leadScore);
      expect(repos.conversation.getMode(phone)).toBe('bot');
    } finally {
      db.close();
    }
  });

  it('persists urgent score when the reply LLM fails on explicit reservation intent', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234562';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan', collected_plan: '2d1n_mining', collected_people: 2,
      collected_date: 'sábado 14 de noviembre', collected_transport_need: 'own',
      price_given_at: new Date().toISOString(), lead_score: 40,
    });
    mockComplete.mockResolvedValueOnce(null);

    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Quiero reservar ya' });
      expect(result.leadScore).toBeGreaterThanOrEqual(95);
      expect(result.ownerAlertType).toBe('reservation_handoff');
      expect(repos.conversation.getLeadScore(phone)).toBeGreaterThanOrEqual(95);
      expect(repos.conversation.getMode(phone)).toBe('human_pending');
    } finally {
      db.close();
    }
  });

  it('does not let plain reply metadata overwrite analyzer-owned ready intent', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234563';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan', collected_plan: '2d1n_mining', collected_people: 2,
      collected_date: 'sábado 14 de noviembre', collected_transport_need: 'own',
      price_given_at: new Date().toISOString(), lead_score: 95, lead_intent: 'ready_to_book',
    });
    repos.conversation.setMode(phone, 'human_pending');
    mockComplete.mockResolvedValueOnce(llmResult('Claro, te explico el itinerario.'));

    try {
      await processMessage({ repos, customerPhone: phone, message: 'Como es el itinerario?' });
      expect(repos.conversation.getByPhone(phone)?.lead_intent).toBe('ready_to_book');
      expect(repos.conversation.getLeadScore(phone)).toBe(95);
    } finally {
      db.close();
    }
  });


  it('selects only the day offered by assistant when another month shares the same day', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234569';
    const restore = withLimitedAvailability([
      { date: '2026-11-14', status: 'limited' },
      { date: '2026-12-14', status: 'available' },
    ]);
    repos.conversation.upsert(phone, {
      collected_name: 'Juan',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'outbound',
      message_type: 'text',
      body: 'En noviembre tenemos disponible el sábado 14. ¿Les sirve ese fin de semana?',
      created_at: new Date().toISOString(),
    });
    mockComplete.mockResolvedValueOnce(llmResult());

    try {
      await processMessage({ repos, customerPhone: phone, message: 'Sí, 14 estaría perfecto.' });
      expect(repos.conversation.getByPhone(phone)?.collected_date).toMatch(/noviembre/i);
      expect(repos.conversation.getByPhone(phone)?.collected_date).not.toMatch(/diciembre/i);
    } finally {
      restore();
      db.close();
    }
  });

  it('does not fire reservation-close CTA for month-only dates', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234570';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'noviembre',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });
    mockComplete.mockResolvedValueOnce(llmResult('Claro Juan, el plan en moto queda muy bien para noviembre.'));

    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Vamos en moto.' });
      expect(result.reply).not.toMatch(/quieres que inicie esa validacion|quieres que la inicie ahora/i);
      expect(result.reply).not.toMatch(/anticipo del 15%/i);
      expect(repos.conversation.getMode(phone)).toBe('bot');
    } finally {
      db.close();
    }
  });


  it('answers a direct logistics question before offering reservation closing', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234575';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'sábado 14 de noviembre',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });
    mockComplete.mockResolvedValueOnce(llmResult('La ruta principal llega por Chivor y el equipo confirma el estado de la vía.'));

    try {
      const result = await processMessage({ repos, customerPhone: phone, message: '¿Cómo llego?' });
      expect(result.reply).toMatch(/ruta principal/i);
      expect(result.reply).not.toMatch(/quieres que (?:inicie|la inicie).*validaci[oó]n/i);
    } finally {
      db.close();
    }
  });

  it('does not override an unlisted punctuated question with reservation closing', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234577';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'sábado 14 de noviembre',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });
    mockComplete.mockResolvedValueOnce(llmResult('Sí, te explico ese detalle antes de avanzar.'));

    try {
      const result = await processMessage({ repos, customerPhone: phone, message: '¿Hay baños?' });
      expect(result.reply).toMatch(/explico ese detalle/i);
      expect(result.reply).not.toMatch(/quieres que (?:inicie|la inicie).*validaci[oó]n/i);
    } finally {
      db.close();
    }
  });

  it('does not apply limited urgency from the same day and month in another year', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234578';
    const restore = withLimitedAvailability([{ date: '2026-11-14', status: 'limited' }]);
    repos.conversation.upsert(phone, {
      collected_name: 'Juan',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: '14 de noviembre de 2027',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });
    mockComplete.mockResolvedValueOnce(llmResult());

    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Listo' });
      expect(result.reply).not.toMatch(/cupo limitado/i);
    } finally {
      restore();
      db.close();
    }
  });


  it('payment fails closed when price was given but plan column is empty', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234573';
    const experience = getActiveExperience(getSkills());
    const originalPricing = experience.pricing;
    experience.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing'],
      businessRules: [],
    };
    const prevToken = env.MERCADOPAGO_ACCESS_TOKEN;
    const prevSecret = env.MERCADOPAGO_WEBHOOK_SECRET;
    env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
    env.MERCADOPAGO_WEBHOOK_SECRET = 'test-secret';
    repos.conversation.upsert(phone, {
      collected_people: 2,
      collected_date: 'sábado 26 de septiembre',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
      // intentionally no collected_plan — mirrors production bug
    });

    try {
      const msg = await paymentHandler({ repos, args: [phone, 'confirm'], chatId: 1 });
      expect(msg).toMatch(/Faltan plan/i);
      expect(repos.conversation.getByPhone(phone)?.collected_plan).toBeNull();
      expect(mockCreatePreference).not.toHaveBeenCalled();
      expect(mockSendBridgeReply).not.toHaveBeenCalled();
    } finally {
      experience.pricing = originalPricing;
      env.MERCADOPAGO_ACCESS_TOKEN = prevToken;
      env.MERCADOPAGO_WEBHOOK_SECRET = prevSecret;
      db.close();
    }
  });

  it('payment fails closed when requested transport has no authorized price', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234580';
    const experience = getActiveExperience(getSkills());
    const originalPricing = experience.pricing;
    const previousToken = env.MERCADOPAGO_ACCESS_TOKEN;
    const previousSecret = env.MERCADOPAGO_WEBHOOK_SECRET;
    env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
    env.MERCADOPAGO_WEBHOOK_SECRET = 'test-secret';
    experience.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, publiclyShow: true },
      ],
      botRules: ['pricing'],
      businessRules: [],
    };
    repos.conversation.upsert(phone, {
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'sábado 14 de noviembre',
      collected_transport_need: 'yes',
    });

    try {
      const message = await paymentHandler({ repos, args: [phone, 'confirm'], chatId: 1 });
      expect(message).toMatch(/No pude calcular un anticipo autorizado/i);
      expect(mockCreatePreference).not.toHaveBeenCalled();
    } finally {
      experience.pricing = originalPricing;
      env.MERCADOPAGO_ACCESS_TOKEN = previousToken;
      env.MERCADOPAGO_WEBHOOK_SECRET = previousSecret;
      db.close();
    }
  });

  it('payment fails closed when the catalog has no active experience', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234581';
    const skills = getSkills();
    const originalExperiences = skills.andeanScapes.experiences;
    const previousToken = env.MERCADOPAGO_ACCESS_TOKEN;
    const previousSecret = env.MERCADOPAGO_WEBHOOK_SECRET;
    env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
    env.MERCADOPAGO_WEBHOOK_SECRET = 'test-secret';
    skills.andeanScapes.experiences = [];
    repos.conversation.upsert(phone, {
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'sábado 14 de noviembre',
      collected_transport_need: 'own',
    });

    try {
      const message = await paymentHandler({ repos, args: [phone, 'confirm'], chatId: 1 });
      expect(message).toMatch(/No hay una experiencia activa/i);
      expect(mockCreatePreference).not.toHaveBeenCalled();
    } finally {
      skills.andeanScapes.experiences = originalExperiences;
      env.MERCADOPAGO_ACCESS_TOKEN = previousToken;
      env.MERCADOPAGO_WEBHOOK_SECRET = previousSecret;
      db.close();
    }
  });

  it('payment link uses conversation language', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234571';
    const experience = getActiveExperience(getSkills());
    const originalPricing = experience.pricing;
    experience.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing'],
      businessRules: [],
    };
    const prevToken = env.MERCADOPAGO_ACCESS_TOKEN;
    const prevSecret = env.MERCADOPAGO_WEBHOOK_SECRET;
    env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
    env.MERCADOPAGO_WEBHOOK_SECRET = 'test-secret';
    repos.conversation.upsert(phone, {
      language: 'en',
      collected_name: 'John',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'November 14',
      collected_transport_need: 'own',
    });

    // isDynamicDataFresh requires no service or lastFetchOk — default null service is fresh.
    expect(isDynamicDataFresh()).toBe(true);

    try {
      const msg = await paymentHandler({
        repos,
        args: [phone, 'confirm'],
        chatId: 1,
      });
      expect(msg).toMatch(/Enlace de pago enviado|payment/i);
      expect(mockSendBridgeReply).toHaveBeenCalled();
      const sentBody = String(mockSendBridgeReply.mock.calls[0]?.[2] ?? '');
      expect(sentBody).toMatch(/secure link|deposit/i);
      expect(sentBody).not.toMatch(/enlace seguro/i);
    } finally {
      experience.pricing = originalPricing;
      env.MERCADOPAGO_ACCESS_TOKEN = prevToken;
      env.MERCADOPAGO_WEBHOOK_SECRET = prevSecret;
      db.close();
    }
  });

  it('requires explicit owner availability confirmation before creating payment', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234576';
    repos.conversation.upsert(phone, {
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'sábado 14 de noviembre',
      collected_transport_need: 'own',
    });

    try {
      const msg = await paymentHandler({ repos, args: [phone], chatId: 1 });
      expect(msg).toMatch(/<telefono> confirm/i);
      expect(mockCreatePreference).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('resends the existing pending payment URL instead of creating another charge', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234579';
    const previousToken = env.MERCADOPAGO_ACCESS_TOKEN;
    const previousSecret = env.MERCADOPAGO_WEBHOOK_SECRET;
    env.MERCADOPAGO_ACCESS_TOKEN = 'test-token';
    env.MERCADOPAGO_WEBHOOK_SECRET = 'test-secret';
    repos.conversation.upsert(phone, { language: 'es' });
    repos.paymentReservation.createPending({
      externalReference: 'as_existing',
      customerPhone: phone,
      expectedAmountCop: 150000,
      planId: '2d1n_mining',
      date: 'sábado 14 de noviembre',
      people: 2,
      transportNeed: 'own',
      depositPercent: 15,
      availabilityConfirmedAt: new Date().toISOString(),
    });
    repos.paymentReservation.attachPreference(
      'as_existing',
      'pref-existing',
      'https://www.mercadopago.com.co/checkout/v1/redirect?pref_id=pref-existing',
    );

    try {
      const msg = await paymentHandler({ repos, args: [phone, 'confirm'], chatId: 1 });
      expect(msg).toMatch(/reenviado/i);
      expect(mockCreatePreference).not.toHaveBeenCalled();
      expect(String(mockSendBridgeReply.mock.calls[0]?.[2])).toContain('pref-existing');
    } finally {
      env.MERCADOPAGO_ACCESS_TOKEN = previousToken;
      env.MERCADOPAGO_WEBHOOK_SECRET = previousSecret;
      db.close();
    }
  });

  // Live transcript (2026-08-11): the customer said "Si" to the whatsapp-sales
  // T3b close CTA ("primero valido disponibilidad ... ¿la iniciamos?") and no
  // bridge notification fired. Root cause: the CTA's first-person-plural wording
  // was not in the deterministic reservation-question pattern list, and the
  // handoff gate required full qualification (name + transport) even after an
  // explicit "yes". Both are fixed in response-engine.ts / reply-guard.ts.
  describe('explicit consent to the "¿la iniciamos?" close CTA (skills v3)', () => {
    function persistOutbound(repos: Repositories, phone: string, body: string): void {
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'outbound',
        message_type: 'text',
        body,
        created_at: new Date().toISOString(),
      });
    }

    it('replays the live transcript end to end: group -> plan -> price -> date -> explicit "Si" hands off', async () => {
      const db = new Database(':memory:');
      migrate(db);
      const repos = createRepositories(db);
      const phone = '573001234580';
      const restore = withLimitedAvailability([{ date: '2026-11-14', status: 'limited' }]);

      try {
        mockComplete.mockResolvedValueOnce(llmResult('¡Hola! 😊 ¿Vienen en pareja, solos o en grupo? Así te recomiendo mejor.'));
        const t1 = await processMessage({ repos, customerPhone: phone, message: 'Hola' });
        persistOutbound(repos, phone, t1.reply);
        expect(t1.shouldAlertOwner).toBe(false);

        mockComplete.mockResolvedValueOnce(llmResult(
          '¡Perfecto, para dos entonces! ¿Qué les llama más la atención: la aventura intensa de un día en la mina, o algo más completo con la vida rural incluida?',
        ));
        const t2 = await processMessage({ repos, customerPhone: phone, message: 'Sería en pareja' });
        persistOutbound(repos, phone, t2.reply);
        expect(repos.conversation.getByPhone(phone)?.collected_people).toBe(2);

        mockComplete.mockResolvedValueOnce(llmResult(
          'Entiendo, la aventura intensa de la mina es la mejor opción. Es un plan corto y directo. ¿Alguna fecha en mente?',
        ));
        const t3 = await processMessage({ repos, customerPhone: phone, message: 'El intenso de la mina' });
        persistOutbound(repos, phone, t3.reply);
        expect(repos.conversation.getByPhone(phone)?.collected_plan).toBe('2d1n_mining');

        mockComplete.mockResolvedValueOnce(llmResult(
          'Para pareja, el plan completo de 2 días/1 noche en la mina queda en $1.000.000 COP. Eso incluye alojamiento, las 3 comidas, la experiencia minera con equipo y la charla esmeraldera.\n\n¿Les gustaría que revise alguna fecha en particular?',
        ));
        const t4 = await processMessage({ repos, customerPhone: phone, message: 'No todavia que vale para pareja ?' });
        persistOutbound(repos, phone, t4.reply);
        expect(repos.conversation.getByPhone(phone)?.price_given_at).not.toBeNull();

        mockComplete.mockResolvedValueOnce(llmResult(
          'Para noviembre tenemos el *14 de noviembre* publicado. Es una fecha con cupo limitado, así que el equipo la valida apenas confirmen.\n\n¿Les sirve esa fecha o prefieren que revise otra?',
        ));
        const t5 = await processMessage({ repos, customerPhone: phone, message: 'Depronto para noviembre que fechas tienen ?' });
        persistOutbound(repos, phone, t5.reply);

        mockComplete.mockResolvedValueOnce(llmResult(
          '¡Perfecto! Entonces sería el plan de 2 días/1 noche para el *sábado 14 de noviembre*, para 2 personas.\n\nPara confirmar, el anticipo es del *15%* por Nequi o Mercado Pago. Primero valido disponibilidad con el equipo y en cuanto confirmen te comparto el detalle del pago.\n\n¿La iniciamos?',
        ));
        const t6 = await processMessage({ repos, customerPhone: phone, message: 'Si esa suena bien para mi' });
        persistOutbound(repos, phone, t6.reply);
        // Accepting the offered date is not, by itself, consent to start the
        // reservation — the CTA hasn't been asked yet on this turn.
        expect(repos.conversation.getByPhone(phone)?.collected_date).toMatch(/noviembre/i);
        expect(t6.shouldAlertOwner).toBe(false);

        mockAnalyzeLead.mockResolvedValueOnce({
          intent: 'ready_to_book', scoreDelta: 25, confidence: 0.9,
          buyingSignals: ['confirma iniciar validacion'], blockers: [],
          afterPriceInterest: true, reservationReadiness: 'strong',
          rationale: 'cliente confirma iniciar la reserva', promptTokens: 40, completionTokens: 20,
        });
        mockComplete.mockResolvedValueOnce(llmResult(
          '¡Listo! Quedo validando la disponibilidad para el *14 de noviembre* con el equipo. En cuanto confirmen, te comparto el detalle del anticipo para que puedan apartar.\n\nCualquier cosa me escribes por acá. ¡Gracias por confiar en nosotros! 🙌',
        ));
        const t7 = await processMessage({ repos, customerPhone: phone, message: 'Si' });

        expect(t7.shouldAlertOwner).toBe(true);
        expect(t7.ownerAlertType).toBe('reservation_handoff');
        expect(t7.leadScore).toBeGreaterThanOrEqual(95);
        expect(repos.conversation.getMode(phone)).toBe('human_pending');
        expect(repos.conversation.getLeadScore(phone)).toBeGreaterThanOrEqual(95);
      } finally {
        restore();
        db.close();
      }
    });

    it('hands off on explicit "Si" even when the analyzer is conservative about a one-word reply', async () => {
      const db = new Database(':memory:');
      migrate(db);
      const repos = createRepositories(db);
      const phone = '573001234581';
      repos.conversation.upsert(phone, {
        collected_plan: '2d1n_mining', collected_people: 2,
        collected_date: 'sábado 14 de noviembre',
        price_given_at: new Date().toISOString(), lead_score: 40,
        // No name, no transport — collected later by the human agent, not a
        // reason to withhold the handoff once the customer has said yes.
      });
      persistOutbound(
        repos, phone,
        'El anticipo es del 15% por Nequi o Mercado Pago. Primero valido disponibilidad con el equipo. ¿La iniciamos?',
      );
      // A bare "Si" is genuinely ambiguous out of context, so the analyzer stays
      // conservative here — the deterministic explicit-consent gate must still fire.
      mockAnalyzeLead.mockResolvedValueOnce({
        intent: 'curious', scoreDelta: 0, confidence: 0.3,
        buyingSignals: [], blockers: [],
        afterPriceInterest: false, reservationReadiness: 'none',
        rationale: 'si ambiguo sin mas contexto', promptTokens: 10, completionTokens: 10,
      });
      mockComplete.mockResolvedValueOnce(llmResult('Quedo validando la disponibilidad con el equipo. ¿Cómo te llamas?'));

      try {
        const result = await processMessage({ repos, customerPhone: phone, message: 'Si' });
        expect(result.shouldAlertOwner).toBe(true);
        expect(result.ownerAlertType).toBe('reservation_handoff');
        expect(result.leadScore).toBeGreaterThanOrEqual(95);
        expect(repos.conversation.getMode(phone)).toBe('human_pending');
        expect(mockComplete.mock.calls[0]?.[0].systemPrompt).toContain('ESTADO DE TURNO: POST-CTA');
        expect(mockComplete.mock.calls[0]?.[0].systemPrompt).toContain('DATO OPERATIVO FALTANTE: nombre');
        expect(mockComplete.mock.calls[0]?.[0].systemPrompt).not.toContain('ESTADO DE TURNO: T3b');
      } finally {
        db.close();
      }
    });

    it('hands off when the bot proposed the plan and customer accepts the close CTA', async () => {
      const db = new Database(':memory:');
      migrate(db);
      const repos = createRepositories(db);
      const phone = '573001234585';
      repos.conversation.upsert(phone, {
        collected_people: 2,
        collected_date: '31 de agosto',
        collected_transport_need: 'own',
        price_given_at: new Date().toISOString(),
        lead_score: 40,
      });
      persistOutbound(
        repos, phone,
        'El plan de 2 días / 1 noche para ustedes queda en $1.000.000. Anticipo 15% por Nequi o Mercado Pago. Primero valido disponibilidad con el equipo. ¿La iniciamos?',
      );
      mockAnalyzeLead.mockResolvedValueOnce({
        intent: 'curious', scoreDelta: 0, confidence: 0.3,
        buyingSignals: [], blockers: [],
        afterPriceInterest: false, reservationReadiness: 'none',
        rationale: 'confirmacion de CTA con plan propuesto por el bot', promptTokens: 10, completionTokens: 10,
      });
      mockComplete.mockResolvedValueOnce(llmResult('Listo, quedo validando la disponibilidad con el equipo.'));

      try {
        const result = await processMessage({ repos, customerPhone: phone, message: 'Si' });
        expect(result.shouldAlertOwner).toBe(true);
        expect(result.ownerAlertType).toBe('reservation_handoff');
        expect(result.leadScore).toBeGreaterThanOrEqual(95);
        expect(repos.conversation.getMode(phone)).toBe('human_pending');
      } finally {
        db.close();
      }
    });

    // Live C03 transcript (2026-08-12): the customer never stated the group size
    // — the bot inferred "para dos personas" and quoted it. Neither plan nor
    // people ever landed in the DB, so the close gate must not depend on them
    // once the customer accepts the hard CTA after price + a confirmed date.
    it('replays the C03 transcript: bot-inferred group size still hands off on "Si"', async () => {
      const db = new Database(':memory:');
      migrate(db);
      const repos = createRepositories(db);
      const phone = '573001234586';
      const restore = withLimitedAvailability([{ date: '2026-11-14', status: 'limited' }]);

      try {
        mockComplete.mockResolvedValueOnce(llmResult(
          '¡Hola! 😊 La ruta por Ubalá es pura aventura en moto.\n\n¿Vienen en moto para esa ruta, o prefieren llegar por Chivor?',
        ));
        const t1 = await processMessage({ repos, customerPhone: phone, message: 'C03 hola' });
        persistOutbound(repos, phone, t1.reply);

        mockComplete.mockResolvedValueOnce(llmResult(
          '¡Perfecto! Entonces la ruta por Ubalá es justo para ustedes.\n\nEl plan 2D/1N les calza ideal. ¿Qué fecha les llama la atención?',
        ));
        const t2 = await processMessage({ repos, customerPhone: phone, message: 'Si tenemos moto' });
        persistOutbound(repos, phone, t2.reply);

        mockComplete.mockResolvedValueOnce(llmResult(
          'Claro, te cuento. El plan 2D/1N de la mina es todo incluido.\n\nPara dos personas, el total es $1.000.000 COP. ¿Les suena bien para esa fecha?',
        ));
        const t3 = await processMessage({ repos, customerPhone: phone, message: 'No sabemos todavia que vale el plan ?' });
        persistOutbound(repos, phone, t3.reply);
        expect(repos.conversation.getByPhone(phone)?.price_given_at).not.toBeNull();
        // The bot said "dos personas"; the customer never did. Nothing to store.
        expect(repos.conversation.getByPhone(phone)?.collected_people).toBeNull();

        mockComplete.mockResolvedValueOnce(llmResult(
          '¡Buenísimo! Las fechas publicadas para ese mes son el 14 de noviembre.\n\n¿Les sirve esa fecha, o prefieren que revise otra opción?',
        ));
        const t4 = await processMessage({ repos, customerPhone: phone, message: 'Nos gustaría en noviembre' });
        persistOutbound(repos, phone, t4.reply);

        mockComplete.mockResolvedValueOnce(llmResult(
          'Perfecto, el 14 de noviembre entonces. Para confirmar, el anticipo es del 15% por Nequi o Mercado Pago.\n\nPrimero valido disponibilidad con el equipo. ¿La iniciamos?',
        ));
        const t5 = await processMessage({ repos, customerPhone: phone, message: 'Si 14 suena bien' });
        persistOutbound(repos, phone, t5.reply);
        expect(repos.conversation.getByPhone(phone)?.collected_date).toMatch(/noviembre/i);

        mockAnalyzeLead.mockResolvedValueOnce({
          intent: 'curious', scoreDelta: 0, confidence: 0.3,
          buyingSignals: [], blockers: [],
          afterPriceInterest: false, reservationReadiness: 'none',
          rationale: 'si corto tras CTA', promptTokens: 10, completionTokens: 10,
        });
        mockComplete.mockResolvedValueOnce(llmResult('Listo, quedo validando esa fecha con el equipo.'));
        const t6 = await processMessage({ repos, customerPhone: phone, message: 'Si' });

        expect(t6.shouldAlertOwner).toBe(true);
        expect(t6.ownerAlertType).toBe('reservation_handoff');
        expect(repos.conversation.getMode(phone)).toBe('human_pending');
      } finally {
        restore();
        db.close();
      }
    });

    it('does not hand off on explicit "Si" when the bot never quoted a price', async () => {
      const db = new Database(':memory:');
      migrate(db);
      const repos = createRepositories(db);
      const phone = '573001234587';
      repos.conversation.upsert(phone, {
        collected_people: 2,
        collected_date: 'sábado 14 de noviembre',
        collected_transport_need: 'own',
        lead_score: 40,
      });
      persistOutbound(
        repos, phone,
        'Perfecto, el 14 de noviembre entonces. Para confirmar, el anticipo es del 15% y los métodos de pago son Nequi o Mercado Pago. Primero valido disponibilidad con el equipo. ¿La iniciamos?',
      );
      expect(repos.conversation.getPriceGivenAt(phone)).toBeNull();
      mockAnalyzeLead.mockResolvedValueOnce({
        intent: 'curious', scoreDelta: 0, confidence: 0.3,
        buyingSignals: [], blockers: [],
        afterPriceInterest: false, reservationReadiness: 'none',
        rationale: 'si corto tras CTA sin cotizacion', promptTokens: 10, completionTokens: 10,
      });
      mockComplete.mockResolvedValueOnce(llmResult('Queda validando la fecha del 14 de noviembre con el equipo.'));

      try {
        const result = await processMessage({ repos, customerPhone: phone, message: 'Si' });
        expect(result.shouldAlertOwner).toBe(false);
        expect(repos.conversation.getMode(phone)).toBe('bot');
      } finally {
        db.close();
      }
    });

    it('does not hand off on close-CTA consent without a confirmed date', async () => {
      const db = new Database(':memory:');
      migrate(db);
      const repos = createRepositories(db);
      const phone = '573001234589';
      repos.conversation.upsert(phone, {
        collected_people: 2,
        price_given_at: new Date().toISOString(),
        lead_score: 40,
      });
      persistOutbound(
        repos, phone,
        'El anticipo es del 15% por Nequi o Mercado Pago. Primero valido disponibilidad con el equipo. ¿La iniciamos?',
      );
      mockAnalyzeLead.mockResolvedValueOnce({
        intent: 'curious', scoreDelta: 0, confidence: 0.3,
        buyingSignals: [], blockers: [],
        afterPriceInterest: false, reservationReadiness: 'none',
        rationale: 'confirmacion sin fecha concreta', promptTokens: 10, completionTokens: 10,
      });
      mockComplete.mockResolvedValueOnce(llmResult('Antes de iniciar, ¿qué fecha tienen en mente?'));

      try {
        const result = await processMessage({ repos, customerPhone: phone, message: 'Si' });
        expect(result.shouldAlertOwner).toBe(false);
        expect(repos.conversation.getMode(phone)).toBe('bot');
        expect(mockComplete.mock.calls[0]?.[0].systemPrompt).not.toContain('ESTADO DE TURNO: POST-CTA');
      } finally {
        db.close();
      }
    });

    it('does not hand off after an informational deposit statement', async () => {
      const db = new Database(':memory:');
      migrate(db);
      const repos = createRepositories(db);
      const phone = '573001234588';
      repos.conversation.upsert(phone, { collected_people: 2, lead_score: 40 });
      persistOutbound(repos, phone, 'La reserva se separa con anticipo. ¿Te queda claro?');
      mockAnalyzeLead.mockResolvedValueOnce({
        intent: 'curious', scoreDelta: 0, confidence: 0.3,
        buyingSignals: [], blockers: [],
        afterPriceInterest: false, reservationReadiness: 'none',
        rationale: 'confirmacion informativa', promptTokens: 10, completionTokens: 10,
      });
      mockComplete.mockResolvedValueOnce(llmResult('Perfecto. ¿Qué fecha tienen en mente?'));

      try {
        const result = await processMessage({ repos, customerPhone: phone, message: 'Ok' });
        expect(result.shouldAlertOwner).toBe(false);
        expect(repos.conversation.getMode(phone)).toBe('bot');
      } finally {
        db.close();
      }
    });

    it('hands off on explicit "Si" when the analyzer is unavailable', async () => {
      const db = new Database(':memory:');
      migrate(db);
      const repos = createRepositories(db);
      const phone = '573001234582';
      repos.conversation.upsert(phone, {
        collected_plan: '2d1n_mining', collected_people: 2,
        collected_date: 'sábado 14 de noviembre',
        price_given_at: new Date().toISOString(), lead_score: 40,
      });
      persistOutbound(
        repos, phone,
        'El anticipo es del 15% por Nequi o Mercado Pago. Primero valido disponibilidad con el equipo. ¿La iniciamos?',
      );
      mockAnalyzeLead.mockResolvedValueOnce(null); // analyzer down (timeout / budget / invalid JSON)
      mockComplete.mockResolvedValueOnce(llmResult('¡Listo! Quedo validando la disponibilidad con el equipo.'));

      try {
        const result = await processMessage({ repos, customerPhone: phone, message: 'Si' });
        expect(result.shouldAlertOwner).toBe(true);
        expect(result.ownerAlertType).toBe('reservation_handoff');
        expect(repos.conversation.getMode(phone)).toBe('human_pending');
      } finally {
        db.close();
      }
    });

    it('does not hand off when the customer declines the "¿la iniciamos?" close CTA', async () => {
      const db = new Database(':memory:');
      migrate(db);
      const repos = createRepositories(db);
      const phone = '573001234583';
      repos.conversation.upsert(phone, {
        collected_plan: '2d1n_mining', collected_people: 2,
        collected_date: 'sábado 14 de noviembre',
        price_given_at: new Date().toISOString(), lead_score: 40,
      });
      persistOutbound(
        repos, phone,
        'El anticipo es del 15% por Nequi o Mercado Pago. Primero valido disponibilidad con el equipo. ¿La iniciamos?',
      );
      mockComplete.mockResolvedValueOnce(llmResult('Entiendo, me quedo atento entonces.'));

      try {
        const result = await processMessage({ repos, customerPhone: phone, message: 'No' });
        expect(result.shouldAlertOwner).toBe(false);
        expect(result.leadScore).toBe(40);
        expect(repos.conversation.getMode(phone)).toBe('bot');
      } finally {
        db.close();
      }
    });

    it('does not hand off on soft "Si" after "¿te suena?" without name/transport', async () => {
      const db = new Database(':memory:');
      migrate(db);
      const repos = createRepositories(db);
      const phone = '573001234584';
      repos.conversation.upsert(phone, {
        collected_plan: '2d1n_mining', collected_people: 2,
        collected_date: 'sábado 14 de noviembre',
        price_given_at: new Date().toISOString(), lead_score: 40,
      });
      persistOutbound(
        repos, phone,
        'Para pareja el plan completo queda en $1.000.000 COP. ¿Te suena?',
      );
      mockAnalyzeLead.mockResolvedValueOnce({
        intent: 'curious', scoreDelta: 0, confidence: 0.4,
        buyingSignals: [], blockers: [],
        afterPriceInterest: true, reservationReadiness: 'none',
        rationale: 'interes suave sin close cta', promptTokens: 10, completionTokens: 10,
      });
      mockComplete.mockResolvedValueOnce(llmResult('¡Genial! ¿Cómo te llamas para anotarte?'));

      try {
        const result = await processMessage({ repos, customerPhone: phone, message: 'Si' });
        expect(result.shouldAlertOwner).toBe(false);
        expect(repos.conversation.getMode(phone)).toBe('bot');
      } finally {
        db.close();
      }
    });
  });
});
