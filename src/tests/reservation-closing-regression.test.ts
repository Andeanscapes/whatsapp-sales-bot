import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
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
  it('turns a selected authoritative limited date into a reservation-validation CTA', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234567';
    const restore = withLimitedAvailability([{ date: '2026-11-14', status: 'limited' }]);
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
      const result = await processMessage({ repos, customerPhone: phone, message: 'Sí, 14 estaría perfecto.' });

      expect(repos.conversation.getByPhone(phone)?.collected_date).toMatch(/14 de noviembre/i);
      expect(result.reply).toMatch(/14 de noviembre/i);
      expect(result.reply).toMatch(/cupo limitado/i);
      expect(result.reply).toMatch(/anticipo del 15%/i);
      expect(result.reply).toMatch(/quieres que la inicie ahora/i);
      expect(result.shouldAlertOwner).toBe(false);
      expect(repos.conversation.getMode(phone)).toBe('bot');
    } finally {
      restore();
      db.close();
    }
  });

  it('limited close CTA is closing_offered then sí enters human_pending', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234568';
    const restore = withLimitedAvailability([{ date: '2026-11-14', status: 'limited' }]);
    const skills = getSkills();
    repos.conversation.upsert(phone, {
      collected_name: 'Juan',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'sábado 14 de noviembre',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
      lead_score: 80,
    });
    const closing = skills.fallbackReplies.es.reservationClosingLimited
      .replaceAll('{{name}}', 'Juan')
      .replaceAll('{{summary}}', '2 personas, sábado 14 de noviembre, con carro propio')
      .replaceAll('{{date}}', 'sábado 14 de noviembre')
      .replaceAll('{{deposit}}', '15');
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'outbound',
      message_type: 'text',
      body: closing,
      created_at: new Date().toISOString(),
    });
    mockComplete.mockResolvedValueOnce(llmResult('Dale Juan.'));

    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Sí' });
      expect(result.reply).toMatch(/estoy validando|validando disponibilidad/i);
      expect(result.reply).not.toMatch(/quieres que la inicie ahora/i);
      expect(result.shouldAlertOwner).toBe(true);
      expect(repos.conversation.getMode(phone)).toBe('human_pending');
    } finally {
      restore();
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

  it('returns authoritative dates when the customer explicitly requests options', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234574';
    const restore = withLimitedAvailability([{ date: '2026-11-14', status: 'available' }]);
    repos.conversation.upsert(phone, { collected_people: 2 });
    repos.conversation.setDateAsked(phone);
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'outbound',
      message_type: 'text',
      body: '¿Tienen alguna fecha tentativa o prefieren ver opciones?',
      created_at: new Date().toISOString(),
    });

    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Quiero ver las opciones disponibles.' });
      expect(result.reply).toMatch(/14 de noviembre/i);
      expect(result.reply).not.toMatch(/quieres que te muestre las próximas fechas/i);
    } finally {
      restore();
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

  it('quotes without inventing collected_plan when customer never selected a plan', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001234572';
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
    repos.conversation.upsert(phone, {
      collected_people: 2,
      collected_date: 'sábado 26 de septiembre',
      collected_transport_need: 'own',
    });
    mockComplete.mockResolvedValueOnce(llmResult('Te paso el valor.'));

    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'cuanto vale para 2?' });
      expect(result.reply).toContain('$1,000,000 COP');
      expect(repos.conversation.getByPhone(phone)?.collected_plan).toBeNull();
    } finally {
      experience.pricing = originalPricing;
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
});
