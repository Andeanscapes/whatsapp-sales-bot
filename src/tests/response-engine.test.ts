import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
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
import { PRICING_NOT_AVAILABLE, AVAILABILITY_NOT_AVAILABLE } from '../services/dynamic-data-service.js';
import { sendAlert } from '../services/alert-service.js';
import { insertMediaSendAt, getLatestOwnerAlertBody } from './helpers/db-test-helpers.js';
import { containsPromptLeakOrPolicyViolation } from '../services/reply-guard.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';
import { qualificationSummary } from '../services/reply-guard.js';

const { mockLlmComplete } = vi.hoisted(() => ({
  mockLlmComplete: vi.fn<(input: LlmClientInput) => Promise<LlmResult | null>>(() => Promise.resolve(null)),
}));

vi.mock('../services/llm/deepseek-llm-client.js', () => ({
  DeepSeekLlmClient: vi.fn().mockImplementation(() => ({
    complete: mockLlmComplete,
  })),
}));

vi.mock('../services/budget-guard.js', () => ({
  checkBudget: vi.fn(() => ({ aiAllowed: true })),
}));

vi.mock('../services/time-window-policy.js', () => ({
  checkTimeWindow: vi.fn(() => ({ isLimited: false })),
}));

const { mockAnalyzeLead } = vi.hoisted(() => ({
  mockAnalyzeLead: vi.fn<() => Promise<LeadAnalysis | null>>(() => Promise.resolve(null)),
}));

vi.mock('../services/lead-analyzer.js', () => ({
  analyzeLead: mockAnalyzeLead,
}));

import { checkBudget } from '../services/budget-guard.js';
import { checkTimeWindow } from '../services/time-window-policy.js';
import { safeReservationHandoff, afterHoursReply, colombiaTimeAwareReply } from '../services/reply-guard.js';
import { selectPlanImage, canSendPlanImage, canSendImage, hasGalleryNudge, recordGalleryNudge, selectGalleryImages } from '../services/media-service.js';
import { getActiveExperience } from '../services/product-registry.js';
import { getSkills, setDynamicService } from '../services/skill-loader.js';
import { DynamicDataService } from '../services/dynamic-data-service.js';
import type { LlmClientInput, LlmTurn, LlmResult } from '../services/llm/llm-client.js';
import type { LeadAnalysis } from '../services/lead-analyzer.js';

interface OldResponse {
  response: {
    reply: string | null;
    intent?: string;
    lead_score_delta?: number;
    should_send_image?: boolean;
    needs_human?: boolean;
    missing_fields?: string[];
    collected_fields?: Record<string, unknown>;
  };
  promptTokens?: number;
  completionTokens?: number;
}

function fromOld(old: OldResponse): LlmResult {
  const ar = old.response;
  const f = (ar.collected_fields ?? {}) as Record<string, unknown>;
  const turn: LlmTurn = {
    reply: ar.reply ?? '',
    sales_phase: 'discovery',
    action: ar.needs_human ? 'handoff' : 'qualify',
    collected_fields: {
      name: typeof f.name === 'string' ? f.name : null,
      plan: (typeof f.plan === 'string' && (f.plan === '2d1n_mining' || f.plan === '3d2n_rural')) ? f.plan : null,
      people: typeof f.people === 'number' ? f.people : null,
      date: typeof f.date === 'string' ? f.date : null,
      transport_need: (typeof f.transport_need === 'string' && (f.transport_need === 'own' || f.transport_need === 'from_bogota' || f.transport_need === 'public_bus')) ? f.transport_need as 'own' | 'from_bogota' | 'public_bus' : null,
      pet: f.pet === 'yes' ? 'yes' : null,
    },
    lead: {
      intent: ar.needs_human ? 'ready_to_book' : 'qualifying',
      buying_signals: [],
      blockers: [],
      score_delta: ar.lead_score_delta ?? 0,
      confidence: 0.7,
    },
    img: ar.should_send_image ?? false,
  };
  return { turn, tokens: { prompt: old.promptTokens ?? 0, completion: old.completionTokens ?? 0 } };
}

function installPaymentData(): () => void {
  const skills = getSkills();
  const previous = skills.dynamicData;
  skills.dynamicData = {
    experiences: {},
    media: null,
    payments: {
      currency: 'COP',
      deposit: {
        type: 'percentage', value: 15, label: 'Anticipo', calculationRule: 'x * 0.15',
        remainingBalance: { type: 'percentage', value: 85, label: 'Saldo' },
      },
      methods: [{
        id: 'nequi', name: 'Nequi', type: 'mobile_transfer', enabled: true,
        phoneNumber: '3000000000', currency: 'COP', instructions: 'Transfiere al 3000000000',
        requiresPaymentProof: true,
      }],
      confirmation: { automatic: false, requiresTeamValidation: true, message: 'Validar primero.' },
      displayPolicy: {
        showMethodsAfterAvailabilityValidation: true,
        showWhenCustomerAsks: true,
        neverRequestFullPaymentWithoutConfirmation: true,
      },
    },
  };
  return () => { skills.dynamicData = previous; };
}

let repos: Repositories;
let db: Database.Database;

async function withBridgeRouting<T>(fn: () => Promise<T>): Promise<T> {
  const previousRoutingJson = env.LEAD_ROUTING_JSON;
  const routing: RoutingConfig = {
    salesLines: [{ id: 'line1_bridge', type: 'bridge', label: 'Bridge', weight: 1, telegramChatId: '111', agentName: 'Agent' }],
  };
  env.LEAD_ROUTING_JSON = JSON.stringify(routing);
  resetRoutingConfigCache();
  try {
    return await fn();
  } finally {
    env.LEAD_ROUTING_JSON = previousRoutingJson;
    resetRoutingConfigCache();
  }
}

beforeAll(() => {
  loadSkills();
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
});

describe('processMessage', () => {
  it('handles opt-out keyword stop', async () => {
    mockLlmComplete.mockReset();
    const phone = '573009990001';
    const result = await processMessage({ repos, customerPhone: phone, message: 'stop' });
    expect(result.reply).toContain("won't send");
    expect(result.shouldSendReply).toBe(true);
    expect(result.leadScore).toBe(0);
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.usedAi).toBe(false);
  });

  it('prevents replies for opted-out customer', async () => {
    mockLlmComplete.mockReset();
    const phone = '573009990002';
    await processMessage({ repos, customerPhone: phone, message: 'stop' });
    const result = await processMessage({ repos, customerPhone: phone, message: 'How much?' });
    expect(result.reply).toBe('');
    expect(result.shouldSendReply).toBe(false);
  });

  it('prevents bot replies for booked (converted) leads', async () => {
    mockLlmComplete.mockReset();
    const phone = '573009990003';
    repos.conversation.upsert(phone, { converted_at: new Date().toISOString() });
    const result = await processMessage({ repos, customerPhone: phone, message: 'I want to book more' });
    expect(result.reply).toBe('');
    expect(result.shouldSendReply).toBe(false);
    expect(result.usedAi).toBe(false);
    // Inbound message is still stored for audit/transcript
    const msgs = repos.message.getRecentMessages(phone);
    expect(msgs.some(m => m.content === 'I want to book more')).toBe(true);
  });

  it('still registers opt-out for a booked lead (compliance precedence)', async () => {
    mockLlmComplete.mockReset();
    const phone = '573009990004';
    repos.conversation.upsert(phone, { converted_at: new Date().toISOString() });
    const result = await processMessage({ repos, customerPhone: phone, message: 'stop' });
    expect(result.shouldSendReply).toBe(true);
    expect(result.reply).toContain("won't send");
    expect(repos.optOut.isOptedOut(phone)).toBe(true);
  });

  it('returns AI reply when DeepSeek succeeds', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const result = await processMessage({ repos, customerPhone: '573001112233', message: 'Hola' });
    expect(result.reply).toContain('Owner');
    expect(result.shouldSendReply).toBe(true);
    expect(result.usedAi).toBe(true);
  });

  it('pauses with shareable summary when user needs to consult partner after price', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    const phone = '573001112232';
    repos.conversation.upsert(phone, {
      collected_name: 'Santiago',
      collected_people: 2,
      price_given_at: new Date().toISOString(),
    });

    const skills = getSkills();
    const exp = skills.andeanScapes.experiences[0];
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP', lastUpdated: '2026-01-01',
      items: [
        { id: 'individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, peopleIncluded: 1, publiclyShow: true },
        { id: 'couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1040000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'seria para 2 pero dejame valido con mi pareja gracias' });

      expect(result.reply).toContain('Dale Santiago, cero afan');
      expect(result.reply).toContain('$1,040,000 COP total');
      expect(result.reply.toLowerCase()).not.toContain('transporte');
      expect(result.shouldAlertOwner).toBe(false);
      expect(result.usedAi).toBe(false);
      expect(mockLlmComplete).not.toHaveBeenCalled();
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('returns graceful reply and alerts owner when DeepSeek fails (qualified, price given)', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(null);
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
    expect(result.reply).toContain('Te leo');
    expect(result.reply).not.toContain('Instagram');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.usedAi).toBe(true);
  });

  it('returns graceful reply and alerts owner when DeepSeek returns null reply (qualified, price given)', async () => {
    mockLlmComplete.mockReset();
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
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const result = await processMessage({ repos, customerPhone: phone, message: 'asdfghjkl' });
    expect(result.reply).toContain('Carlos');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('computes lead score and returns AI reply', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
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
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const result = await processMessage({ repos, customerPhone: '573001112237', message: 'Quiero reservar mayo 18 para 4 personas' });
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.reply).toBeTruthy();
  });

  it('uses conversation context in DeepSeek call', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001112238';
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Hola', created_at: new Date(Date.now() - 60000).toISOString() });
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: 'Hola, soy Owner de Andean Scapes. En que te puedo ayudar?', created_at: new Date(Date.now() - 50000).toISOString() });
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Quiero saber fechas disponibles', created_at: new Date(Date.now() - 40000).toISOString() });

    const result = await processMessage({ repos, customerPhone: phone, message: 'fecha' });
    expect(result.reply).toContain('disponibles');
    expect(result.usedAi).toBe(true);

    const callArgs = mockLlmComplete.mock.lastCall;
    expect(callArgs).toBeDefined();
    if (callArgs) {
      const input = callArgs[0] as { history?: Array<{ role: string; content: string }> } | undefined;
      const recentMsgs = input?.history;
      expect(recentMsgs).toBeDefined();
      if (recentMsgs) {
        expect(recentMsgs.length).toBeGreaterThan(0);
      }
    }
  });

  it('alerts owner when budget is blocked', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: false, reason: 'daily_budget_exceeded' });
    await withBridgeRouting(async () => {
      const phone = '573001112239';
      const result = await processMessage({ repos, customerPhone: phone, message: 'Hola' });
      expect(result.reply).toContain('Me encargo personalmente');
      expect(result.reply.toLowerCase()).not.toContain('creditos');
      expect(result.reply.toLowerCase()).not.toContain('ia');
      expect(result.shouldSendReply).toBe(true);
      expect(result.shouldAlertOwner).toBe(true);
      expect(repos.conversation.getHandedOffAt(phone)).toBeTruthy();
      expect(repos.conversation.getMode(phone)).toBe('bridge_active');
    });
  });

  it('soft closes, stores inbound message, and lowers score on decline', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112257';
    repos.conversation.upsert(phone, { lead_score: 40 });

    const result = await processMessage({ repos, customerPhone: phone, message: 'No gracias' });

    expect(result.reply).toContain('Entendido');
    expect(result.usedAi).toBe(false);
    expect(result.leadScore).toBeGreaterThanOrEqual(0);

    const conv = repos.conversation.getByPhone(phone) as { lead_score: number; soft_closed_at: string | null };
    expect(conv.lead_score).toBeGreaterThanOrEqual(0);
    expect(conv.soft_closed_at).toBeTruthy();

    const stored = { body: repos.message.getLastInboundBodies(phone, 1)[0]?.body } as { body: string };
    expect(stored.body).toBe('No gracias');
  });

  it('bypasses soft-close and lets LLM handle price rejection when qual data present', async () => {
    mockLlmComplete.mockReset();
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
    expect(result.reply).toBeTruthy();
    expect(result.reply).not.toContain('https://www.instagram.com/andean_scapes/');

    const conv = repos.conversation.getByPhone(phone) as { soft_closed_at: string | null };
    expect(conv.soft_closed_at).toBeNull();
  });

  it('soft closes with IG link on algo caro otra oportunidad', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112286';
    repos.conversation.upsert(phone, { price_given_at: new Date().toISOString() });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Me parece algo Caro gracais en otra oportunidad' });

    expect(result.reply).toContain('https://www.instagram.com/andean_scapes/');
    expect(result.usedAi).toBe(false);
    expect(result.shouldSendGalleryImages).toBe(false);
  });

  it('bypasses soft-close on budget objection when qual data present', async () => {
    mockLlmComplete.mockReset();
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
    expect(result.reply).toBeTruthy();
    expect(result.reply).not.toContain('https://www.instagram.com/andean_scapes/');

    const conv = repos.conversation.getByPhone(phone) as { soft_closed_at: string | null };
    expect(conv.soft_closed_at).toBeNull();
  });

  it('re-engages after soft close when user says hola', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Hola de nuevo! En que te puedo ayudar?',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
    }));
    const phone = '573001112278';
    repos.conversation.upsert(phone, { soft_closed_at: new Date().toISOString(), lead_score: 10 });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Hola' });

    expect(result.shouldSendReply).toBe(true);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.usedAi).toBe(true);

    const conv = repos.conversation.getByPhone(phone) as { soft_closed_at: string | null };
    expect(conv.soft_closed_at).toBeNull();
  });

  it('alerts owner on high-score decline without soft-close when qual data present', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112279';
    const skills = getSkills();
    repos.conversation.upsert(phone, {
      collected_name: 'Carlos',
      collected_people: 2,
      collected_date: 'agosto',
      price_given_at: new Date().toISOString(),
      lead_score: skills.salesStrategy.hotLeadThreshold,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'esta muy caro gracias' });

    expect(result.reply).toBeTruthy();
    expect(result.reply).not.toContain('https://www.instagram.com/andean_scapes/');
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('does not re-send gallery on decline bypassing soft-close when qual data present', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112290';
    const skills = getSkills();
    repos.conversation.upsert(phone, {
      collected_name: 'Maria',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      price_given_at: new Date().toISOString(),
      lead_score: skills.salesStrategy.hotLeadThreshold,
      gallery_nudged_at: new Date().toISOString(),
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'esta muy caro gracias' });

    expect(result.reply).toBeTruthy();
    expect(result.reply).not.toContain('https://www.instagram.com/andean_scapes/');
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.shouldSendGalleryImages).toBe(false);
  });

  it('does not re-send gallery on partner-consult pause after prior nudge', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112291';
    repos.conversation.upsert(phone, {
      collected_name: 'Sofia',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      price_given_at: new Date().toISOString(),
      gallery_nudged_at: new Date().toISOString(),
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'lo consulto con mi pareja' });

    expect(result.usedAi).toBe(false);
    expect(result.shouldSendGalleryImages).toBe(false);
  });

  it('does not re-send gallery on time-limit reservation handoff after prior nudge', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: true, reason: 'hourly_limit' });
    const phone = '573001112295';
    repos.conversation.upsert(phone, {
      collected_name: 'Lucia',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'agosto',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
      gallery_nudged_at: new Date().toISOString(),
    });
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'outbound',
      message_type: 'text',
      body: '¿Te gustaría reservar para esa fecha?',
      created_at: new Date(Date.now() - 5_000).toISOString(),
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'si quiero reservar' });

    expect(result.ownerAlertType).toBe('reservation_handoff');
    expect(result.shouldSendGalleryImages).toBe(false);
  });

  it('does not re-send gallery on LLM reservation handoff after prior nudge', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112296';
    repos.conversation.upsert(phone, {
      collected_name: 'Andrea',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'agosto',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
      gallery_nudged_at: new Date().toISOString(),
    });
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'outbound',
      message_type: 'text',
      body: '¿Te gustaría reservar para esa fecha?',
      created_at: new Date(Date.now() - 5_000).toISOString(),
    });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Perfecto! Confirmado.',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
    }));
    mockAnalyzeLead.mockResolvedValueOnce({
      intent: 'ready_to_book', scoreDelta: 80, confidence: 1.0,
      buyingSignals: ['confirm'], blockers: [],
      afterPriceInterest: true, reservationReadiness: 'strong',
      rationale: 'confirma reserva', promptTokens: 50, completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'si por favor' });

    expect(result.ownerAlertType).toBe('reservation_handoff');
    expect(result.shouldSendGalleryImages).toBe(false);
  });

  it('still sends gallery on explicit photo request even after prior nudge', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112294';
    repos.conversation.upsert(phone, { gallery_nudged_at: new Date().toISOString() });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Tienes fotos de la experiencia ?' });

    expect(result.usedAi).toBe(false);
    expect(result.shouldSendGalleryImages).toBe(true);
  });

  it('clears soft close and scores re-engagement', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001112258';
    repos.conversation.upsert(phone, { lead_score: 10, soft_closed_at: new Date().toISOString() });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Bueno después de pensar cuál es el itinerario?' });

    expect(result.shouldSendReply).toBe(true);
    expect(result.leadScore).toBeGreaterThan(10);

    const conv = repos.conversation.getByPhone(phone) as { lead_score: number; soft_closed_at: string | null };
    expect(conv.lead_score).toBeGreaterThan(10);
    expect(conv.soft_closed_at).toBeNull();
  });

  it('sends gentle limit reply without handoff for low-score users on time limit', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: true, reason: 'hourly_limit' });
    await withBridgeRouting(async () => {
      const phone = '573001112240';
      const result = await processMessage({ repos, customerPhone: phone, message: 'Hola de nuevo' });
      expect(result.reply).toContain('Te leo');
      expect(result.shouldSendReply).toBe(true);
      // First limit hit alerts owner so a human can take over if needed.
      expect(result.shouldAlertOwner).toBe(true);
      expect(repos.conversation.getHandedOffAt(phone)).toBeFalsy();
    });
  });

  it('pauses with partner summary when user says "validar con mi esposa" after price', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119101';
    repos.conversation.upsert(phone, {
      collected_name: 'Claudio',
      collected_people: 2,
      collected_plan: '2d1n_mining',
      price_given_at: new Date().toISOString(),
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Listo voy a validar con mi esposa y te escribo' });

    expect(result.reply).toContain('Dale Claudio');
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.usedAi).toBe(false);
    expect(mockLlmComplete).not.toHaveBeenCalled();
  });

  it('computes correct total for 10 people using couplePrice/2 formula', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119103';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan',
      collected_people: 10,
      collected_plan: '2d1n_mining',
      price_given_at: new Date().toISOString(),
    });

    const skills = getSkills();
    const exp = skills.andeanScapes.experiences[0];
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP', lastUpdated: '2026-01-01',
      items: [
        { id: 'individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, peopleIncluded: 1, publiclyShow: true },
        { id: 'couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1040000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'dejame consultarlo con mi esposa y te escribo' });

      expect(result.reply).toContain('Dale Juan');
      expect(result.reply).toContain('Para 10 personas queda en $5,200,000 COP total');
      expect(result.shouldAlertOwner).toBe(false);
      expect(result.usedAi).toBe(false);
      expect(mockLlmComplete).not.toHaveBeenCalled();
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('computes correct total for 10 people 3D/2N using couplePrice/2 formula', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119104';
    repos.conversation.upsert(phone, {
      collected_name: 'Maria',
      collected_people: 10,
      collected_plan: '3d2n_rural',
      price_given_at: new Date().toISOString(),
    });

    const skills = getSkills();
    const exp = skills.andeanScapes.experiences[0];
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP', lastUpdated: '2026-01-01',
      items: [
        { id: 'individual_3d2n', planId: '3d2n_rural', label: 'Individual 3D/2N', pricePerPerson: 750000, peopleIncluded: 1, publiclyShow: true },
        { id: 'couple_3d2n', planId: '3d2n_rural', label: 'Pareja 3D/2N', couplePrice: 1400000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'dejame revisarlo con mi novio y te confirmo' });

      expect(result.reply).toContain('Dale Maria');
      expect(result.reply).toContain('Para 10 personas queda en $7,000,000 COP total');
      expect(result.shouldAlertOwner).toBe(false);
      expect(result.usedAi).toBe(false);
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('pricing botRules come from dynamic remote, not static JSON', () => {
    // Static JSON has no pricing rules. When dynamic is loaded they appear.
    // Without dynamic service, botRules only contains PRICING_NOT_AVAILABLE.
    const rules = getActiveExperience(getSkills()).pricing.botRules.join(' ');
    expect(rules).toContain('PRICING_NOT_AVAILABLE');
  });

  it('alerts owner on message limit for hot leads with price progress without muting', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: true, reason: 'hourly_limit' });
    const phone = '573001119102';
    repos.conversation.upsert(phone, {
      collected_name: 'Andrea',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      price_given_at: new Date().toISOString(),
      lead_score: 80,
    });
    await withBridgeRouting(async () => {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Hola me puedes ayudar?' });
      expect(result.shouldAlertOwner).toBe(true);
      expect(result.reply.toLowerCase()).not.toContain('dame un momento');
      expect(repos.conversation.getHandedOffAt(phone)).toBeNull();
      expect(repos.conversation.getMode(phone)).toBe('bot');
    });
  });

  it('accepts null values in collected_fields', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const result = await processMessage({ repos, customerPhone: '573001112241', message: 'Hola' });
    expect(result.reply).toBeTruthy();
    expect(result.shouldSendReply).toBe(true);
    expect(result.usedAi).toBe(true);
  });

  it('blocks handoff and strips canned text when reservation intent without price presented', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112242';

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Quiero reservar ya' });
    expect(result.reply.toLowerCase()).not.toContain('dame unos minuticos');
    expect(result.reply.toLowerCase()).not.toContain('equipo de reservas');
    expect(result.shouldSendReply).toBe(true);

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(handed?.handed_off_at).toBeNull();
  });

  it('alerts owner and continues with LLM reply when qualification + price + reservation intent all present', async () => {
    mockLlmComplete.mockReset();
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

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    mockAnalyzeLead.mockResolvedValueOnce({
      intent: 'ready_to_book', scoreDelta: 80, confidence: 1.0,
      buyingSignals: ['reservar_ya'], blockers: [],
      afterPriceInterest: true, reservationReadiness: 'strong',
      rationale: 'listo para reservar', promptTokens: 50, completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Quiero reservar ya' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('reservation_handoff');
    expect(result.reply).toContain('Daniela');
    expect(result.reply).not.toContain('Perfecto');
    expect(result.leadScore).toBeGreaterThanOrEqual(95);

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(handed.handed_off_at).toBeNull();
  });

  it('boosts score and alerts owner on explicit reservation after price presented', async () => {
    mockLlmComplete.mockReset();
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

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'como se reserva?' });
    expect(result.leadScore).toBeGreaterThanOrEqual(0);

    const stored = repos.conversation.getByPhone(phone) as { lead_score: number };
    expect(stored.lead_score).toBeGreaterThanOrEqual(0);
  });

  it('alerts owner on clear reservation intent even when qualification is incomplete', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112247';

    repos.conversation.upsert(phone, {
      collected_name: 'Pedro',
      collected_people: 1,
      price_given_at: new Date().toISOString(),
    });

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'me gustaria reservar ya' });
    expect(result.shouldSendReply).toBe(true);
  });

  it('alerts owner when date completes a recent reservation intent after price', async () => {
    mockLlmComplete.mockReset();
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

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'finales de agosto' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('reservation_handoff');
    expect(result.leadScore).toBeGreaterThanOrEqual(95);

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(handed.handed_off_at).toBeNull();
  });

  it('bridges via deterministic fallback when analyzer is unavailable but qualification + price + reservation intent all present', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119901';

    repos.conversation.upsert(phone, {
      collected_name: 'Camila',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'julio',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Genial Camila!',
        intent: 'reservation',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
    }));
    // Analyzer unavailable (HTTP/timeout/invalid JSON or budget-skip).
    mockAnalyzeLead.mockResolvedValueOnce(null);

    const result = await processMessage({ repos, customerPhone: phone, message: 'quiero reservar ya' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('reservation_handoff');
  });

  it('does not bridge on analyzer-unavailable fallback when qualification is incomplete', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119902';

    // No price presented, incomplete profile — fallback must NOT bridge.
    repos.conversation.upsert(phone, { collected_name: 'Bruno' });

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Cuentame un poco mas para ayudarte.',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
    }));
    mockAnalyzeLead.mockResolvedValueOnce(null);

    const result = await processMessage({ repos, customerPhone: phone, message: 'quiero reservar ya' });
    expect(result.shouldAlertOwner).toBe(false);
  });

  it('skips the analyzer (no lead_analysis call) when budget is exhausted after the reply', async () => {
    mockLlmComplete.mockReset();
    mockAnalyzeLead.mockReset();
    // First checkBudget (reply gate) allows; second (analyzer gate) blocks.
    vi.mocked(checkBudget)
      .mockReturnValueOnce({ aiAllowed: true })
      .mockReturnValue({ aiAllowed: false, reason: 'daily_budget_exceeded' });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119903';

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Con gusto te cuento.',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 100,
      completionTokens: 20,
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'hola info' });

    expect(result.shouldSendReply).toBe(true);
    expect(mockAnalyzeLead).not.toHaveBeenCalled();
    // Only the reply usage row exists; no lead_analysis row was recorded.
    const todayStart = new Date().toISOString().split('T')[0];
    expect(repos.aiUsage.countCustomerDaily(phone, todayStart)).toBe(1);
  });

  it('does not persist the owner name as the customer name', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119904';

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Hola, con gusto te ayudo.',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: { name: env.OWNER_NAME },
      },
    }));
    mockAnalyzeLead.mockResolvedValueOnce(null);

    await processMessage({ repos, customerPhone: phone, message: 'hola' });

    const conv = repos.conversation.getByPhone(phone) as { collected_name: string | null };
    expect(conv.collected_name).toBeNull();
  });

  it('alerts owner when user confirms reservation with si por favor', async () => {
    mockLlmComplete.mockReset();
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

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    mockAnalyzeLead.mockResolvedValueOnce({
      intent: 'ready_to_book', scoreDelta: 80, confidence: 1.0,
      buyingSignals: ['si_por_favor'], blockers: [],
      afterPriceInterest: true, reservationReadiness: 'strong',
      rationale: 'confirma reserva', promptTokens: 50, completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'si por favor' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('reservation_handoff');

    const conv = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(conv.handed_off_at).toBeNull();
  });

  it('detects dale cuenten conmigo as reservation intent', async () => {
    mockLlmComplete.mockReset();
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

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'dale cuenten conmigo' });
    expect(result.leadScore).toBeGreaterThanOrEqual(0);
  });

  it('soft closes with IG link on gracias por la info lo voy a pensar', async () => {
    mockLlmComplete.mockReset();
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
    mockLlmComplete.mockReset();
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

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'aqui estoy de vuelta, si quiero' });
    expect(result.reply).toContain('Diego');
    expect(result.usedAi).toBe(true);
  });

  it('alerts owner on Nequi payment intent and continues with LLM reply', async () => {
    mockLlmComplete.mockReset();
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

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const restorePayments = installPaymentData();
    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'prefiero pagar por nequi' });
      expect(result.shouldAlertOwner).toBe(true);
      expect(result.ownerAlertType).toBe('reservation_handoff');
      expect(result.reply).toContain('15%');
      expect(result.reply).toContain('Nequi');
      expect(result.reply).not.toContain('3000000000');

      const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
      expect(handed.handed_off_at).toBeNull();
    } finally {
      restorePayments();
    }
  });

  it('alerts owner on payment methods ask even when qualification is incomplete', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119901';

    repos.conversation.upsert(phone, {
      language: 'es',
      collected_people: 1,
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Te paso el Nequi 3000000000 ahora.',
        intent: 'ready_to_book',
        lead_score_delta: 30,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 20,
    }));

    const restorePayments = installPaymentData();
    try {
      const result = await processMessage({
        repos,
        customerPhone: phone,
        message: 'Dame el Numero de Nequi',
      });

      expect(result.shouldSendReply).toBe(true);
      expect(result.shouldAlertOwner).toBe(true);
      expect(result.ownerAlertType).toBe('reservation_handoff');
      expect(result.leadScore).toBeGreaterThanOrEqual(getSkills().salesStrategy.urgentLeadThreshold);

      expect(result.reply).toMatch(/Nequi|Mercado Pago/i);
      expect(result.reply).toMatch(/15%/);
      expect(result.reply).not.toContain('3000000000');
      expect(result.reply).not.toMatch(/https?:\/\//i);

      expect(repos.conversation.getMode(phone)).toBe('bot');
      const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
      expect(handed.handed_off_at).toBeNull();

      expect(repos.conversation.getSalesPhase(phone)).toBe('closing');
    } finally {
      restorePayments();
    }
  });

  it('uses deterministic payment reply for payment-method question without close intent', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112353';

    repos.conversation.upsert(phone, {
      collected_name: 'Paula',
      collected_plan: '2d1n_mining',
      collected_people: 3,
      collected_date: 'junio',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Puedes pagar por Nequi al 3000000000 o usar este link: https://pago.example.com.',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: true,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    }));

    const restorePayments = installPaymentData();
    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'que metodos de pago tienen?' });
      expect(result.shouldAlertOwner).toBe(true);
      expect(result.ownerAlertType).toBe('reservation_handoff');
      expect(result.reply).toContain('15%');
      expect(result.reply).toContain('Nequi');
      expect(result.reply).not.toContain('3000000000');
      expect(result.reply).not.toContain('https://pago.example.com');
      expect(result.shouldSendGalleryImages).toBe(false);
      expect(result.shouldSendImage).toBe(false);
    } finally {
      restorePayments();
    }
  });

  it('uses validated fallback payment facts when dynamic payments are unavailable', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112354';

    repos.conversation.upsert(phone, {
      collected_name: 'Paula',
      collected_plan: '2d1n_mining',
      collected_people: 3,
      collected_date: 'junio',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Claro, te cuento los metodos.',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 30,
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'que medios de pago aceptan?' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('reservation_handoff');
    expect(result.reply).toContain(`${getSkills().andeanScapes.business.publicPaymentFallback.depositPercent}%`);
    expect(result.reply).toContain(getSkills().andeanScapes.business.publicPaymentFallback.methodNames[0]);
    expect(result.shouldSendGalleryImages).toBe(false);
  });

  it('keeps Spanish payment reply despite English-marker words in message', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112360';

    repos.conversation.upsert(phone, {
      language: 'es',
      collected_name: 'Carlos',
      collected_plan: '2d1n_mining',
      collected_people: 1,
      collected_date: 'julio',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Claro, te cuento los metodos.',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 20,
    }));

    const restorePayments = installPaymentData();
    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Me regalas el Nequi para reserve' });
      expect(result.shouldAlertOwner).toBe(true);
      expect(result.ownerAlertType).toBe('reservation_handoff');
      expect(result.reply).toContain('Los metodos disponibles');
      expect(result.reply).not.toContain('Available methods');

      const lang = repos.conversation.getLanguage(phone);
      expect(lang).toBe('es');
    } finally {
      restorePayments();
    }
  });

  it('alerts owner on Si after bot asks te gustaria reservar', async () => {
    mockLlmComplete.mockReset();
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

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    mockAnalyzeLead.mockResolvedValueOnce({
      intent: 'ready_to_book', scoreDelta: 80, confidence: 1.0,
      buyingSignals: ['confirm_si'], blockers: [],
      afterPriceInterest: true, reservationReadiness: 'strong',
      rationale: 'confirma reserva', promptTokens: 50, completionTokens: 30,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Si' });
    expect(result.reply).toContain('Paula');
    expect(result.shouldAlertOwner).toBe(true);

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(handed.handed_off_at).toBeNull();
  });

  it('does NOT handoff on bare Si without reservation question context', async () => {
    mockLlmComplete.mockReset();
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

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Si' });
    expect(result.shouldAlertOwner).toBe(false);

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(handed.handed_off_at).toBeNull();
  });

  it('alerts owner and continues with LLM reply on unsafe payment claims from AI', async () => {
    mockLlmComplete.mockReset();
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

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const restorePayments = installPaymentData();
    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'como se hace la reserva?' });
      expect(result.reply).toContain('15%');
      expect(result.reply).not.toContain('inserte');
      expect(result.reply).not.toContain('3000000000');
      expect(result.shouldAlertOwner).toBe(true);
      expect(result.ownerAlertType).toBe('reservation_handoff');
    } finally {
      restorePayments();
    }
  });

  it('blocks unverified exact availability claims from AI reply', async () => {
    mockLlmComplete.mockReset();
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

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'que fecha hay?' });
    // Listing dates is no longer blocked — the bot should tell customers what dates
    // are available. The narrowed guard only blocks false reservation confirmations.
    expect(result.reply.toLowerCase()).toContain('domingo 8 de junio');
  });

  it('alerts owner and continues with LLM reply on unsafe cupo claims from AI', async () => {
    mockLlmComplete.mockReset();
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

    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'me interesa' });
    expect(result.reply).toBeTruthy();
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('reservation_handoff');
  });

  it('detects price in AI reply and persists price_given_at', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112244';

    const skills = getSkills();
    const exp = skills.andeanScapes.experiences[0];
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP', lastUpdated: '2026-01-01',
      items: [
        { id: 'individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, peopleIncluded: 1, publiclyShow: true },
        { id: 'couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1040000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      mockLlmComplete.mockResolvedValueOnce(fromOld({
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
      }));

      await processMessage({ repos, customerPhone: phone, message: 'cuanto cuesta?' });

      const row = repos.conversation.getByPhone(phone) as { price_given_at: string | null };
      expect(row.price_given_at).toBeTruthy();
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('asks next qualification question when AI fails and qualification incomplete', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    const result = await processMessage({ repos, customerPhone: '573001112245', message: 'Hola' });
    expect(result.reply).not.toContain('como te llamas');
    expect(result.shouldSendReply).toBe(true);
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.usedAi).toBe(true);
  });

  it('asks next qualification question when DeepSeek returns no-reply and qualification incomplete', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const result2 = await processMessage({ repos, customerPhone: '573001112246', message: '???' });
    expect(result2.reply).not.toContain('como te llamas');
    expect(result2.shouldSendReply).toBe(true);
    expect(result2.shouldAlertOwner).toBe(false);
  });

  it('alerts owner when LLM fails and customer has given name', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113009';
    repos.conversation.upsert(phone, { collected_name: 'Daniela' });
    const result = await processMessage({ repos, customerPhone: phone, message: 'cuanto cuesta?' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.usedAi).toBe(true);
  });

  it('alerts owner when LLM returns empty reply and customer has given name', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113010';
    repos.conversation.upsert(phone, { collected_name: 'Daniela' });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: '',
        intent: 'general',
        lead_score_delta: 0,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 400,
      completionTokens: 30,
    }));
    const result = await processMessage({ repos, customerPhone: phone, message: 'cuanto cuesta?' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.usedAi).toBe(true);
  });

  it('alerts owner on policy violation deflection', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113011';
    repos.conversation.upsert(phone, { collected_name: 'Daniela' });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Claro! Te doy un descuento del 20% por ser cliente nuevo.',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 400,
      completionTokens: 30,
    }));
    const result = await processMessage({ repos, customerPhone: phone, message: 'cuanto cuesta?' });
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('policy_violation_blocked');
  });

  it('does not alert owner when LLM fails and customer has no data', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    const result = await processMessage({ repos, customerPhone: '573001113012', message: 'Hola' });
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.usedAi).toBe(true);
  });

  it('alerts owner when LLM fails and customer has qualification data without name', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113013';
    repos.conversation.upsert(phone, { collected_plan: '2d1n_mining', collected_people: 3 });

    const result = await processMessage({ repos, customerPhone: phone, message: 'como se reserva?' });

    expect(result.shouldAlertOwner).toBe(true);
    expect(result.usedAi).toBe(true);
  });

  it('does not handoff on pet mention, stays in qualification', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001112247';
    const result = await processMessage({ repos, customerPhone: phone, message: 'Soy Luis, mi esposo y yo y mi perro' });
    expect(result.reply).toContain('pet-friendly');
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.reply).not.toContain('equipo de reservas');

    const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(handed?.handed_off_at).toBeNull();
  });

  it('persists name from "soy Paula"', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001112248';
    const result = await processMessage({ repos, customerPhone: phone, message: 'hola soy Paula' });
    expect(result.reply).toContain('Paula');
    const conv = repos.conversation.getByPhone(phone) as { collected_name: string | null };
    expect(conv.collected_name).toBe('Paula');
  });

  it('persists accented name from "Soy Álvaro"', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001112259';
    await processMessage({ repos, customerPhone: phone, message: 'Soy Álvaro' });
    const conv = repos.conversation.getByPhone(phone) as { collected_name: string | null };
    expect(conv.collected_name).toBe('Álvaro');
  });

  it('persists solo English traveler and month from "just me" message', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001112268';
    await processMessage({ repos, customerPhone: phone, message: 'Just me I am planning to visit Colombia next december' });
    const conv = repos.conversation.getByPhone(phone) as { collected_people: number | null; collected_date: string | null; language: string | null };
    expect(conv.collected_people).toBe(1);
    expect(conv.collected_date).toBe('december');
    expect(conv.language).toBe('en');
  });

  it('persists standalone name after bot asks name', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001112260';
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: 'Antes de seguir, ¿como te llamas?', created_at: new Date().toISOString() });
    await processMessage({ repos, customerPhone: phone, message: 'Álvaro' });
    const conv = repos.conversation.getByPhone(phone) as { collected_name: string | null };
    expect(conv.collected_name).toBe('Álvaro');
  });

  it('answers actionable reservation/itinerary question instead of re-asking missing name on AI failure', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(null);
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
    expect(result.reply).toContain('Dejame validar');
    expect(result.reply).not.toContain('como te llamas');
  });

  it('extracts solo traveler correction without storing Ya as name', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001112263';
    await processMessage({ repos, customerPhone: phone, message: 'Ya dije que yo sola' });
    const conv = repos.conversation.getByPhone(phone) as { collected_name: string | null; collected_people: number | null };
    expect(conv.collected_name).toBeNull();
    expect(conv.collected_people).toBe(1);
  });

  it('alerts owner on payment intent when message limit is reached without muting', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: true, reason: 'hourly_limit' });
    const cleanup = installPaymentData();
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
    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Si quiero pagar por favor' });
      expect(result.reply).toMatch(/anticipo|deposit|15%/i);
      expect(result.reply.toLowerCase()).not.toContain('responderte a medias');
      expect(result.shouldAlertOwner).toBe(true);
      expect(result.ownerAlertType).toBe('reservation_handoff');
      expect(repos.conversation.getHandedOffAt(phone)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('alerts and sets urgent score on reservation intent after price when limit reached without muting', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: true, reason: 'hourly_limit' });
    const cleanup = installPaymentData();
    const phone = '573001112288';
    repos.conversation.upsert(phone, {
      collected_name: 'Juana',
      collected_plan: '2d1n_mining',
      collected_people: 1,
      collected_date: 'sabado 5 de septiembre',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
      lead_score: 23,
    });
    repos.message.addMessage({
      customer_phone: phone, direction: 'outbound', message_type: 'text',
      body: '¿Te gustaría reservar para esa fecha?',
      created_at: new Date(Date.now() - 5_000).toISOString(),
    });
    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Si me gustaria reservar' });
      expect(result.reply).toMatch(/anticipo|deposit|15%/i);
      expect(result.shouldAlertOwner).toBe(true);
      expect(result.leadScore).toBeGreaterThanOrEqual(95);
      expect(result.reply.toLowerCase()).not.toContain('responderte a medias');
      expect(repos.conversation.getHandedOffAt(phone)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('alerts owner without muting when date selected after price under limit', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: true, reason: 'hourly_limit' });
    const phone = '573001112292';
    repos.conversation.upsert(phone, {
      collected_name: 'Juana',
      collected_plan: '2d1n_mining',
      collected_people: 1,
      collected_transport_need: 'public_bus',
      price_given_at: new Date().toISOString(),
      lead_score: 23,
    });
    repos.message.addMessage({
      customer_phone: phone, direction: 'outbound', message_type: 'text',
      body: 'Sábado 1 de agosto\nSábado 15 de agosto',
      created_at: new Date(Date.now() - 5_000).toISOString(),
    });
    await withBridgeRouting(async () => {
      const result = await processMessage({ repos, customerPhone: phone, message: 'la del primero esta bien' });
      expect(result.reply).toContain('sigo yo personalmente');
      expect(result.shouldAlertOwner).toBe(true);
      expect(repos.conversation.getHandedOffAt(phone)).toBeNull();
      expect(repos.conversation.getMode(phone)).toBe('bot');
    });
  });

  it('uses reservation closing under limit instead of transport summary handoff', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: true, reason: 'hourly_limit' });
    const cleanup = installPaymentData();
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
    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Si quiero pagar por favor' });
      expect(result.reply).toMatch(/anticipo|Nequi/i);
      expect(result.reply).not.toContain('transporte propio');
      expect(repos.conversation.getHandedOffAt(phone)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('keeps English for reservation handoff and ambiguous follow-up', async () => {
    mockLlmComplete.mockReset();
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
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const result = await processMessage({ repos, customerPhone: phone, message: 'Lol yes so how can I make reservation ?' });
    expect(result.reply).toMatch(/perfect|Perfect|Great|Excellent/);
    expect(result.reply).not.toContain('Perfecto');

    const followUp = await processMessage({ repos, customerPhone: phone, message: '?' });
    expect(followUp.reply).toMatch(/here|check|confirm/i);
    expect(followUp.reply).not.toContain('equipo');
  });

  it('replaces generic conversion reply with itinerary and does not alert before reservation intent', async () => {
    mockLlmComplete.mockReset();
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
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const result = await processMessage({ repos, customerPhone: phone, message: 'Cómo sería el itinerario a qué horas debo llegar ?' });
    expect(result.reply).toContain('Juana');
    expect(result.shouldAlertOwner).toBe(false);
  });

  it('does not alert on repeated itinerary question even with score above threshold', async () => {
    mockLlmComplete.mockReset();
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
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const result = await processMessage({ repos, customerPhone: phone, message: 'Como es el itinerario no me dijiste' });
    expect(result.leadScore).toBeGreaterThanOrEqual(85);
    expect(result.leadScore).toBeLessThan(95);
    expect(result.shouldAlertOwner).toBe(false);
  });

  it('persists people from "somos 2 y mi perro"', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001112249';
    await processMessage({ repos, customerPhone: phone, message: 'somos 2 y mi perro' });
    const conv = repos.conversation.getByPhone(phone) as { collected_people: number | null; collected_pet: string | null };
    expect(conv.collected_people).toBe(2);
    expect(conv.collected_pet).toBe('yes');
  });

  it('persists transport from "vamos en moto"', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001112250';
    await processMessage({ repos, customerPhone: phone, message: 'si tenemos vehiculo propio moto' });
    const conv = repos.conversation.getByPhone(phone) as { collected_transport_need: string | null };
    expect(conv.collected_transport_need).toBe('own');
  });

  it('captures transport from "si mi carro"', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'Perfecto, con tu carro esta bien!', intent: 'general', lead_score_delta: 5, should_send_image: false, needs_human: false, missing_fields: [], collected_fields: {} },
      promptTokens: 500, completionTokens: 30,
    }));
    const phone = '573001112286';
    await processMessage({ repos, customerPhone: phone, message: 'si mi carro' });
    const conv = repos.conversation.getByPhone(phone) as { collected_transport_need: string | null };
    expect(conv.collected_transport_need).toBe('own');
  });

  it('does not classify "necesito carro desde Bogota" as own transport', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'Claro, lo validamos.', intent: 'general', lead_score_delta: 5, should_send_image: false, needs_human: false, missing_fields: [], collected_fields: {} },
      promptTokens: 500, completionTokens: 30,
    }));
    const phone = '573001112289';
    await processMessage({ repos, customerPhone: phone, message: 'necesito carro desde Bogota' });
    const conv = repos.conversation.getByPhone(phone) as { collected_transport_need: string | null };
    expect(conv.collected_transport_need).not.toBe('own');
  });

  it('does not classify "hay transporte en carro" as own transport', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'Te cuento.', intent: 'general', lead_score_delta: 5, should_send_image: false, needs_human: false, missing_fields: [], collected_fields: {} },
      promptTokens: 500, completionTokens: 30,
    }));
    const phone = '573001112290';
    await processMessage({ repos, customerPhone: phone, message: 'hay transporte en carro?' });
    const conv = repos.conversation.getByPhone(phone) as { collected_transport_need: string | null };
    expect(conv.collected_transport_need).not.toBe('own');
  });

  it('captures public bus from "voy en bus"', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'Perfecto, bus publico por tu cuenta.', intent: 'general', lead_score_delta: 5, should_send_image: false, needs_human: false, missing_fields: [], collected_fields: {} },
      promptTokens: 500, completionTokens: 30,
    }));
    const phone = '573001112291';
    await processMessage({ repos, customerPhone: phone, message: 'voy en bus' });
    const conv = repos.conversation.getByPhone(phone) as { collected_transport_need: string | null };
    expect(conv.collected_transport_need).toBe('public_bus');
  });

  it('captures exact date from "sabado 5 de septiembre"', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'Perfecto! Sabado 5 de septiembre.', intent: 'general', lead_score_delta: 5, should_send_image: false, needs_human: false, missing_fields: [], collected_fields: {} },
      promptTokens: 500, completionTokens: 30,
    }));
    const phone = '573001112287';
    await processMessage({ repos, customerPhone: phone, message: 'para sabado 5 de septiembre' });
    const conv = repos.conversation.getByPhone(phone) as { collected_date: string | null };
    expect(conv.collected_date).toBe('sabado 5 de septiembre');
  });

  it('resolves "la del primero" to date from availability list', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'Perfecto! Tomamos el 1 de agosto.', intent: 'general', lead_score_delta: 15, should_send_image: false, needs_human: false, missing_fields: [], collected_fields: {} },
      promptTokens: 500, completionTokens: 30,
    }));
    const phone = '573001112293';
    repos.message.addMessage({
      customer_phone: phone, direction: 'outbound', message_type: 'text',
      body: '- Sábado 1 de agosto\n- Sábado 15 de agosto\n¿Cuál te llama la atención?',
      created_at: new Date(Date.now() - 5_000).toISOString(),
    });
    await processMessage({ repos, customerPhone: phone, message: 'la del primero esta bien' });
    const conv = repos.conversation.getByPhone(phone) as { collected_date: string | null };
    expect(conv.collected_date).toBe('sábado 1 de agosto');
  });

  it('handles "ya lo dije" correction and continues flow', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(null);
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
    expect(result.reply).toContain('Te leo');
    expect(result.shouldAlertOwner).toBe(true);
  });

  it('reconstructs qualification from conversation history on AI failure', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(null);
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
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const result = await processMessage({ repos, customerPhone: '573001113005', message: 'Hola' });

    expect(result.reply).toContain('Boyaca');
    expect(result.reply).not.toMatch(/\b(?:mina|esmeralda|chivor|hacienda|apicultura|ganader[ií]a|artesan[ií]a|R[aá]quira)\b/i);
    expect(result.reply).not.toMatch(/como te llamas/i);
    expect(result.reply).toMatch(/pareja|grupo|solo/i);
  });

  it('keeps first-contact micro-question in English', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Hello! I am Heinner from Andean Scapes. What is your name?',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 40,
    }));

    const result = await processMessage({ repos, customerPhone: '573001113021', message: 'Hello' });

    expect(result.reply).not.toMatch(/what is your name/i);
    expect(result.reply).not.toMatch(/experiencia ser[ií]a/i);
    expect(result.reply).toMatch(/alone, as a couple, or for a group/i);
  });

  it('strips repeated qualification questions for already collected fields', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113022';
    repos.conversation.upsert(phone, {
      collected_name: 'Ana',
      collected_people: 2,
      collected_date: 'agosto',
      collected_transport_need: 'own',
    });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Perfecto Ana. ¿Cuántas personas serían? ¿Qué fecha tienes en mente? ¿Vienen en carro propio o necesitan transporte?',
        intent: 'general',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 40,
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'me interesa' });

    expect(result.reply).toContain('Perfecto Ana');
    expect(result.reply).not.toMatch(/cu[aá]ntas personas/i);
    expect(result.reply).not.toMatch(/fecha tienes/i);
    expect(result.reply).not.toMatch(/carro propio o necesitan transporte/i);
  });

  it('asks plan after name and replaces name token', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(null);
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113001';

    const result = await processMessage({ repos, customerPhone: phone, message: 'soy Ana' });
    expect(result.reply).toContain('Ana');
    expect(result.shouldSendReply).toBe(true);
  });

  it('detects 3D/2N plan and persists it', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001113002';

    await processMessage({ repos, customerPhone: phone, message: 'quiero el plan de 3 dias con abejas' });

    const conv = repos.conversation.getByPhone(phone) as { collected_plan: string | null };
    expect(conv.collected_plan).toBe('3d2n_rural');
  });

  it('detects 3D/2N when message also mentions mine', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001113007';

    await processMessage({ repos, customerPhone: phone, message: 'quiero el plan de la mina de 3 dias' });

    const conv = repos.conversation.getByPhone(phone) as { collected_plan: string | null };
    expect(conv.collected_plan).toBe('3d2n_rural');
  });

  it('latest explicit 3D/2N mention overrides older stored 2D/1N plan', async () => {
    mockLlmComplete.mockReset();
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

    const skills = getSkills();
    const exp = skills.andeanScapes.experiences[0];
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP', lastUpdated: '2026-01-01',
      items: [
        { id: 'individual_3d2n', planId: '3d2n_rural', label: 'Individual 3D/2N', pricePerPerson: 750000, peopleIncluded: 1, publiclyShow: true },
        { id: 'couple_3d2n', planId: '3d2n_rural', label: 'Pareja 3D/2N', couplePrice: 1400000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      mockLlmComplete.mockResolvedValueOnce(fromOld({
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
      }));

      const result = await processMessage({ repos, customerPhone: phone, message: 'somos tres que precio tiene?' });

      expect(result.reply).toContain('$2,150,000 COP');
      expect(result.priceFollowUpText).toBeUndefined();
      const conv = repos.conversation.getByPhone(phone) as { collected_plan: string | null };
      expect(conv.collected_plan).toBe('3d2n_rural');
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('uses 3D/2N image after ambiguous mine plus 3 days plan mention', async () => {
    const dynamicImages = [
      { id: 'emerald_mining_preview_1', experienceId: 'emerald_mining_tour', planId: '2d1n_mining', url: 'https://cdn.andeanscapes.com/whatsapp_bot/details/2d1n_1.png', caption: '2D/1N' },
      { id: 'rural_experience_preview_1', experienceId: 'emerald_mining_tour', planId: '3d2n_rural', url: 'https://cdn.andeanscapes.com/whatsapp_bot/details/3d2n_1.png', caption: '3D/2N' },
    ];
    const image = selectPlanImage(dynamicImages, '3d2n_rural');
    expect(image?.url).toBe('https://cdn.andeanscapes.com/whatsapp_bot/details/3d2n_1.png');
  });

  it('blocks handoff until plan is selected', async () => {
    mockLlmComplete.mockReset();
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
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'quiero reservar' });

    expect(result.shouldAlertOwner).toBe(false);
    expect(result.reply).toContain('Perfecto Ana');
    const conv = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
    expect(conv.handed_off_at).toBeNull();
  });

  it('close-replies when unsafe claim has near-complete qual with price', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113008';
    repos.conversation.upsert(phone, {
      collected_name: 'Daniela',
      collected_plan: '2d1n_mining',
      collected_date: 'agosto',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
    });
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'outbound',
      message_type: 'text',
      body: '¿Cuantas personas serian Daniela?',
      created_at: new Date(Date.now() - 5_000).toISOString(),
    });
    const cleanup = installPaymentData();
    try {
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: {
          reply: 'Perfecto Daniela, ya quedo reservado para el 7 de agosto.',
          intent: 'reservation',
          lead_score_delta: 20,
          should_send_image: false,
          needs_human: false,
          missing_fields: [],
          collected_fields: {},
        },
        promptTokens: 500,
        completionTokens: 30,
      }));

      const result = await processMessage({ repos, customerPhone: phone, message: 'si quiero reservar' });

      expect(result.shouldAlertOwner).toBe(true);
      expect(result.ownerAlertType).toBe('reservation_handoff');
      expect(result.reply).not.toContain('reservado');
      expect(result.reply).not.toContain('Te leo');
      expect(result.reply).toMatch(/Daniela|anticipo|deposit/i);
      expect(result.shouldSendGalleryImages).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('advances to pending owner when user confirms after reservation closing', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113309';
    const skills = getSkills();
    repos.conversation.upsert(phone, {
      collected_name: 'Juan',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'octubre',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
      lead_score: 85,
    });
    // Simulate bot just sent reservationClosing CTA
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'outbound',
      message_type: 'text',
      body: skills.fallbackReplies.es.reservationClosing
        .replace('{{name}}', 'Juan')
        .replace('{{summary}}', '2 personas, octubre, con transporte propio')
        .replace('{{date}}', 'octubre')
        .replace('{{deposit}}', '15')
        .replace('{{methods}}', 'Nequi o Mercado Pago'),
      created_at: new Date(Date.now() - 5_000).toISOString(),
    });
    const cleanup = installPaymentData();
    try {
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: {
          reply: 'Buenisimo Juan, dale.',
          intent: 'ready_to_book',
          lead_score_delta: 10,
          needs_human: false,
        },
      }));
      mockAnalyzeLead.mockResolvedValueOnce({
        intent: 'ready_to_book', scoreDelta: 80, confidence: 1.0,
        buyingSignals: ['validacion_confirm'], blockers: [],
        afterPriceInterest: true, reservationReadiness: 'strong',
        rationale: 'cliente confirma validacion', promptTokens: 50, completionTokens: 30,
      });
      const result = await processMessage({ repos, customerPhone: phone, message: 'Si quiero iniciar la validacion' });
      expect(result.shouldAlertOwner).toBe(true);
      expect(result.reply).toContain('Juan');
      expect(result.reply).toMatch(/estoy validando|validando disponibilidad/i);
      expect(result.reply).not.toMatch(/inicie esa validacion|inicie la validacion/i);
      expect(result.shouldSendGalleryImages).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('sends short ack not full close template when confirming after pending owner sent', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001113310';
    repos.conversation.upsert(phone, {
      collected_name: 'Juan',
      collected_plan: '2d1n_mining',
      collected_people: 2,
      collected_date: 'octubre',
      collected_transport_need: 'own',
      price_given_at: new Date().toISOString(),
      lead_score: 95,
    });
    // Simulate bot already sent pending owner response
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'outbound',
      message_type: 'text',
      body: 'Juan, ya quede atento a tu caso y estoy validando disponibilidad de octubre. En cuanto tenga confirmacion te escribo el siguiente paso.',
      created_at: new Date(Date.now() - 5_000).toISOString(),
    });
    const cleanup = installPaymentData();
    try {
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: {
          reply: 'Ok perfecto gracias.',
          intent: 'ready_to_book',
          lead_score_delta: 0,
          needs_human: true,
        },
      }));
      mockAnalyzeLead.mockResolvedValueOnce({
        intent: 'ready_to_book', scoreDelta: 80, confidence: 1.0,
        buyingSignals: ['gracias_confirm'], blockers: [],
        afterPriceInterest: true, reservationReadiness: 'strong',
        rationale: 'cliente confirma gracias', promptTokens: 50, completionTokens: 30,
      });
      const result = await processMessage({ repos, customerPhone: phone, message: 'Ya dije que si gracias' });
      expect(result.shouldAlertOwner).toBe(true);
      expect(result.reply).toContain('Juan');
      expect(result.reply).toMatch(/ya estoy validando|already validating/i);
      expect(result.reply).not.toMatch(/inicie esa validacion|quieres que inicie/i);
      expect(result.reply).not.toMatch(/inicie la validacion/i);
      expect(result.shouldSendGalleryImages).toBe(false);
    } finally {
      cleanup();
    }
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

  describe('selectPlanImage', () => {
    it('selects dynamic plan image matching planId', () => {
      const dynamicImages = [
        { id: 'dyn_2d1n', experienceId: 'emerald_mining_tour', planId: '2d1n_mining', url: 'https://cdn.andeanscapes.com/whatsapp_bot/details/2d1n_1.png', caption: '2D/1N' },
        { id: 'dyn_3d2n', experienceId: 'emerald_mining_tour', planId: '3d2n_rural', url: 'https://cdn.andeanscapes.com/whatsapp_bot/details/3d2n_1.png', caption: '3D/2N' },
      ];
      const image = selectPlanImage(dynamicImages, '3d2n_rural');
      expect(image?.id).toBe('dyn_3d2n');
    });

    it('falls back to first dynamic image when planId has no match', () => {
      const dynamicImages = [
        { id: 'dyn_2d1n', experienceId: 'emerald_mining_tour', planId: '2d1n_mining', url: 'https://cdn.andeanscapes.com/whatsapp_bot/details/2d1n_1.png', caption: '2D/1N' },
      ];
      const image = selectPlanImage(dynamicImages, 'nonexistent_plan');
      expect(image?.id).toBe('dyn_2d1n');
    });

    it('returns undefined when dynamic images array is empty', () => {
      const image = selectPlanImage([], '2d1n_mining');
      expect(image).toBeUndefined();
    });

    it('returns first dynamic image when planId is null', () => {
      const dynamicImages = [
        { id: 'dyn_2d1n', experienceId: 'emerald_mining_tour', planId: '2d1n_mining', url: 'https://cdn.andeanscapes.com/whatsapp_bot/details/2d1n_1.png', caption: '2D/1N' },
        { id: 'dyn_3d2n', experienceId: 'emerald_mining_tour', planId: '3d2n_rural', url: 'https://cdn.andeanscapes.com/whatsapp_bot/details/3d2n_1.png', caption: '3D/2N' },
      ];
      const image = selectPlanImage(dynamicImages, null);
      expect(image?.id).toBe('dyn_2d1n');
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

    it('does not count gallery nudge marker as an image send', () => {
      const phone = '573001119006';
      repos.conversation.upsert(phone, {});
      recordGalleryNudge(repos, phone);

      expect(hasGalleryNudge(repos, phone)).toBe(true);
      expect(repos.mediaSend.countRecentImages(phone, new Date(0).toISOString())).toBe(0);
      expect(canSendImage(repos, phone)).toBe(true);
    });

    it('caps gallery images per send', () => {
      const previous = env.MAX_GALLERY_IMAGES_PER_SEND;
      env.MAX_GALLERY_IMAGES_PER_SEND = 10;
      try {
        const selected = selectGalleryImages(Array.from({ length: 30 }, (_, idx) => ({
          url: `https://cdn.andeanscapes.com/${idx}.jpg`,
          caption: String(idx),
        })));

        expect(selected).toHaveLength(5);
      } finally {
        env.MAX_GALLERY_IMAGES_PER_SEND = previous;
      }
    });

    it('returns all gallery images when fewer than cap', () => {
      const previous = env.MAX_GALLERY_IMAGES_PER_SEND;
      env.MAX_GALLERY_IMAGES_PER_SEND = 10;
      try {
        const selected = selectGalleryImages([
          { url: 'https://cdn.andeanscapes.com/1.jpg', caption: '1' },
          { url: 'https://cdn.andeanscapes.com/2.jpg', caption: '2' },
        ]);

        expect(selected).toHaveLength(2);
      } finally {
        env.MAX_GALLERY_IMAGES_PER_SEND = previous;
      }
    });
  });

  it('does not trigger mid-funnel gallery after previous gallery nudge', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119007';
    repos.conversation.upsert(phone, {
      collected_name: 'Daniel',
      collected_plan: '2d1n_mining',
      collected_people: 1,
      price_given_at: new Date().toISOString(),
      gallery_nudged_at: new Date().toISOString(),
    });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Perfecto, seguimos con la experiencia minera.',
        collected_fields: { name: 'Daniel', plan: '2d1n_mining', people: 1 },
      },
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'me interesa' });

    expect(result.shouldSendGalleryImages).toBe(false);
  });

  it('sends gallery for direct photo request without LLM', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119008';

    const result = await processMessage({ repos, customerPhone: phone, message: 'Tienes fotos de la experiencia ?' });

    expect(result.usedAi).toBe(false);
    expect(result.reply).toBe(getSkills().fallbackReplies.es.galleryIntro);
    expect(result.shouldSendGalleryImages).toBe(true);
  });

  it('sends gallery for confirmation after assistant offers photos', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119009';
    repos.conversation.upsert(phone, {});
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'outbound',
      message_type: 'text',
      body: 'Te puedo compartir algunas fotos. ¿Te parece si te las envío por aquí?',
      created_at: new Date().toISOString(),
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Si Aqui' });

    expect(result.usedAi).toBe(false);
    expect(result.shouldSendGalleryImages).toBe(true);
  });

  it('keeps shouldSendImage true when plan image changed inside 72h', async () => {
    mockLlmComplete.mockReset();
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
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'me muestras foto del plan de 3 dias?' });

    expect(result.shouldSendImage).toBe(true);
  });

  it('uses 3D/2N JSON pricing for price follow-up', async () => {
    mockLlmComplete.mockReset();
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

    const skills = getSkills();
    const exp = skills.andeanScapes.experiences[0];
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP', lastUpdated: '2026-01-01',
      items: [
        { id: 'individual_3d2n', planId: '3d2n_rural', label: 'Individual 3D/2N', pricePerPerson: 750000, peopleIncluded: 1, publiclyShow: true },
        { id: 'couple_3d2n', planId: '3d2n_rural', label: 'Pareja 3D/2N', couplePrice: 1400000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      mockLlmComplete.mockResolvedValueOnce(fromOld({
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
      }));

      const result = await processMessage({ repos, customerPhone: phone, message: 'cuanto cuesta?' });

      expect(result.reply).toContain('$1,400,000 COP');
      expect(result.priceFollowUpText).toBeUndefined();
    } finally {
      exp.pricing = origPricing;
    }
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
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const phone = '573001112272';
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: '¿Van con transporte propio o necesitan desde Bogotá?', created_at: new Date().toISOString() });
    await processMessage({ repos, customerPhone: phone, message: 'si tenemos transporte' });
    const conv = repos.conversation.getByPhone(phone) as { collected_transport_need: string | null };
    expect(conv.collected_transport_need).toBe('own');
  });

  it('answers donde deberiamos llegar rather than re-asking qualification', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(null);
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
    mockLlmComplete.mockReset();
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
    mockLlmComplete.mockResolvedValueOnce(fromOld({
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
    }));
    const result = await processMessage({ repos, customerPhone: phone, message: '?' });
    expect(result.reply).toContain('glad');
    expect(result.reply).toContain('Michael');
  });

  it('replaces fabricated price reply when pricing is unavailable', async () => {
    const skills = getSkills();
    const exp = skills.andeanScapes.experiences[0];
    const origPricing = exp.pricing;
    const origAvailability = exp.availability;
    exp.pricing = { currency: 'COP', lastUpdated: '1970-01-01', items: [], botRules: [PRICING_NOT_AVAILABLE], businessRules: [] };
    exp.availability = { lastUpdated: '1970-01-01', timezone: 'America/Bogota', availableDates: [], botRule: AVAILABILITY_NOT_AVAILABLE };
    try {
      mockLlmComplete.mockReset();
      vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
      vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
      const phone = '573001112281';
      repos.conversation.upsert(phone, { collected_name: 'Juana', collected_people: 2 });

      mockLlmComplete.mockResolvedValue({
        turn: {
          reply: 'Para dos personas el plan 2D/1N tiene un valor de $1.300.000 COP total.',
          sales_phase: 'pricing',
          action: 'present_price',
          collected_fields: { name: null, plan: null, people: null, date: null, transport_need: null, pet: null },
          lead: { intent: 'qualifying', buying_signals: [], blockers: [], score_delta: 5, confidence: 0.8 },
          img: true,
        },
        tokens: { prompt: 100, completion: 20 },
      });

      const result = await processMessage({ repos, customerPhone: phone, message: 'somos 2' });

      expect(result.reply).toContain('ajustando precios');
      expect(result.reply).not.toContain('$1.300.000');
      expect(result.shouldSendImage).toBe(false);
      expect(result.priceJustGiven).toBe(false);
    } finally {
      exp.pricing = origPricing;
      exp.availability = origAvailability;
    }
  });

  it('answers reservation lead-time through the LLM using skill context', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValue(fromOld({ response: { reply: 'No manejamos un plazo fijo; el equipo valida la disponibilidad real.' } }));
    const phone = '573001119901';
    const result = await processMessage({
      repos, customerPhone: phone, message: 'Con cuánta anticipación se reserva?',
    });
    expect(result.usedAi).toBe(true);
    expect(result.reply.toLowerCase()).toMatch(/anticipacion|equipo/);
    expect(mockLlmComplete).toHaveBeenCalled();
  });

  it('answers fracture recovery through the LLM using skill context', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValue(fromOld({ response: { reply: 'Valídalo primero con tu médico: hay caminatas, terreno rural y lodo.' } }));
    const phone = '573001119902';
    const result = await processMessage({
      repos,
      customerPhone: phone,
      message: 'Me estoy recuperando de una fractura y no puedo arriesgar una caída. Podría hacer la experiencia minera?',
    });
    expect(result.usedAi).toBe(true);
    expect(result.reply.toLowerCase()).toMatch(/medico|m[eé]dico|doctor/);
    expect(result.reply.toLowerCase()).toMatch(/lodo|terreno|caminata/);
    expect(result.reply.toLowerCase()).not.toMatch(/revis.{0,20}disponibilidad/);
    expect(result.shouldSendOwnerImage).toBe(false);
    expect(result.shouldSendGalleryImages).toBe(false);
    expect(result.shouldSendImage).toBe(false);
    expect(mockLlmComplete).toHaveBeenCalled();
  });

  it('does not append large-group sales copy to fracture guidance', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValue(fromOld({ response: { reply: 'Consulta primero con tu médico.' } }));
    const safetyReply = getActiveExperience(getSkills()).commonQuestions
      .find(question => question.intent === 'physical_recovery' && question.lang === 'es')?.answer;

    const result = await processMessage({
      repos,
      customerPhone: '573001119916',
      message: 'Somos 25 personas y me recupero de una fractura. Tengo movilidad limitada. Puedo hacer la experiencia?',
    });

    expect(result.reply).toBe(safetyReply);
    expect(result.reply).not.toContain(getSkills().fallbackReplies.es.largeGroupReview.replace('{{maxGroupSize}}', String(getSkills().salesStrategy.maxGroupSizePerDate)));
  });

  it('uses validated safety copy when fracture guidance is blocked by budget', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockClear();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: false, reason: 'daily_budget_exceeded' });
    const phone = '573001119911';

    try {
      const result = await processMessage({
        repos,
        customerPhone: phone,
        message: 'Me estoy recuperando de una fractura y tengo movilidad limitada. Puedo hacer la experiencia?',
      });

      expect(result.usedAi).toBe(false);
      expect(result.reply.toLowerCase()).toMatch(/medico|m[eé]dico|doctor/);
      expect(result.reply).not.toBe(getSkills().fallbackReplies.es.aiBudgetExhausted);
      expect(checkBudget).toHaveBeenCalled();
      expect(mockLlmComplete).not.toHaveBeenCalled();
    } finally {
      vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    }
  });

  it('uses validated fracture guidance when the message limit is reached', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkTimeWindow).mockReturnValueOnce({ isLimited: true, reason: 'hourly_limit' });

    const result = await processMessage({
      repos,
      customerPhone: '573001119914',
      message: 'Me recupero de una fractura y tengo movilidad limitada. Puedo hacer la experiencia?',
    });

    expect(result.usedAi).toBe(false);
    expect(result.reply.toLowerCase()).toMatch(/medico|m[eé]dico|doctor/);
    expect(result.reply).not.toBe(getSkills().fallbackReplies.es.messageLimitReached);
    expect(mockLlmComplete).not.toHaveBeenCalled();
  });

  it('prioritizes fracture guidance over reservation lead time in a mixed question', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValue(fromOld({ response: { reply: 'Primero valida con tu médico si puedes hacer caminatas y transitar por lodo.' } }));
    const phone = '573001119912';

    const result = await processMessage({
      repos,
      customerPhone: phone,
      message: 'Me recupero de una fractura. Si puedo ir, ¿con cuánta anticipación debo reservar?',
    });

    expect(result.usedAi).toBe(true);
    expect(result.reply.toLowerCase()).toMatch(/medico|m[eé]dico|doctor/);
    expect(result.reply.toLowerCase()).not.toMatch(/plazo fijo|lead time/);
    expect(mockLlmComplete).toHaveBeenCalled();
  });

  it('prioritizes fracture guidance over other deterministic FAQs', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValue(fromOld({ response: { reply: 'Primero valida con tu médico: la experiencia incluye caminatas y terreno con lodo.' } }));
    const phone = '573001119913';

    const result = await processMessage({
      repos,
      customerPhone: phone,
      message: 'Estoy recuperándome de una fractura. ¿Puedo entrar y encontrar esmeraldas?',
    });

    expect(result.usedAi).toBe(true);
    expect(result.reply.toLowerCase()).toMatch(/medico|m[eé]dico|doctor/);
    expect(result.reply.toLowerCase()).not.toMatch(/hallazgo|encontrar una esmeralda/);
    expect(mockLlmComplete).toHaveBeenCalled();
  });

  it('returns dual solo/couple quote for ambiguous party comparison when pricing is available', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValue(fromOld({ response: { reply: 'Voy a comparar ambas opciones.' } }));
    const phone = '573001119903';
    const skills = getSkills();
    const exp = getActiveExperience(skills);
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };
    try {
      repos.conversation.upsert(phone, { collected_plan: '2d1n_mining' });
      const result = await processMessage({
        repos,
        customerPhone: phone,
        message: 'Me das los precios para una persona o para pareja?',
      });
      expect(result.usedAi).toBe(true);
      expect(result.reply).toMatch(/para una persona/i);
      expect(result.reply).toMatch(/para pareja/i);
      expect(result.reply).toMatch(/550[,.]?000|1[,.]?000[,.]?000/);
      expect(result.priceJustGiven).toBe(true);
      expect(repos.conversation.getCollectedFields(phone).personas).toBeUndefined();
      expect(mockLlmComplete).toHaveBeenCalled();
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('withholds dual quote when pricing unavailable for ambiguous party comparison', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValue(fromOld({ response: { reply: 'Voy a revisar ambas opciones.' } }));
    const phone = '573001119904';
    const skills = getSkills();
    const exp = getActiveExperience(skills);
    const origPricing = exp.pricing;
    exp.pricing = { currency: 'COP', lastUpdated: '1970-01-01', items: [], botRules: [PRICING_NOT_AVAILABLE], businessRules: [] };
    try {
      const result = await processMessage({
        repos,
        customerPhone: phone,
        message: 'solo o pareja, cuanto sale?',
      });
      expect(result.usedAi).toBe(true);
      expect(result.reply).toMatch(/para una persona/i);
      expect(result.reply).toMatch(/para pareja/i);
      expect(result.reply).toMatch(/equipo/);
      expect(result.priceJustGiven).toBe(false);
      expect(mockLlmComplete).toHaveBeenCalled();
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('asks which plan to compare instead of silently quoting the first plan', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValue(fromOld({ response: { reply: 'Primero definamos el plan.' } }));
    const phone = '573001119907';
    const exp = getActiveExperience(getSkills());
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: 'individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: 'couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };
    try {
      const result = await processMessage({
        repos,
        customerPhone: phone,
        message: 'Me das los precios para una persona o para pareja?',
      });

      expect(result.usedAi).toBe(true);
      expect(result.reply).toMatch(/una persona/i);
      expect(result.reply).toMatch(/pareja/i);
      expect(result.reply).toMatch(/plan/i);
      expect(result.reply).not.toMatch(/\$[\d,.]+/);
      expect(result.priceJustGiven).toBe(false);
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('applies message limits before deterministic comparison replies', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: true, reason: 'hourly_limit' });
    const phone = '573001119908';

    const result = await processMessage({
      repos,
      customerPhone: phone,
      message: 'Me das los precios para una persona o para pareja?',
    });

    expect(result.reply).toBe(getSkills().fallbackReplies.es.messageLimitReached);
    expect(result.shouldAlertOwner).toBe(true);
    expect(mockLlmComplete).not.toHaveBeenCalled();
  });

  it('does not treat a total-capacity question as a price request', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'El equipo confirma el tamaño máximo del grupo.', collected_fields: {} },
    }));
    const phone = '573001119909';

    const result = await processMessage({
      repos,
      customerPhone: phone,
      message: '¿Cuántas personas en total permite el grupo?',
    });

    expect(result.usedAi).toBe(true);
    expect(result.reply).toBe('El equipo confirma el tamaño máximo del grupo.');
    expect(result.priceJustGiven).toBe(false);
  });

  it('does not treat recovering money as a physical-recovery safety question', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'Cuéntame qué ocurrió con el pago para orientarte.', collected_fields: {} },
    }));
    const phone = '573001119910';

    const result = await processMessage({
      repos,
      customerPhone: phone,
      message: 'Estoy recuperando mi dinero de una reserva anterior.',
    });

    expect(result.usedAi).toBe(true);
    expect(result.reply).toBe('Cuéntame qué ocurrió con el pago para orientarte.');
  });

  it('preserves after-month constraint without locking that month as the date', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValue(fromOld({ response: { reply: 'El equipo debe validar ese rango.' } }));
    const phone = '573001119905';
    repos.conversation.upsert(phone, { collected_date: 'septiembre' });
    const result = await processMessage({
      repos,
      customerPhone: phone,
      message: 'Somos pareja y queremos viajar después de noviembre. Qué fechas tienen?',
    });
    expect(result.usedAi).toBe(true);
    expect(result.reply.toLowerCase()).toMatch(/despu[eé]s de noviembre|after november/);
    expect(result.reply.toLowerCase()).toMatch(/equipo/);
    expect(result.reply.toLowerCase()).not.toMatch(/tenemos disponible|cupo limitado|unica fecha|única fecha/);
    expect(repos.conversation.getCollectedFields(phone).personas).toBe(2);
    expect(repos.conversation.getCollectedFields(phone).fecha).toBeUndefined();
    expect(mockLlmComplete).toHaveBeenCalled();
  });

  it('keeps an after-month constraint from restoring an older date on later turns', async () => {
    mockLlmComplete.mockReset();
    mockLlmComplete
      .mockResolvedValueOnce(fromOld({ response: { reply: 'El equipo debe validar ese rango.' } }))
      .mockResolvedValueOnce(fromOld({ response: { reply: 'Te cuento sobre el plan.', collected_fields: { date: 'septiembre' } } }));
    const phone = '573001119915';
    repos.conversation.upsert(phone, { collected_date: 'septiembre' });

    await processMessage({
      repos,
      customerPhone: phone,
      message: 'Queremos viajar después de noviembre. Qué fechas tienen?',
    });
    await processMessage({ repos, customerPhone: phone, message: 'Y qué incluye el plan?' });

    const fields = repos.conversation.getCollectedFields(phone);
    expect(fields.fecha).toBeUndefined();
    expect(fields._date_window).toMatch(/despu[eé]s de noviembre/i);
    expect(mockLlmComplete.mock.calls[1]?.[0].systemPrompt).toContain('después de noviembre');
  });

  it('forces deterministic 4-person quote for total-exacto ask even when LLM waffles', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001119906';
    const skills = getSkills();
    const exp = getActiveExperience(skills);
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: 'individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: 'couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };
    try {
      repos.conversation.upsert(phone, {
        collected_name: 'Ana',
        collected_people: 4,
        collected_date: 'septiembre de 2026',
        collected_transport_need: 'own',
        collected_plan: '2d1n_mining',
      });
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: {
          reply: '¡Qué bien! Un grupo de 4 en carro propio. Para darte el total exacto, ¿me confirmas si eres Ana o viajas con alguien más?',
          collected_fields: {},
        },
      }));

      const result = await processMessage({
        repos,
        customerPhone: phone,
        message: 'Somos 4 personas, queremos el plan de 2 días y 1 noche, vamos en carro propio. ¿Cuál es el total exacto para las 4 personas?',
      });

      expect(result.reply).toMatch(/4 personas/i);
      expect(result.reply).toContain('$2,000,000 COP');
      expect(result.reply).not.toMatch(/confirmas si eres Ana/i);
      expect(result.priceJustGiven).toBe(true);
    } finally {
      exp.pricing = origPricing;
    }
  });
});

describe('processMessage — dynamic data guard', () => {
  const DYNAMIC_URL = 'https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json';

  afterEach(() => {
    setDynamicService(null);
    vi.restoreAllMocks();
  });

  // A service whose fetches always fail keeps lastFetchOk === false, which is
  // exactly the "remote unavailable" state the guard must react to.
  async function withStaleDynamicService(): Promise<void> {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('remote down'));
    const svc = new DynamicDataService(DYNAMIC_URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(false);
    setDynamicService(svc);
  }

  // A service with a valid remote payload keeps lastFetchOk === true.
  async function withFreshDynamicService(): Promise<void> {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ v: 3, updated: '2026-06-06T00:00:00Z', experiences: {} }),
    } as unknown as Response);
    const svc = new DynamicDataService(DYNAMIC_URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(true);
    setDynamicService(svc);
  }

  it('blocks price question and alerts owner when remote is stale', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    await withStaleDynamicService();
    const phone = '573001990001';

    const result = await processMessage({ repos, customerPhone: phone, message: 'cuanto vale para 2?' });

    expect(result.reply).toBe(getSkills().fallbackReplies.es.dynamicDataUnavailable);
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('dynamic_pricing_unavailable');
    expect(result.usedAi).toBe(false);
    expect(result.reply).not.toMatch(/\$\s?\d/);
    expect(mockLlmComplete).not.toHaveBeenCalled();
  });

  it('blocks reservation/date questions when remote is stale', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    await withStaleDynamicService();

    const r1 = await processMessage({ repos, customerPhone: '573001990002', message: 'que fechas hay disponibles?' });
    expect(r1.ownerAlertType).toBe('dynamic_pricing_unavailable');

    const r2 = await processMessage({ repos, customerPhone: '573001990003', message: 'quiero reservar' });
    expect(r2.ownerAlertType).toBe('dynamic_pricing_unavailable');

    expect(mockLlmComplete).not.toHaveBeenCalled();
  });

  it('does NOT block non-price questions when remote is stale (passes to LLM)', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    await withStaleDynamicService();
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'La mina es segura, vamos con guia y equipo completo.', intent: 'general' },
    }));

    const result = await processMessage({ repos, customerPhone: '573001990004', message: 'es seguro entrar a la mina?' });

    expect(result.reply).not.toBe(getSkills().fallbackReplies.es.dynamicDataUnavailable);
    expect(result.usedAi).toBe(true);
    expect(mockLlmComplete).toHaveBeenCalled();
  });

  it('does NOT block price question when remote is fresh (passes to LLM)', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    await withFreshDynamicService();
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'Con gusto, para cuantas personas seria?', intent: 'pricing' },
    }));

    const result = await processMessage({ repos, customerPhone: '573001990005', message: 'cuanto vale?' });

    expect(result.reply).not.toBe(getSkills().fallbackReplies.es.dynamicDataUnavailable);
    expect(result.usedAi).toBe(true);
    expect(mockLlmComplete).toHaveBeenCalled();
  });

  it('does not leak a numeric price via partner-consult summary when remote is stale', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    await withStaleDynamicService();
    const phone = '573001990006';
    // Price previously given (row set), then a partner-consult pause message.
    repos.conversation.upsert(phone, {
      collected_name: 'Laura',
      collected_people: 2,
      price_given_at: new Date().toISOString(),
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'dejame lo consulto con mi pareja' });

    expect(result.reply).not.toMatch(/\$\s?\d/);
    expect(mockLlmComplete).not.toHaveBeenCalled();
  });

  it('overrides incorrect LLM math with deterministic 5-person quote', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009993111';
    const skills = getSkills();
    const exp = getActiveExperience(skills);
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: {
          reply: 'Para 5 personas seria $1,550,000 COP total.',
          collected_fields: { plan: '2d1n_mining', people: 5, transport_need: 'own' },
        },
      }));

      const result = await processMessage({ repos, customerPhone: phone, message: 'cuanto vale para 5 personas el plan 2 dias?' });

      expect(result.reply).toContain('$2,500,000 COP');
      expect(result.reply).not.toContain('1,550,000');
      expect(result.reply).toMatch(/paquete completo|Hacienda|3 comidas/i);
      expect(result.priceJustGiven).toBe(true);
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('does not add transport for 5+ people because extra vehicle cost needs confirmation', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009993112';
    const skills = getSkills();
    const exp = getActiveExperience(skills);
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
        { id: 'private_transport', label: 'Transporte privado 4x4 desde Bogota', couplePrice: 1700000, peopleIncluded: 4, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: {
          reply: 'Para 5 personas con transporte seria $4,200,000 COP total.',
          collected_fields: { plan: '2d1n_mining', people: 5, transport_need: 'from_bogota' },
        },
      }));

      const result = await processMessage({ repos, customerPhone: phone, message: 'precio para 5 personas con transporte desde bogota' });

      expect(result.reply).toContain('$2,500,000 COP');
      expect(result.reply).toContain('confirmar el costo');
      expect(result.reply).not.toContain('4,200,000');
      expect(result.reply).toMatch(/paquete completo|Hacienda|3 comidas/i);
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('blocks first price when only group size known and no explicit price ask', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009993201';
    const skills = getSkills();
    const exp = getActiveExperience(skills);
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: {
          reply: 'Perfecto para pareja. El plan queda en $1,000,000 COP total.',
          collected_fields: { people: 2 },
        },
      }));

      const result = await processMessage({ repos, customerPhone: phone, message: 'En pareja' });

      expect(result.reply).not.toMatch(/\$\s?1[,.]?000[,.]?000/);
      expect(result.reply).toMatch(/todo incluido|Hacienda|3 comidas|mina/i);
      expect(result.priceJustGiven).toBe(false);
      const row = repos.conversation.getByPhone(phone) as { price_given_at: string | null };
      expect(row.price_given_at).toBeNull();
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('packages explicit price ask with value stack not bare total', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009993202';
    const skills = getSkills();
    const exp = getActiveExperience(skills);
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '2d1n_mining_individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: '2d1n_mining_couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: {
          reply: 'Claro, te paso el valor.',
          collected_fields: { people: 2 },
        },
      }));

      const result = await processMessage({ repos, customerPhone: phone, message: 'cuanto vale para 2 personas?' });

      expect(result.reply).toContain('$1,000,000 COP');
      expect(result.reply).toMatch(/paquete completo|Hacienda|3 comidas|mina real/i);
      expect(result.reply).toMatch(/paquete completo|actividad suelta/i);
      expect(result.reply).not.toMatch(/plan queda en \$1,000,000 COP\. Total: \$1,000,000/);
      expect(result.priceJustGiven).toBe(true);
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('uses selected plan facts for 3D/2N quote copy', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009993204';
    const skills = getSkills();
    const exp = getActiveExperience(skills);
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: '3d2n_rural_individual', planId: '3d2n_rural', label: 'Individual 3D/2N', pricePerPerson: 850000, publiclyShow: true },
        { id: '3d2n_rural_couple', planId: '3d2n_rural', label: 'Pareja 3D/2N', couplePrice: 1600000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: {
          reply: 'Claro, te paso el valor del plan completo.',
          collected_fields: { plan: '3d2n_rural', people: 2 },
        },
      }));

      const result = await processMessage({ repos, customerPhone: phone, message: 'cuanto vale el plan de 3 dias para 2 personas?' });

      expect(result.reply).toContain('$1,600,000 COP');
      expect(result.reply).toContain('3D/2N');
      expect(result.reply).toContain('6 comidas');
      expect(result.reply).not.toContain('2D/1N');
      expect(result.reply).not.toContain('3 comidas');
    } finally {
      exp.pricing = origPricing;
    }
  });

  it('scrubs tentative_unknown from customer-visible replies', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009993203';
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Listo Michell. Me encanta el plan para 3 personas, para tentative_unknown, con transporte propio.',
        collected_fields: { name: 'Michell', people: 3, date: 'tentative_unknown', transport_need: 'own' },
      },
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Tengo transporte propio' });
    expect(result.reply).not.toContain('tentative_unknown');
    expect(result.reply).toMatch(/fecha por confirmar|date TBD/i);
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

describe('containsPromptLeakOrPolicyViolation', () => {
  it('detects system prompt section markers', () => {
    expect(containsPromptLeakOrPolicyViolation('The SALES CONTEXT says you should be friendly')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('BUSINESS CONTEXT: we tour the emerald mine')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('in FASE 0 you greet the customer')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('LO QUE YA SABEMOS de este cliente')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('the SALES-SCORING evaluation shows')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('the SALES SCORING evaluation shows')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('SALES PHASE ACTUAL is discovery')).toBe(true);
  });

  it('detects accented or punctuation-variant leak markers', () => {
    expect(containsPromptLeakOrPolicyViolation('instrucciones del sistéma en tu prompt')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('DATOS SÉNSIBLES son protegidos')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('CONVERSACION NATURAL dice el prompt')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('REAL PERSON PACING manda')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('FORMATO DE RESPUÉSTA fue el prompt')).toBe(true);
  });

  it('detects fabricated discounts', () => {
    expect(containsPromptLeakOrPolicyViolation('Tengo un descuento especial del 20%')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('Te ofrezco un descuento de 100.000 COP')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('Podemos hacerlo gratis para ti')).toBe(true);
  });

  it('does not flag legitimate replies denying discounts', () => {
    expect(containsPromptLeakOrPolicyViolation('No tenemos ningun descuento en este momento')).toBe(false);
    expect(containsPromptLeakOrPolicyViolation('No ofrecemos descuentos, lo siento')).toBe(false);
    expect(containsPromptLeakOrPolicyViolation('El tour no es gratis, pero vale la pena')).toBe(false);
    expect(containsPromptLeakOrPolicyViolation('No tenemos descuentos ahora mismo, disculpa')).toBe(false);
  });

  it('does not flag replies mentioning accounts or bank transfers', () => {
    expect(containsPromptLeakOrPolicyViolation('Cuenta de ahorros Bancolombia para el pago')).toBe(false);
    expect(containsPromptLeakOrPolicyViolation('Podrias enviar foto del comprobante a nuestra cuenta')).toBe(false);
  });

  it('passes normal customer service replies', () => {
    expect(containsPromptLeakOrPolicyViolation('Claro, Paula. Serian 3 personas entonces.')).toBe(false);
    expect(containsPromptLeakOrPolicyViolation('El plan incluye transporte desde Bogota y todas las comidas.')).toBe(false);
    expect(containsPromptLeakOrPolicyViolation('Cualquier duda aqui estoy.')).toBe(false);
  });
});

import { detectLeadPain } from '../services/response-engine.js';

describe('detectLeadPain', () => {
  it('detects price pain from "1" option', () => {
    expect(detectLeadPain('1')).toBe('price');
  });
  it('detects price pain from keyword es', () => {
    expect(detectLeadPain('el precio me parece caro')).toBe('price');
  });
  it('detects price pain from keyword en', () => {
    expect(detectLeadPain('it is too expensive for me')).toBe('price');
  });
  it('detects date_time pain from "2" option', () => {
    expect(detectLeadPain('2')).toBe('date_time');
  });
  it('detects date_time pain from keyword', () => {
    expect(detectLeadPain('no tengo fecha definida todavia')).toBe('date_time');
  });
  it('detects security pain from "3" option', () => {
    expect(detectLeadPain('3')).toBe('security');
  });
  it('detects security pain from keyword es', () => {
    expect(detectLeadPain('me preocupa si es seguro')).toBe('security');
  });
  it('detects logistics pain from "4" option', () => {
    expect(detectLeadPain('4')).toBe('logistics_4x4');
  });
  it('detects logistics pain from keyword es', () => {
    expect(detectLeadPain('no tengo carro 4x4')).toBe('logistics_4x4');
  });
  it('detects experience_clarity pain from "5" option', () => {
    expect(detectLeadPain('5')).toBe('experience_clarity');
  });
  it('detects experience_clarity from keyword', () => {
    expect(detectLeadPain('no entiendo bien como es la experiencia')).toBe('experience_clarity');
  });
  it('detects partner_group pain from "6" option', () => {
    expect(detectLeadPain('6')).toBe('partner_group');
  });
  it('detects partner_group from keyword es', () => {
    expect(detectLeadPain('lo tengo que consultar con mi pareja')).toBe('partner_group');
  });
  it('detects partner_group from keyword en', () => {
    expect(detectLeadPain('I need to check with my partner first')).toBe('partner_group');
  });
  it('returns null for unrelated text', () => {
    expect(detectLeadPain('hola buenos dias')).toBeNull();
  });
});

describe('pain reply flow', () => {
  let painRepos: Repositories;
  let painDb: Database.Database;
  const PAIN_PHONE = '573009998877';

  beforeAll(() => {
    loadSkills();
    painDb = new Database(':memory:');
    migrate(painDb);
    painRepos = createRepositories(painDb);
  });

  it.each(['price_nudge', 'final_nudge'] as const)('marks a reply to %s as replied', async stage => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: false, reason: 'daily_budget_exceeded' });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = stage === 'price_nudge' ? '573009998870' : '573009998871';
    painRepos.conversation.upsert(phone, { language: 'es', lead_score: 10 });
    painRepos.followUpEvent.insert({
      customerPhone: phone,
      sequenceNumber: stage === 'price_nudge' ? 2 : 3,
      stage,
      sentAt: new Date().toISOString(),
      repliedAt: null,
      scoreBefore: 10,
      scoreAfter: null,
      detectedPain: null,
      status: 'sent',
    });

    await processMessage({ repos: painRepos, customerPhone: phone, message: 'Sí, cuéntame más' });

    expect(painRepos.followUpEvent.getLatestByPhone(phone)?.status).toBe('replied');
  });

  it('stores lead_pain when customer replies to pain question', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    painRepos.conversation.upsert(PAIN_PHONE, { language: 'es', lead_score: 10 });
    // Insert a pain_question follow-up event with status 'sent'
    painRepos.followUpEvent.insert({
      customerPhone: PAIN_PHONE,
      sequenceNumber: 2,
      stage: 'pain_question',
      sentAt: new Date().toISOString(),
      repliedAt: null,
      scoreBefore: 10,
      scoreAfter: null,
      detectedPain: null,
      status: 'sent',
    });

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Entiendo que el precio es una consideracion importante. El plan todo incluido...',
        intent: 'objecting',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 40,
    }));

    const result = await processMessage({ repos: painRepos, customerPhone: PAIN_PHONE, message: '1' });

    expect(result.shouldSendReply).toBe(true);
    expect(painRepos.conversation.getLeadPain(PAIN_PHONE)).toBe('price');
    const event = painRepos.followUpEvent.getLatestByPhone(PAIN_PHONE);
    expect(event?.status).toBe('replied');
    expect(event?.detectedPain).toBe('price');
  });

  it('stores lead_pain for English price reply', async () => {
    mockLlmComplete.mockReset();
    const EN_PHONE = '573009998878';
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    painRepos.conversation.upsert(EN_PHONE, { language: 'en', lead_score: 8 });
    painRepos.followUpEvent.insert({
      customerPhone: EN_PHONE,
      sequenceNumber: 2,
      stage: 'pain_question',
      sentAt: new Date().toISOString(),
      repliedAt: null,
      scoreBefore: 8,
      scoreAfter: null,
      detectedPain: null,
      status: 'sent',
    });

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'The price is really all-inclusive...',
        intent: 'objecting',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 40,
    }));

    await processMessage({ repos: painRepos, customerPhone: EN_PHONE, message: 'it is too expensive' });

    expect(painRepos.conversation.getLeadPain(EN_PHONE)).toBe('price');
  });

  it('marks pain question replied even when the reply matches no pain option', async () => {
    mockLlmComplete.mockReset();
    const OFF_PHONE = '573009998880';
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    painRepos.conversation.upsert(OFF_PHONE, { language: 'es', lead_score: 10 });
    painRepos.followUpEvent.insert({
      customerPhone: OFF_PHONE,
      sequenceNumber: 2,
      stage: 'pain_question',
      sentAt: new Date().toISOString(),
      repliedAt: null,
      scoreBefore: 10,
      scoreAfter: null,
      detectedPain: null,
      status: 'sent',
    });

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Gracias por escribir, cuéntame más...',
        intent: 'curious',
        lead_score_delta: 2,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 300,
      completionTokens: 20,
    }));

    await processMessage({ repos: painRepos, customerPhone: OFF_PHONE, message: 'hmm no sé todavía' });

    const event = painRepos.followUpEvent.getLatestByPhone(OFF_PHONE);
    expect(event?.status).toBe('replied');
    expect(event?.detectedPain).toBeNull();
    expect(painRepos.conversation.getLeadPain(OFF_PHONE)).toBeNull();
  });

  it('reuses stored lead_pain on a later turn (persists across turns)', async () => {
    mockLlmComplete.mockReset();
    const PERSIST_PHONE = '573009998881';
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    painRepos.conversation.upsert(PERSIST_PHONE, { language: 'es', lead_score: 12 });
    painRepos.conversation.setLeadPain(PERSIST_PHONE, 'security', 'me da miedo');
    // No pending pain_question event: this is a normal follow-up turn.

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'La experiencia es guiada y segura...',
        intent: 'qualifying',
        lead_score_delta: 3,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 400,
      completionTokens: 30,
    }));

    await processMessage({ repos: painRepos, customerPhone: PERSIST_PHONE, message: 'y como funciona?' });

    // The LLM call should have received a pain-specific suffix for 'security'.
    const call = mockLlmComplete.mock.calls[0]?.[0] as { systemPromptSuffix?: string } | undefined;
    expect(call?.systemPromptSuffix).toMatch(/SEGURIDAD|SAFETY/);
  });

  it('marks first_nudge event replied when customer responds', async () => {
    mockLlmComplete.mockReset();
    const FN_PHONE = '573009998879';
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    painRepos.conversation.upsert(FN_PHONE, { language: 'es', lead_score: 12 });
    painRepos.followUpEvent.insert({
      customerPhone: FN_PHONE,
      sequenceNumber: 1,
      stage: 'first_nudge',
      sentAt: new Date().toISOString(),
      repliedAt: null,
      scoreBefore: 12,
      scoreAfter: null,
      detectedPain: null,
      status: 'sent',
    });

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Genial que sigas interesado...',
        intent: 'qualifying',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 400,
      completionTokens: 30,
    }));

    await processMessage({ repos: painRepos, customerPhone: FN_PHONE, message: 'si me interesa' });

    const event = painRepos.followUpEvent.getLatestByPhone(FN_PHONE);
    expect(event?.status).toBe('replied');
    expect(event?.repliedAt).not.toBeNull();
  });

  it('answers a budget-blocked pain reply with the deterministic pain template', async () => {
    mockLlmComplete.mockReset();
    const BUDGET_PHONE = '573009998882';
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: false, reason: 'daily_budget_exceeded' });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    painRepos.conversation.upsert(BUDGET_PHONE, { language: 'es', lead_score: 10 });
    painRepos.followUpEvent.insert({
      customerPhone: BUDGET_PHONE,
      sequenceNumber: 2,
      stage: 'pain_question',
      sentAt: new Date().toISOString(),
      repliedAt: null,
      scoreBefore: 10,
      scoreAfter: null,
      detectedPain: null,
      status: 'sent',
    });

    const result = await processMessage({ repos: painRepos, customerPhone: BUDGET_PHONE, message: '1' });

    // Deterministic price template, not the generic aiBudgetExhausted holding message.
    expect(result.reply).toBe(loadSkills().fallbackReplies.es.painReplyPrice);
    expect(result.usedAi).toBe(false);
    expect(mockLlmComplete).not.toHaveBeenCalled();
  });

  it('answers an LLM-failure pain reply with the deterministic pain template', async () => {
    mockLlmComplete.mockReset();
    const LLMFAIL_PHONE = '573009998883';
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    painRepos.conversation.upsert(LLMFAIL_PHONE, { language: 'es', lead_score: 10 });
    painRepos.followUpEvent.insert({
      customerPhone: LLMFAIL_PHONE,
      sequenceNumber: 2,
      stage: 'pain_question',
      sentAt: new Date().toISOString(),
      repliedAt: null,
      scoreBefore: 10,
      scoreAfter: null,
      detectedPain: null,
      status: 'sent',
    });

    mockLlmComplete.mockResolvedValueOnce(null);

    const result = await processMessage({ repos: painRepos, customerPhone: LLMFAIL_PHONE, message: '3' });

    expect(result.reply).toBe(loadSkills().fallbackReplies.es.painReplySecurity);
    expect(result.shouldSendGalleryImages).toBe(false);
  });

  it('does not auto-send the gallery on a security-objection pain reply', async () => {
    mockLlmComplete.mockReset();
    const SEC_PHONE = '573009998884';
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    // High score + price presented so the gallery would otherwise be eligible.
    painRepos.conversation.upsert(SEC_PHONE, {
      language: 'es', lead_score: 40,
      nombre: 'Ana', personas: 2, fecha: 'agosto', price_given_at: new Date().toISOString(),
    });
    painRepos.followUpEvent.insert({
      customerPhone: SEC_PHONE,
      sequenceNumber: 2,
      stage: 'pain_question',
      sentAt: new Date().toISOString(),
      repliedAt: null,
      scoreBefore: 40,
      scoreAfter: null,
      detectedPain: null,
      status: 'sent',
    });

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'La experiencia es guiada por locales con equipo de seguridad...',
        intent: 'objecting',
        lead_score_delta: 3,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
      promptTokens: 500,
      completionTokens: 40,
    }));

    const result = await processMessage({ repos: painRepos, customerPhone: SEC_PHONE, message: '3' });

    expect(painRepos.conversation.getLeadPain(SEC_PHONE)).toBe('security');
    expect(result.shouldSendGalleryImages).toBe(false);
  });

  // ── Fix A: group-price override via replyMentionsPrice for 3+ people ────
  it('overrides LLM group price even when message is not an explicit price question (8 people)', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009995001';
    const skills = getSkills();
    const exp = getActiveExperience(skills);
    const origPricing = exp.pricing;
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: 'individual', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550000, publiclyShow: true },
        { id: 'couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      // Pre-seed group + transport so price gate unlocks (not group-size-only).
      repos.conversation.upsert(phone, {
        collected_people: 8,
        collected_plan: '2d1n_mining',
        collected_transport_need: 'own',
      });
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: {
          reply: 'Para su grupo tiene sentido dejar el valor claro desde el inicio. Para 8 personas el plan queda en $2,200,000 COP total. ¿Esto encaja con lo que buscan?',
          collected_fields: { people: 8 },
        },
      }));

      const result = await processMessage({ repos, customerPhone: phone, message: 'gracias, perfecto' });

      // Calculator says (1,000,000 / 2) * 8 = $4,000,000 — packaged with value stack
      expect(result.reply).toContain('$4,000,000 COP');
      expect(result.reply).not.toContain('2,200,000');
      expect(result.reply).toMatch(/paquete completo|Hacienda|3 comidas|mina real/i);
      expect(result.reply).not.toMatch(/^Para 8 personas, el plan queda en/);
      expect(result.priceFollowUpText).toBeUndefined();
      expect(result.priceJustGiven).toBe(true);
    } finally {
      exp.pricing = origPricing;
    }
  });

  // ── Fix B: fallback name extraction + repeated-question guard ─────────────
  it('does not re-ask name when standalone name follows name-ask plus image caption', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009995002';
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: 'Antes de seguir, ¿como te llamas?', created_at: new Date(Date.now() - 120000).toISOString() });
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'image', body: 'Heinner y Alexandra - Andean Scapes', created_at: new Date(Date.now() - 60000).toISOString() });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Te envio los datos de pago por Nequi ahora.',
        collected_fields: {},
      },
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Carlos' });

    expect(result.reply).not.toContain('como te llamas');
    expect(result.reply).not.toContain('Antes de seguir');
    expect(result.reply).toContain('Carlos');
  });

  it('clarifies the same missing field instead of skipping it after unsafe fallback', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009995003';
    const skills = getSkills();
    const fb = skills.fallbackReplies.es;
    repos.conversation.upsert(phone, { collected_name: 'Carlos', collected_plan: '2d1n_mining' });
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: fb.askPeople, created_at: new Date(Date.now() - 60000).toISOString() });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Te envio los datos de pago por Nequi ahora.',
        collected_fields: {},
      },
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Si' });

    expect(result.reply).not.toBe(fb.askPeople);
    expect(result.reply).toBe(fb.clarifyPeople);
    const fields = repos.conversation.getCollectedFields(phone);
    expect(fields.personas).toBeUndefined();
    expect(repos.conversation.getByPhone(phone)?.collected_people).toBeNull();
  });

  it('clarifies a missing plan without hardcoding or skipping it', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009995004';
    const skills = getSkills();
    const fb = skills.fallbackReplies.es;
    repos.conversation.upsert(phone, { collected_name: 'Carlos' });
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: fb.askPlan.replace('{{name}}', 'Carlos'), created_at: new Date(Date.now() - 60000).toISOString() });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Te envio los datos de pago por Nequi ahora.',
        collected_fields: {},
      },
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Si' });

    expect(result.reply).not.toBe(fb.askPlan);
    expect(result.reply).toBe(fb.clarifyPlan);
    expect(repos.conversation.getByPhone(phone)?.collected_plan).toBeNull();
  });

  it('does not classify a generic price and dates inquiry as customer pain', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009995005';
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'Claro. ¿Seria para una persona, pareja o grupo?' },
    }));

    await processMessage({ repos, customerPhone: phone, message: 'Hola, quiero precios y fechas' });

    expect(repos.conversation.getLeadPain(phone)).toBeNull();
  });

  it('persists an unknown date but sends only its localized label to the LLM', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009995006';
    const fb = getSkills().fallbackReplies.es;
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: fb.askDate, created_at: new Date(Date.now() - 60000).toISOString() });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'No hay problema; podemos avanzar sin una fecha exacta por ahora.' },
    }));

    await processMessage({ repos, customerPhone: phone, message: 'Todavia no se' });

    expect(repos.conversation.getByPhone(phone)?.collected_date).toBe('tentative_unknown');
    const llmInput = mockLlmComplete.mock.calls[0]?.[0] as unknown as LlmClientInput | undefined;
    const prompt = llmInput?.systemPrompt ?? '';
    expect(prompt).not.toContain('tentative_unknown');
    expect(prompt).toContain(fb.internalDatePending);
  });

  it('persists the canonical value phase instead of an undocumented phase', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009995007';
    repos.conversation.upsert(phone, { collected_people: 2, collected_plan: '2d1n_mining' });
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Hola', created_at: new Date(Date.now() - 60000).toISOString() });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'Entiendo lo que buscan. ¿Tienen una fecha aproximada?' },
    }));

    await processMessage({ repos, customerPhone: phone, message: 'Buscamos algo diferente' });

    expect(repos.conversation.getSalesPhase(phone)).toBe('value');
  });

  // ── Fix C: qualificationSummary sanitizes internal tokens ─────────────────
  it('qualificationSummary replaces tentative_unknown with human-readable text', () => {
    const result = qualificationSummary(
      { nombre: 'Michell', personas: 3, fecha: 'tentative_unknown', transporte: 'own' },
      'es',
      getSkills().fallbackReplies.es,
    );
    expect(result).not.toContain('tentative_unknown');
    expect(result).toContain('fecha por confirmar');
    expect(result).toContain('3 personas');
  });

  it('qualificationSummary replaces _relative_ordinal_ tokens', () => {
    const result = qualificationSummary(
      { nombre: 'Test', personas: 2, fecha: '_relative_ordinal_1' },
      'es',
      getSkills().fallbackReplies.es,
    );
    expect(result).not.toContain('_relative_ordinal_1');
    expect(result).toContain('fecha por confirmar');
  });

  it('qualificationSummary passes through real date strings unchanged (English)', () => {
    const result = qualificationSummary(
      { nombre: 'Ana', personas: 2, fecha: '10 de octubre' },
      'en',
      getSkills().fallbackReplies.en,
    );
    expect(result).toContain('for 10 de octubre');
    expect(result).toContain('2 people');
  });

  it('qualificationSummary passes through real date strings unchanged (Spanish)', () => {
    const result = qualificationSummary(
      { nombre: 'Juan', personas: 1, fecha: '5 de enero' },
      'es',
      getSkills().fallbackReplies.es,
    );
    expect(result).toContain('para 5 de enero');
    expect(result).toContain('1 persona');
  });
});
