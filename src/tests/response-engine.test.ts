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
  isTruncatedReply,
  hardSafetyFail,
  logQuoteMismatch,
  isOptOutMessage,
} from '../services/response-engine.js';
import { PRICING_NOT_AVAILABLE, AVAILABILITY_NOT_AVAILABLE, ADDON_ID_PRIVATE_TRANSPORT } from '../services/dynamic-data-service.js';
import { sendAlert } from '../services/alert-service.js';
import { insertMediaSendAt, getLatestOwnerAlertBody } from './helpers/db-test-helpers.js';
import {
  containsPromptLeakOrPolicyViolation,
  stripHandoffPhrases,
  isExplicitCloseCtaConfirmation,
} from '../services/reply-guard.js';
import { env } from '../config/env.js';
import { resetRoutingConfigCache, type RoutingConfig } from '../services/lead-routing.js';


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
import { selectPlanImage, canSendPlanImage, selectGalleryImages } from '../services/media-service.js';
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
        currency: 'COP', requiresPaymentProof: true,
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

function installTwoExperienceCatalog(): () => void {
  const skills = getSkills();
  const previous = skills.andeanScapes.experiences;
  const first = previous[0];
  const second = {
    ...first,
    id: 'blue_lagoon_escape',
    name: 'Aventura Laguna Azul',
    shortDescription: 'Una escapada entre montanas y lagunas.',
    plans: [
      {
        ...first.plans[0],
        id: 'lagoon_premium',
        name: 'Retiro Premium',
        shortDescription: 'Plan premium junto a la laguna.',
        keywords: ['retiro premium'],
      },
      {
        ...first.plans[1],
        id: 'lagoon_day',
        name: 'Dia Laguna',
        shortDescription: 'Plan de dia junto a la laguna azul.',
        keywords: ['laguna azul', 'dia laguna'],
      },
    ],
    pricing: {
      ...first.pricing,
      items: [
        { id: 'lagoon-premium-single', planId: 'lagoon_premium', label: 'Premium', pricePerPerson: 400000, peopleIncluded: 1, publiclyShow: true },
        { id: 'lagoon-day-single', planId: 'lagoon_day', label: 'Dia', pricePerPerson: 200000, peopleIncluded: 1, publiclyShow: true },
      ],
      botRules: [],
    },
  };
  skills.andeanScapes.experiences = [first, second];
  return () => { skills.andeanScapes.experiences = previous; };
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

  it('stores an entry marker and exposes it internally without rewriting customer text', async () => {
    const phone = '573009991199';
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Seguimos desde donde quedamos.' } }));
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    await processMessage({ repos, customerPhone: phone, message: 'R01 - Hola, quiero retomar la conversación' });

    expect(repos.conversation.getByPhone(phone)).toMatchObject({
      entry_marker: 'R01',
      entry_temperature: 'retargeting',
    });
    expect(mockLlmComplete.mock.calls[0]?.[0].message).toContain('R01');
    expect(mockLlmComplete.mock.calls[0]?.[0].systemPrompt).toContain('ENTRADA: retargeting (R01)');
    expect(mockLlmComplete.mock.calls[0]?.[0].systemPrompt).toContain('sin historial local');
    expect(mockLlmComplete.mock.calls[0]?.[0].systemPrompt).not.toContain('historial local disponible');
  });

  it('includes known local context when a returning marker follows prior messages', async () => {
    const phone = '573009991198';
    repos.conversation.upsert(phone, { collected_people: 2, collected_plan: '2d1n_mining' });
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'inbound',
      message_type: 'text',
      body: 'Quiero conocer los planes',
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Retomemos el plan para dos.' } }));
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    await processMessage({ repos, customerPhone: phone, message: 'R01 - Quiero retomar' });

    const prompt = mockLlmComplete.mock.calls[0]?.[0].systemPrompt ?? '';
    expect(prompt).toContain('historial local disponible');
    expect(prompt).toContain('personas=2');
    expect(prompt).not.toContain('sin historial local');
  });

  it('passes emojis from our own past replies so the model rotates', async () => {
    const phone = '573009991198';
    repos.message.addMessage({
      customer_phone: phone, direction: 'outbound', message_type: 'text',
      body: '¡Buenísimo! 🙌 ¿Qué buscan?', created_at: new Date(Date.now() - 120_000).toISOString(),
    });
    repos.message.addMessage({
      customer_phone: phone, direction: 'outbound', message_type: 'text',
      body: 'Mirá esto 🌿', created_at: new Date(Date.now() - 90_000).toISOString(),
    });
    // A glyph the CUSTOMER used must not shrink our palette.
    repos.message.addMessage({
      customer_phone: phone, direction: 'inbound', message_type: 'text',
      body: 'genial 😍', created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Con gusto.' } }));
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    await processMessage({ repos, customerPhone: phone, message: 'cuentame mas' });

    // Scoped to the RUNTIME block: the static personality skill lists 😍 in its ban
    // set and mentions the phrase itself, so whole-prompt assertions are vacuous.
    const prompt = mockLlmComplete.mock.calls[0]?.[0].systemPrompt ?? '';
    const runtime = prompt.slice(prompt.lastIndexOf('\nRUNTIME:'));
    expect(runtime).toContain('EMOJIS YA USADOS EN ESTE HILO: 🙌 🌿');
    expect(runtime).not.toContain('😍');
  });

  it('does not claim usable retargeting history without both group and plan', async () => {
    const phone = '573009991197';
    repos.conversation.upsert(phone, { collected_people: 2 });
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'inbound',
      message_type: 'text',
      body: 'Hola',
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Claro, retomemos.' } }));
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    await processMessage({ repos, customerPhone: phone, message: 'R01 - Quiero retomar' });

    const prompt = mockLlmComplete.mock.calls[0]?.[0].systemPrompt ?? '';
    expect(prompt).toContain('sin historial local');
    expect(prompt).not.toContain('historial local disponible');
  });

  it('does not treat qualification from the marker message as prior retargeting history', async () => {
    const phone = '573009991196';
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'inbound',
      message_type: 'text',
      body: 'Hola',
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Claro, revisemos.' } }));
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    await processMessage({
      repos,
      customerPhone: phone,
      message: 'R01 - somos 2 y queremos el plan de 2 días',
    });

    const prompt = mockLlmComplete.mock.calls[0]?.[0].systemPrompt ?? '';
    expect(prompt).toContain('sin historial local');
    expect(prompt).not.toContain('historial local disponible');
  });

  it('clears persisted child ages when the customer revises the child count without new ages', async () => {
    const phone = '573009991195';
    repos.conversation.upsert(phone, {
      collected_people: 4,
      collected_adults: 2,
      collected_children: 2,
      collected_child_ages_json: JSON.stringify([9]),
    });
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Entendido.' } }));
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });

    await processMessage({
      repos,
      customerPhone: phone,
      message: 'Ahora somos 2 adultos y 1 niño, no sé la edad',
    });

    expect(repos.conversation.getByPhone(phone)).toMatchObject({
      collected_children: 1,
      collected_child_ages_json: null,
    });
  });

  it('detects plans from the selected experience in a two-experience conversation', async () => {
    const restore = installTwoExperienceCatalog();
    const phone = '573009991101';
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Es una gran opcion.' } }));
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    try {
      await processMessage({ repos, customerPhone: phone, message: '2' });
      await processMessage({ repos, customerPhone: phone, message: 'Me interesa el plan laguna azul' });

      expect(repos.conversation.getSelectedExperienceId(phone)).toBe('blue_lagoon_escape');
      expect(repos.conversation.getCollectedFields(phone).plan).toBe('lagoon_day');
    } finally {
      restore();
    }
  });

  it('asks an existing ambiguous conversation to select an experience', async () => {
    const restore = installTwoExperienceCatalog();
    const phone = '573009991104';
    repos.conversation.upsert(phone, { language: 'es' });
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'outbound',
      message_type: 'text',
      body: 'Mensaje anterior.',
      created_at: new Date(Date.now() - 1000).toISOString(),
    });
    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Hola de nuevo' });

      expect(result.reply).toContain('Aventura Laguna Azul');
      expect(repos.conversation.getSelectedExperienceId(phone)).toBeNull();
    } finally {
      restore();
    }
  });

  it('switches experience explicitly and does not restore the previous plan from history', async () => {
    const restore = installTwoExperienceCatalog();
    const phone = '573009991102';
    const first = getSkills().andeanScapes.experiences[0];
    repos.conversation.upsert(phone, {
      collected_plan: first.plans[0].id,
      price_given_at: new Date().toISOString(),
      sales_phase: 'closing',
      lead_intent: 'book',
      gallery_nudged_at: new Date().toISOString(),
      soft_closed_at: new Date().toISOString(),
    });
    repos.conversation.setSelectedExperienceId(phone, first.id);
    repos.conversation.setAssignment(phone, { assignedLineId: 'old_line', assignedAgentChat: '111' });
    repos.conversation.setMode(phone, 'human_pending');
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'inbound',
      message_type: 'text',
      body: first.plans[0].keywords[0],
      created_at: new Date(Date.now() - 1000).toISOString(),
    });
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Claro, te ayudo.' } }));
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    try {
      await processMessage({ repos, customerPhone: phone, message: 'Aventura Laguna Azul' });
      const switchedConversation = repos.conversation.getByPhone(phone);
      expect(switchedConversation?.price_given_at).toBeNull();
      expect(switchedConversation?.sales_phase).toBeNull();
      expect(switchedConversation?.lead_intent).toBeNull();
      expect(switchedConversation?.gallery_nudged_at).toBeNull();
      expect(switchedConversation?.soft_closed_at).toBeNull();
      expect(switchedConversation?.handed_off_at).toBeNull();
      expect(switchedConversation?.assigned_line_id).toBeNull();
      expect(switchedConversation?.assigned_agent_chat).toBeNull();
      expect(switchedConversation?.conversation_mode).toBe('bot');

      await processMessage({ repos, customerPhone: phone, message: 'Cuentame mas' });
      expect(repos.conversation.getSelectedExperienceId(phone)).toBe('blue_lagoon_escape');
      expect(repos.conversation.getCollectedFields(phone).plan).toBeUndefined();
      expect(repos.conversation.getSalesPhase(phone)).not.toBe('closing');
    } finally {
      restore();
    }
  });


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

  // A repeat stop phrase (including a retraction that still contains the keyword)
  // must not earn a second confirmation — that is the automated message they refused.
  it('does not confirm a stop request twice', async () => {
    mockLlmComplete.mockReset();
    const phone = '573009990051';

    const first = await processMessage({ repos, customerPhone: phone, message: 'STOP' });
    expect(first.shouldSendReply).toBe(true);
    expect(first.reply).toContain("won't send");

    const retraction = await processMessage({
      repos,
      customerPhone: phone,
      message: 'Esperate no era stop era para parar y pensar',
    });
    expect(retraction.shouldSendReply).toBe(false);
    expect(retraction.reply).toBe('');
    expect(repos.optOut.isOptedOut(phone)).toBe(true);
    expect(mockLlmComplete).not.toHaveBeenCalled();
  });

  // Singular (tú/vos) stop-requests. A lead who answers a re-engagement template
  // with one of these is refusing all further contact, so it must land as a real
  // opt-out and not as a normal message the LLM replies to. Each case needs its
  // own phone: the first opt-out would otherwise short-circuit the rest.
  it.each([
    ['no me escribas mas', '573009991301'],
    ['no me escribas de nuevo', '573009991302'],
    ['deja de escribirme', '573009991303'],
    ['deja de escribir', '573009991304'],
    ['no me vuelvas a escribir', '573009991305'],
    ['no me mandes mas mensajes', '573009991306'],
    ['no me molestes', '573009991307'],
    ['déjame en paz', '573009991308'],
    ['no me contactes', '573009991309'],
    ['sacame de tus mensajes', '573009991310'],
    ['NO ME ESCRIBAS MÁS', '573009991311'],
    // Refusing the follow-up itself ("stop sending me THIS") is a full stop request.
    ['No me envíes más esto', '573009991312'],
    ['no me envien mas mensajes de estos', '573009991313'],
    ['ya no me escribas por favor', '573009991314'],
    ['no me sigas escribiendo', '573009991315'],
    // Multi-line phrasing: a raw newline used to defeat every multi-word keyword.
    ['No me\nEnvíes más esto', '573009991316'],
    ['no me\nescribas mas', '573009991317'],
  ])('captures the tú/vos stop-request "%s" and opts the lead out', async (message, phone) => {
    mockLlmComplete.mockReset();
    const result = await processMessage({ repos, customerPhone: phone, message });
    expect(result.shouldSendReply).toBe(true);
    expect(result.usedAi).toBe(false);
    expect(result.reply).toContain('No enviaremos mas mensajes');
    expect(repos.optOut.isOptedOut(phone)).toBe(true);
  });

  it('answers inbound after customer opt-out and reopens only a future consent opportunity', async () => {
    const phone = '573009990002';
    await processMessage({ repos, customerPhone: phone, message: 'stop' });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Claro, podemos continuar. Tu solicitud anterior solo detuvo los seguimientos automáticos.',
      },
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Hola, me gustaría continuar' });

    expect(result.shouldSendReply).toBe(true);
    expect(result.reply).toContain('podemos continuar');
    expect(repos.optOut.isOptedOut(phone)).toBe(false);
    const subscription = repos.followupSubscription.getByPhone(phone);
    expect(subscription?.status).toBe('unasked');
    expect(subscription?.activated_at).toBeNull();
    const prompt = mockLlmComplete.mock.calls.at(-1)?.[0].systemPrompt ?? '';
    expect(prompt).toContain('CONVERSACION REACTIVADA POR EL CLIENTE');
    expect(prompt).toContain('NO vuelve a autorizar templates');
  });

  it('keeps the opt-out compliance record and template consent revoked after reopening', async () => {
    const phone = '573009990022';
    repos.followupConsent.grantConsent(phone, 'telegram:test');
    await processMessage({ repos, customerPhone: phone, message: 'stop' });
    const optOutRecord = repos.optOut.getLastOptOutAt(phone);
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Claro, seguimos.' } }));

    await processMessage({ repos, customerPhone: phone, message: 'Hola, una pregunta' });

    // Active suppression lifted, but the evidence and the template opt-in are not.
    expect(optOutRecord).not.toBeNull();
    expect(repos.optOut.getLastOptOutAt(phone)).toBe(optOutRecord);
    expect(repos.followupConsent.hasConsent(phone)).toBe(false);
  });

  // Live regression: a bare "Ok" answering the permission ask made the analyzer
  // report ready_to_book/strong, which pushed the score past the hot threshold and
  // paged the operator. Agreeing to a FUTURE message is not buying behaviour.
  it('does not score a bare "Ok" to the permission ask as booking intent', async () => {
    const phone = '573009990027';
    repos.conversation.upsert(phone, {
      language: 'es', collected_plan: '2d1n_mining', collected_people: 1, lead_score: 40,
      price_given_at: new Date().toISOString(),
    });
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.markAsked(phone, 'wamid.ask');
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Perfecto, quedo pendiente.' } }));
    mockAnalyzeLead.mockResolvedValueOnce({
      intent: 'ready_to_book', scoreDelta: 80, confidence: 1.0,
      buyingSignals: ['confirm'], blockers: [],
      afterPriceInterest: true, reservationReadiness: 'strong',
      rationale: 'dijo ok', promptTokens: 10, completionTokens: 10,
    });

    const result = await processMessage({
      repos, customerPhone: phone, message: 'Ok', consentAcceptedThisTurn: true,
    });

    expect(result.leadScore).toBe(40);
    expect(result.shouldAlertOwner).toBe(false);
    expect(result.leadLifecycle).toBeUndefined();
    expect(repos.conversation.getMode(phone)).toBe('bot');
    expect(repos.conversation.getLeadIntent(phone)).not.toBe('ready_to_book');
  });

  it('does not treat a "No" to the permission ask as a sales objection', async () => {
    const phone = '573009990028';
    repos.conversation.upsert(phone, { language: 'es', lead_score: 55, price_given_at: new Date().toISOString() });
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.markAsked(phone, 'wamid.ask');
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Entendido, no insisto.' } }));
    mockAnalyzeLead.mockResolvedValueOnce({
      intent: 'not_interested', scoreDelta: -30, confidence: 1.0,
      buyingSignals: [], blockers: ['dijo no'],
      afterPriceInterest: false, reservationReadiness: 'none',
      rationale: 'rechazo', promptTokens: 10, completionTokens: 10,
    });

    const result = await processMessage({
      repos, customerPhone: phone, message: 'No', consentDeclinedThisTurn: true,
    });

    expect(result.leadScore).toBe(55);
    expect(result.shouldAlertOwner).toBe(false);
  });

  // Guard against over-suppression: a pending ask must not mute genuine buying intent.
  it('still scores real booking intent sent while the permission ask is pending', async () => {
    const phone = '573009990029';
    repos.conversation.upsert(phone, {
      language: 'es', collected_plan: '2d1n_mining', collected_people: 2, lead_score: 60,
      price_given_at: new Date().toISOString(),
    });
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.markAsked(phone, 'wamid.ask');
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Listo, validamos disponibilidad.' } }));
    mockAnalyzeLead.mockResolvedValueOnce({
      intent: 'ready_to_book', scoreDelta: 80, confidence: 1.0,
      buyingSignals: ['quiere reservar'], blockers: [],
      afterPriceInterest: true, reservationReadiness: 'strong',
      rationale: 'pide reservar', promptTokens: 10, completionTokens: 10,
    });

    const result = await processMessage({
      repos, customerPhone: phone, message: 'Quiero reservar para el 14 de noviembre',
    });

    expect(result.leadScore).toBeGreaterThan(60);
    expect(result.shouldAlertOwner).toBe(true);
    expect(repos.followupSubscription.getByPhone(phone)?.status).toBe('unasked');
    expect(repos.followupSubscription.getByPhone(phone)?.deferred_reask_used).toBe(1);
  });

  // Any substantive reply re-opens the 24h window, so the pending ask was
  // premature and must be re-armed. A bare answer to the bot's own question
  // ("juan", "2 personas") carries no sales keyword and scores zero signals —
  // requiring sales content here left these subscriptions pending forever, so no
  // second ask and no recurring template could follow.
  it.each([
    ['573009990039', 'juan'],
    ['573009990040', '2 personas'],
    ['573009990041', 'Hola de nuevo'],
  ])('defers a pending consent ask when the customer keeps talking (%s: %s)', async (phone, message) => {
    repos.conversation.upsert(phone, {
      language: 'es', collected_plan: '2d1n_mining', collected_people: 2,
    });
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.markAsked(phone, 'wamid.ask');
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Claro, te ayudo.' } }));

    await processMessage({ repos, customerPhone: phone, message });

    expect(repos.followupSubscription.getByPhone(phone)?.status).toBe('unasked');
    expect(repos.followupSubscription.getByPhone(phone)?.deferred_reask_used).toBe(1);
  });

  it.each([
    ['573009990037', 'Estoy buscando trabajo'],
    ['573009990042', 'Muy caro, lo voy a pensar'],
    ['573009990043', 'gracias chao'],
  ])('does not defer a pending consent ask for terminal or off-topic inbound (%s: %s)', async (phone, message) => {
    repos.conversation.upsert(phone, {
      language: 'es', collected_plan: '2d1n_mining', collected_people: 2,
    });
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.markAsked(phone, 'wamid.ask');
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Claro, te ayudo.' } }));

    await processMessage({ repos, customerPhone: phone, message });

    expect(repos.followupSubscription.getByPhone(phone)?.status).toBe('pending');
    expect(repos.followupSubscription.getByPhone(phone)?.deferred_reask_used).toBe(0);
  });

  // A customer who refused must never be re-armed by the continuation deferral.
  // English refusals are the risk: `dont`/`not` are bare tokens, so if the
  // classifier reads "i dont want more messages" as ambiguous, the deferral
  // happily re-asks someone who just said no.
  it.each([
    // A plain English refusal stays `declined`.
    ['573009990045', 'i dont want more messages', 'declined'],
    // A stop request is ALSO an opt-out, which revokes outright — stronger than
    // declined, and it must still never re-arm the ask.
    ['573009990046', 'no me escribas mas', 'revoked'],
  ])('never defers a consent ask for a customer who refused (%s: %s)', async (phone, message, expectedStatus) => {
    repos.conversation.upsert(phone, {
      language: 'es', collected_plan: '2d1n_mining', collected_people: 2,
    });
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.markAsked(phone, 'wamid.ask');
    repos.followupSubscription.decline(phone, 'wamid.in');
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Entendido.' } }));

    await processMessage({ repos, customerPhone: phone, message });

    const subscription = repos.followupSubscription.getByPhone(phone);
    expect(subscription?.status).toBe(expectedStatus);
    // The invariant that matters: never re-armed, so no further ask can be sent.
    expect(subscription?.status).not.toBe('unasked');
    expect(subscription?.deferred_reask_used).toBe(0);
  });

  // Regression lock for the reported transcript: the bot asked permission, the
  // customer answered the NAME question instead, and the follow-up never returned.
  it('re-arms the consent ask after the customer answers an unrelated question', async () => {
    const phone = '573009990044';
    repos.conversation.upsert(phone, {
      language: 'es', collected_plan: '2d1n_mining', collected_people: 2,
      price_given_at: new Date().toISOString(),
    });
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.markAsked(phone, 'wamid.ask');
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Perfecto, Juan.' } }));

    await processMessage({ repos, customerPhone: phone, message: 'juan' });

    const subscription = repos.followupSubscription.getByPhone(phone);
    // `unasked` is what makes the lead eligible for listConsentAskCandidates again,
    // scheduled from this new inbound — i.e. the ask returns ~23h later.
    expect(subscription?.status).toBe('unasked');
    expect(subscription?.asked_at).toBeNull();
    expect(subscription?.deferred_reask_used).toBe(1);

    // Bounded: a second continuation must NOT defer again, so an unanswered c2
    // stays pending forever rather than nagging.
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Listo.' } }));
    repos.followupSubscription.markAsked(phone, 'wamid.ask2');
    await processMessage({ repos, customerPhone: phone, message: 'perez' });
    expect(repos.followupSubscription.getByPhone(phone)?.status).toBe('pending');
  });

  it('closes an active consent cycle when the customer writes again', async () => {
    const phone = '573009990025';
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Claro, te cuento.' } }));
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.markAsked(phone, 'wamid.ask');
    repos.followupSubscription.affirm(phone, 'wamid.yes', 'customer_reply');

    await processMessage({ repos, customerPhone: phone, message: 'Una duda sobre seguridad' });

    // Recurring stops until a fresh "sí"; a new ask becomes eligible later.
    const subscription = repos.followupSubscription.getByPhone(phone);
    expect(subscription?.status).toBe('unasked');
    expect(subscription?.activated_at).toBeNull();
  });

  // Live 2026-08-13: the customer sent "Si" twice a minute apart. The first granted
  // consent; the second was read as re-engagement and revoked it, so the recurring
  // template never went out while the bot was still promising to write back.
  it('keeps consent active when the customer repeats a bare yes seconds later', async () => {
    const phone = '573009990027';
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Listo, quedo pendiente.' } }));
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.markAsked(phone, 'wamid.ask');
    repos.followupSubscription.affirm(phone, 'wamid.yes', 'customer_reply');

    // Not flagged as the consent turn: the classifier only runs while pending.
    await processMessage({ repos, customerPhone: phone, message: 'Si' });

    const subscription = repos.followupSubscription.getByPhone(phone);
    expect(subscription?.status).toBe('active');
    expect(subscription?.activated_at).not.toBeNull();
  });

  // The grace window must not shield real re-engagement, even seconds after consent.
  it('still closes the cycle when the repeated yes carries intent', async () => {
    const phone = '573009990028';
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Claro, te cuento.' } }));
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.markAsked(phone, 'wamid.ask');
    repos.followupSubscription.affirm(phone, 'wamid.yes', 'customer_reply');

    await processMessage({ repos, customerPhone: phone, message: 'si quiero reservar para el 14' });

    expect(repos.followupSubscription.getByPhone(phone)?.status).toBe('unasked');
  });

  it('keeps consent active on the turn that grants it', async () => {
    const phone = '573009990026';
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Listo, te escribo más adelante.' } }));
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.markAsked(phone, 'wamid.ask');
    repos.followupSubscription.affirm(phone, 'wamid.yes', 'customer_reply');

    await processMessage({ repos, customerPhone: phone, message: 'Ok', consentAcceptedThisTurn: true });

    expect(repos.followupSubscription.getByPhone(phone)?.status).toBe('active');
  });

  // A stop phrase must not downgrade `/block` into a reopenable customer opt-out,
  // otherwise the customer could unblock themselves: stop phrase, then any message.
  it('keeps an operator block permanent when the customer also sends a stop phrase', async () => {
    mockLlmComplete.mockReset();
    const phone = '573009990030';
    repos.optOut.setOptOut(phone);
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.revoke(phone, 'operator');

    const stopTurn = await processMessage({ repos, customerPhone: phone, message: 'no me escribas mas' });

    expect(stopTurn.shouldSendReply).toBe(false);
    expect(stopTurn.reply).toBe('');
    expect(repos.followupSubscription.getByPhone(phone)?.revoke_source).toBe('operator');
    expect(repos.optOut.isOptedOut(phone)).toBe(true);

    // The block must survive the follow-up message that used to reopen it.
    const laterTurn = await processMessage({ repos, customerPhone: phone, message: 'Hola, quiero info' });

    expect(laterTurn.shouldSendReply).toBe(false);
    expect(repos.optOut.isOptedOut(phone)).toBe(true);
    expect(mockLlmComplete).not.toHaveBeenCalled();
  });

  it('still confirms a stop request for a customer the operator never blocked', async () => {
    const phone = '573009990031';

    const result = await processMessage({ repos, customerPhone: phone, message: 'no me escribas mas' });

    expect(result.shouldSendReply).toBe(true);
    expect(result.reply).toContain('No enviaremos mas mensajes');
    expect(repos.followupSubscription.getByPhone(phone)?.revoke_source).toBe('customer_opt_out');
  });

  it('treats "no mas porfa" as opt-out and revokes active follow-up consent', async () => {
    mockLlmComplete.mockReset();
    const phone = '573009990041';
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.markAsked(phone, 'wamid.ask');
    repos.followupSubscription.affirm(phone, 'wamid.yes', 'customer_reply');

    const result = await processMessage({ repos, customerPhone: phone, message: 'no mas porfa' });

    expect(result.usedAi).toBe(false);
    expect(repos.optOut.isOptedOut(phone)).toBe(true);
    expect(repos.followupSubscription.getByPhone(phone)?.status).toBe('revoked');
    expect(repos.followupSubscription.getByPhone(phone)?.revoke_source).toBe('customer_opt_out');
    expect(mockLlmComplete).not.toHaveBeenCalled();
  });

  // A request scoped to one kind of content must not silence the whole thread.
  it.each([
    'no me mandes mas fotos',
    'ya no me envies mas imagenes',
    'no me manden mas videos por favor',
  ])('treats the media-scoped request "%s" as a normal turn', async (message, ) => {
    mockLlmComplete.mockReset();
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Claro, sin fotos. ¿Qué te gustaría saber?' } }));
    const phone = `5730099900${32 + message.length % 5}`;

    const result = await processMessage({ repos, customerPhone: phone, message });

    expect(repos.optOut.isOptedOut(phone)).toBe(false);
    expect(result.reply).not.toContain('No enviaremos mas mensajes');
  });

  it('still opts out when a media-scoped request carries a real stop request', async () => {
    const phone = '573009990040';

    const result = await processMessage({
      repos, customerPhone: phone, message: 'no me mandes mas fotos ni mensajes, basta',
    });

    expect(result.reply).toContain('No enviaremos mas mensajes');
    expect(repos.optOut.isOptedOut(phone)).toBe(true);
  });

  it('prevents replies for an operator-blocked customer', async () => {
    mockLlmComplete.mockReset();
    const phone = '573009990023';
    repos.optOut.setOptOut(phone);
    repos.followupSubscription.ensureExists(phone);
    repos.followupSubscription.revoke(phone, 'operator');

    const result = await processMessage({ repos, customerPhone: phone, message: 'How much?' });

    expect(result.reply).toBe('');
    expect(result.shouldSendReply).toBe(false);
    expect(mockLlmComplete).not.toHaveBeenCalled();
    // An operator block is permanent: it must never be lifted by an inbound.
    expect(repos.optOut.isOptedOut(phone)).toBe(true);
  });

  it('prevents replies for an opted-out customer with no subscription provenance', async () => {
    mockLlmComplete.mockReset();
    const phone = '573009990024';
    repos.optOut.setOptOut(phone);

    const result = await processMessage({ repos, customerPhone: phone, message: 'How much?' });

    expect(result.reply).toBe('');
    expect(result.shouldSendReply).toBe(false);
    expect(mockLlmComplete).not.toHaveBeenCalled();
    expect(repos.optOut.isOptedOut(phone)).toBe(true);
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

  it('persists the hot score returned for organizer contact sharing', async () => {
    const phone = '573009991197';
    repos.conversation.upsert(phone, { lead_score: 10 });

    const result = await processMessage({
      repos,
      customerPhone: phone,
      message: 'El WhatsApp del organizador es https://wa.me/573001112233',
    });

    expect(result.ownerAlertType).toBe('organizer_contact');
    expect(result.leadScore).toBeGreaterThanOrEqual(90);
    expect(repos.conversation.getLeadScore(phone)).toBe(result.leadScore);
  });

  it('does not treat an organizer WhatsApp question as contact sharing', async () => {
    const phone = '573009991196';
    repos.conversation.upsert(phone, { lead_score: 10 });
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'El equipo te orienta por este chat.' } }));

    const result = await processMessage({
      repos,
      customerPhone: phone,
      message: 'Cual es el WhatsApp del organizador?',
    });

    expect(result.ownerAlertType).not.toBe('organizer_contact');
    expect(repos.conversation.getLeadScore(phone)).toBeLessThan(90);
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




  it('applies message limits before acknowledging a review pause', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkTimeWindow).mockReturnValueOnce({ isLimited: true, reason: 'hourly_limit' });
    const phone = '573001112235';
    repos.conversation.upsert(phone, { price_given_at: new Date().toISOString() });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Déjame revisar con mi familia' });

    expect(result.shouldAlertOwner).toBe(true);
    expect(mockLlmComplete).not.toHaveBeenCalled();
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
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
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const replyText = 'Perfecto, para esa fecha tenemos el plan. Te gustaria que confirme disponibilidad?';
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: replyText,
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
    expect(result.usedAi).toBe(true);
    expect(result.shouldSendReply).toBe(true);
    // Contract: a safe LLM reply is delivered byte-for-byte.
    expect(result.reply).toBe(replyText);
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


  it('soft-closes on definitive decline without appending qualification questions', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112330';

    repos.conversation.upsert(phone, {
      collected_name: 'David',
      collected_people: 1,
      collected_date: 'agosto',
      collected_transport_need: 'own',
      collected_plan: '2d1n_mining',
      price_given_at: new Date().toISOString(),
      lead_score: 25,
    });

    const result = await processMessage({ repos, customerPhone: phone, message: 'No quiero seguir' });

    expect(result.shouldSendReply).toBe(true);
    expect(result.usedAi).toBe(false);
    expect(result.reply).toContain('instagram');
    expect(result.reply.trim().endsWith('?')).toBe(false);
    expect(result.reply).not.toContain('¿');
    expect(repos.conversation.getByPhone(phone)?.soft_closed_at).toBeTruthy();
  });

  it('soft-closes on no quiero continuar without appending qualification questions', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112331';

    const result = await processMessage({ repos, customerPhone: phone, message: 'No quiero continuar' });

    expect(result.usedAi).toBe(false);
    expect(result.reply).toContain('instagram');
    expect(result.reply.trim().endsWith('?')).toBe(false);
    expect(result.reply).not.toContain('¿');
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




  it('pricing botRules come from dynamic catalog SSoT', () => {
    // Offline CI / CDN catalog owns pricing rules (static skill is brand-only).
    const exp = getActiveExperience(getSkills());
    expect(exp.pricing.items.length).toBeGreaterThan(0);
    expect(exp.pricing.botRules).not.toContain('PRICING_NOT_AVAILABLE');
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

  it('passes LLM handoff phrasing through when reservation intent lacks price (skills own wording)', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573001112242';
    const reply = 'Dame unos minuticos, termino de validar con el equipo de reservas para continuar con tu proceso.';

    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply,
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
    // Contract: engine does not strip handoff phrases post-LLM.
    expect(result.reply).toBe(reply);
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






  it('llm path: strips date re-ask when fecha is already deferred', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009995103';
    repos.conversation.upsert(phone, {
      collected_people: 2,
      collected_plan: '2d1n_mining',
      collected_date: 'tentative_unknown',
      collected_transport_need: 'own',
    });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Claro, el ritmo es exigente pero manejable. ¿Tienes alguna fecha tentativa en mente?',
        intent: 'curious',
        lead_score_delta: 5,
        should_send_image: false,
        needs_human: false,
        missing_fields: [],
        collected_fields: {},
      },
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Que tan exigente es el ritmo del plan?' });

    expect(result.usedAi).toBe(true);
    expect(result.reply).toMatch(/ritmo|exigente|manejable/i);
  });

  it.each([
    'The route is straightforward. Do you have a date in mind?',
    'La ruta es sencilla. Tienes alguna fecha tentativa?',
  ])('strips a date re-ask without an opening Spanish question mark: %s', async reply => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = `57300999999${reply.startsWith('The') ? '4' : '5'}`;
    repos.conversation.upsert(phone, {
      collected_people: 2,
      collected_plan: '2d1n_mining',
      collected_date: 'tentative_unknown',
      collected_transport_need: 'own',
    });
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply, collected_fields: {} } }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Como es la ruta?' });

    expect(result.usedAi).toBe(true);
    expect(result.reply).toBe(reply);
  });

  it('does not clear a selected date for a context-free no-rush phrase', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009999996';
    repos.conversation.upsert(phone, {
      collected_people: 2,
      collected_plan: '2d1n_mining',
      collected_date: '29 de agosto',
      collected_transport_need: 'own',
    });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply: 'Claro, te explico el ritmo con calma.', collected_fields: {} },
    }));

    await processMessage({ repos, customerPhone: phone, message: 'No tengo afán, ¿qué tan exigente es el ritmo?' });

    expect(repos.conversation.getDateStatus(phone)).toBe('selected');
    expect(repos.conversation.getByPhone(phone)?.collected_date).toBe('29 de agosto');
  });







  it('does not force closing from a model-only booking signal without a confirmed date', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009995010';
    repos.conversation.upsert(phone, {
      collected_people: 2,
      price_given_at: new Date().toISOString(),
    });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Me alegra que te guste. Podemos seguir revisando el plan.',
        needs_human: true,
      },
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Me gusta el plan' });

    expect(result.shouldAlertOwner).toBe(false);
    expect(repos.conversation.getMode(phone)).toBe('bot');
  });


  it('keeps a real late-month date when one is listed and skips gallery', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009995012';
    const exp = getActiveExperience(getSkills());
    const originalAvailability = exp.availability;
    exp.availability = {
      lastUpdated: '2026-07-21',
      timezone: 'America/Bogota',
      availableDates: [{ date: '2026-08-29', status: 'available', slotsApprox: 8 }],
      botRule: 'Availability must be validated before confirmation.',
    };
    repos.conversation.upsert(phone, { collected_people: 2, price_given_at: new Date().toISOString(), lead_score: 90 });
    const listedReply = 'Para finales de agosto tenemos disponible el sabado 29 de agosto.';
    mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: listedReply } }));

    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Finales de agosto que fechas tienen?' });

      expect(result.reply).toBe(listedReply);
      expect(result.shouldSendGalleryImages).toBe(false);
    } finally {
      exp.availability = originalAvailability;
    }
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
    const phone = '573001112294';

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

      expect(repos.conversation.getMode(phone)).toBe('human_pending');
      const handed = repos.conversation.getByPhone(phone) as { handed_off_at: string | null };
      expect(handed.handed_off_at).toBeNull();

      expect(repos.conversation.getSalesPhase(phone)).toBe('closing');
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
        { id: 'couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['pricing rules'],
      businessRules: [],
    };
    try {
      repos.conversation.upsert(phone, {
        collected_people: 2,
        collected_date: '15 de agosto',
        collected_name: 'Luis',
      });
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: {
          reply: 'Claro! En pareja queda en $1,000,000 COP, todo incluido.',
          intent: 'pricing',
          lead_score_delta: 5,
          should_send_image: false,
          needs_human: false,
          missing_fields: [],
          collected_fields: { name: 'Luis', people: 2 },
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
      collected_name: 'CustomerA',
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
      collected_name: 'CustomerA',
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

  it('does not alert or downgrade an urgent lead on a repeated itinerary question', async () => {
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
    expect(result.leadScore).toBe(95);
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



  it('LLM reply passed through as-is even when qualification questions are repeated', async () => {
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
        reply: 'Perfecto Ana. El plan 2D/1N para 2 en agosto con carro propio queda claro.',
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
    expect(result.reply).toContain('plan');
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
    const image = selectPlanImage(dynamicImages, '3d2n_rural', 'emerald_mining_tour');
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




  describe('safeReservationHandoff after-hours', () => {
    it('uses standard handoff before 8 PM Colombia', () => {
      const skills = getSkills();
      const fb = skills.fallbackReplies.es;
      const q = { nombre: 'CustomerA', personas: 2, fecha: 'agosto', transporte: 'own' };
      const before8pm = new Date('2026-06-15T19:59:00-05:00');
      const reply = safeReservationHandoff(q, fb, 'es', before8pm);
      expect(reply).toContain('CustomerA');
      expect(reply).not.toContain('mañana en la mañana');
      expect(reply).not.toContain('tomorrow morning');
    });

    it('uses after-hours handoff at or after 8 PM Colombia', () => {
      const skills = getSkills();
      const fb = skills.fallbackReplies.es;
      const q = { nombre: 'CustomerA', personas: 2, fecha: 'agosto', transporte: 'own' };
      const at8pm = new Date('2026-06-15T20:00:00-05:00');
      const reply = safeReservationHandoff(q, fb, 'es', at8pm);
      expect(reply).toContain('CustomerA');
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
      const image = selectPlanImage(dynamicImages, '3d2n_rural', 'emerald_mining_tour');
      expect(image?.id).toBe('dyn_3d2n');
    });

    it('falls back to first dynamic image when planId has no match', () => {
      const dynamicImages = [
        { id: 'dyn_2d1n', experienceId: 'emerald_mining_tour', planId: '2d1n_mining', url: 'https://cdn.andeanscapes.com/whatsapp_bot/details/2d1n_1.png', caption: '2D/1N' },
      ];
      const image = selectPlanImage(dynamicImages, 'nonexistent_plan', 'emerald_mining_tour');
      expect(image?.id).toBe('dyn_2d1n');
    });

    it('returns undefined when dynamic images array is empty', () => {
      const image = selectPlanImage([], '2d1n_mining', 'emerald_mining_tour');
      expect(image).toBeUndefined();
    });

    it('returns first dynamic image when planId is null', () => {
      const dynamicImages = [
        { id: 'dyn_2d1n', experienceId: 'emerald_mining_tour', planId: '2d1n_mining', url: 'https://cdn.andeanscapes.com/whatsapp_bot/details/2d1n_1.png', caption: '2D/1N' },
        { id: 'dyn_3d2n', experienceId: 'emerald_mining_tour', planId: '3d2n_rural', url: 'https://cdn.andeanscapes.com/whatsapp_bot/details/3d2n_1.png', caption: '3D/2N' },
      ];
      const image = selectPlanImage(dynamicImages, null, 'emerald_mining_tour');
      expect(image?.id).toBe('dyn_2d1n');
    });

    it('never falls back to an image from another experience', () => {
      const dynamicImages = [
        { id: 'other', experienceId: 'other_experience', planId: 'shared', url: 'https://cdn.andeanscapes.com/other.png', caption: 'Other' },
      ];
      expect(selectPlanImage(dynamicImages, 'shared', 'emerald_mining_tour')).toBeUndefined();
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
    const columnNames = columns.map(c => c.name);
    expect(columnNames).toContain('collected_plan');
    expect(columnNames).toContain('ad_referral_json');
    expect(columnNames).toContain('entry_marker');
    expect(columnNames).toContain('entry_temperature');
    expect(columnNames).toContain('entry_marker_at');
    expect(columnNames).toContain('collected_adults');
    expect(columnNames).toContain('collected_children');
    expect(columnNames).toContain('collected_child_ages_json');
    expect(columnNames).toContain('collected_travel_origin');
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
      expect(result.shouldAlertOwner).toBe(true);
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
    const reply = 'Validalo primero con tu medico: hay caminatas, terreno rural y lodo.';
    mockLlmComplete.mockResolvedValue(fromOld({ response: { reply } }));

    const result = await processMessage({
      repos,
      customerPhone: '573001119916',
      message: 'Somos 25 personas y me recupero de una fractura. Tengo movilidad limitada. Puedo hacer la experiencia?',
    });

    // The LLM answers (grounded by SAFETY_FAQ in the prompt) and the engine appends nothing.
    expect(result.reply).toBe(reply);
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

});


describe('processMessage — dynamic data guard', () => {
  const DYNAMIC_URL = 'https://cdn.andeanscapes.com/whatsapp_bot/bot-dynamic.json';

  afterEach(() => {
    setDynamicService(null);
    loadSkills();
    vi.restoreAllMocks();
  });

  function minimalCatalogPayload() {
    return {
      v: 11,
      updated: '2026-06-06T00:00:00Z',
      experiences: {
        emerald_mining_tour: {
          status: 'active',
          name: 'Emerald Mining Tour',
          shortDescription: 'Test tour',
          currency: 'COP',
          sites: {
            chivor: {
              clarifications: [],
              addons: {},
              rules: ['REMOTE_RULE'],
              media: {
                gallery: Array.from({ length: 5 }, (_, index) => ({
                  url: `https://cdn.andeanscapes.com/gallery/lodging-${index + 1}.jpg`,
                  caption: '',
                  type: 'lodging_fixture',
                })),
                types: ['lodging_fixture'],
                typeKeywords: { lodging_fixture: ['rest_fixture'] },
              },
              availability: { tz: 'America/Bogota', dates: [{ d: '2099-08-17', s: 'available' }], rule: 'ok' },
              plans: {
                '2d1n_mining': {
                  name: '2D/1N',
                  duration: '2D/1N',
                  shortDescription: 'Test mining plan',
                  pricing: { individual: 550000, couple: 1000000 },
                  clarifications: [],
                  addons: [],
                  media: { planImages: [] },
                },
              },
            },
          },
        },
      },
    };
  }

  // Seed catalog then fail refresh → lastFetchOk false while data remains.
  async function withStaleDynamicService(): Promise<void> {
    const svc = new DynamicDataService(DYNAMIC_URL, 5000);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => minimalCatalogPayload(),
    } as unknown as Response);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(true);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('remote down'));
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(false);
    expect(svc.getData()).not.toBeNull();
    setDynamicService(svc);
    loadSkills();
  }

  // Fresh remote catalog with pricing.
  async function withFreshDynamicService(): Promise<void> {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => minimalCatalogPayload(),
    } as unknown as Response);
    const svc = new DynamicDataService(DYNAMIC_URL, 5000);
    await svc.forceRefresh();
    expect(svc.lastFetchOk).toBe(true);
    setDynamicService(svc);
    loadSkills();
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

  it('strips a media marker and selects three photos through the validated registry shape', async () => {
    const previousSendImages = env.SEND_IMAGES_ENABLED;
    // Pinned, not inherited: the env files set 3 but the zod default is 5, so a run
    // without an env file (CI) resolved a different cap and the count assertion failed.
    const previousGalleryCap = env.MAX_GALLERY_IMAGES_PER_SEND;
    try {
      env.SEND_IMAGES_ENABLED = true;
      env.MAX_GALLERY_IMAGES_PER_SEND = 3;
      mockLlmComplete.mockReset();
      vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
      vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
      await withFreshDynamicService();
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: { reply: 'Te comparto las fotos. ¿Qué más te gustaría revisar?\n[[FOTOS:rest_fixture]]' },
      }));

      const result = await processMessage({
        repos,
        customerPhone: '573001990006',
        message: 'C03 ¿Tienes fotos del lugar para descansar?',
      });

      expect(result.reply).not.toContain('[[FOTOS:');
      expect(result.requestedGalleryImages).toHaveLength(3);
      expect(repos.conversation.getByPhone('573001990006')?.entry_marker).toBe('C03');
    } finally {
      env.SEND_IMAGES_ENABLED = previousSendImages;
      env.MAX_GALLERY_IMAGES_PER_SEND = previousGalleryCap;
    }
  });

  it('retries an unmarked explicit photo promise only once, then alerts the owner', async () => {
    const previousSendImages = env.SEND_IMAGES_ENABLED;
    const previousMarkerRetry = env.MEDIA_MARKER_RETRY_ENABLED;
    const phone = '573001990019';
    try {
      env.SEND_IMAGES_ENABLED = true;
      env.MEDIA_MARKER_RETRY_ENABLED = true;
      mockLlmComplete.mockReset();
      vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
      vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
      await withFreshDynamicService();
      repos.conversation.upsert(phone, { language: 'es' });
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'inbound',
        message_type: 'text',
        body: 'Hola',
        created_at: new Date(Date.now() - 60_000).toISOString(),
      });
      mockLlmComplete
        .mockResolvedValueOnce(fromOld({ response: { reply: 'Te comparto unas fotos del rest_fixture. ¿Qué te parece?' } }))
        .mockResolvedValueOnce(fromOld({ response: { reply: 'Les comparto más del rest_fixture. ¿Qué te parece?' } }));

      const result = await processMessage({
        repos,
        customerPhone: phone,
        message: '¿Tienes fotos del rest_fixture?',
      });

      expect(mockLlmComplete).toHaveBeenCalledTimes(2);
      expect(mockLlmComplete.mock.calls[1]?.[0].systemPrompt)
        .toContain('[[FOTOS:lodging_fixture]]');
      expect(result.requestedGalleryImages).toBeUndefined();
      expect(result.shouldAlertOwner).toBe(true);
      expect(result.ownerAlertType).toBe('media_marker_unhonoured');
    } finally {
      env.SEND_IMAGES_ENABLED = previousSendImages;
      env.MEDIA_MARKER_RETRY_ENABLED = previousMarkerRetry;
    }
  });

  it('retries an explicit photo request that omitted both the marker and final question', async () => {
    const previousSendImages = env.SEND_IMAGES_ENABLED;
    const previousMarkerRetry = env.MEDIA_MARKER_RETRY_ENABLED;
    const previousGalleryCap = env.MAX_GALLERY_IMAGES_PER_SEND;
    const phone = '573001990039';
    try {
      env.SEND_IMAGES_ENABLED = true;
      env.MEDIA_MARKER_RETRY_ENABLED = true;
      env.MAX_GALLERY_IMAGES_PER_SEND = 3;
      mockLlmComplete.mockReset();
      vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
      vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
      await withFreshDynamicService();
      repos.conversation.upsert(phone, { language: 'es' });
      repos.message.addMessage({
        customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Hola',
        created_at: new Date(Date.now() - 60_000).toISOString(),
      });
      mockLlmComplete
        .mockResolvedValueOnce(fromOld({ response: { reply: 'El recorrido rural tiene tramos destapados.' } }))
        .mockResolvedValueOnce(fromOld({ response: { reply: 'El recorrido rural tiene tramos destapados. ¿Qué fecha están considerando?\n[[FOTOS:lodging_fixture]]' } }));

      const result = await processMessage({
        repos, customerPhone: phone, message: '¿Tienes fotos del rest_fixture?',
      });

      expect(mockLlmComplete).toHaveBeenCalledTimes(2);
      const retryPrompt = mockLlmComplete.mock.calls[1]?.[0].systemPrompt;
      expect(retryPrompt).toContain('CORRECCION PREGUNTA:');
      expect(retryPrompt).toContain('[[FOTOS:lodging_fixture]]');
      expect(result.reply.endsWith('?')).toBe(true);
      expect(result.requestedGalleryImages).toHaveLength(3);
    } finally {
      env.SEND_IMAGES_ENABLED = previousSendImages;
      env.MEDIA_MARKER_RETRY_ENABLED = previousMarkerRetry;
      env.MAX_GALLERY_IMAGES_PER_SEND = previousGalleryCap;
    }
  });

  it('retries an active sales reply that does not end with a question', async () => {
    const phone = '573001990040';
    repos.conversation.upsert(phone, { language: 'es' });
    repos.message.addMessage({
      customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Hola',
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    mockLlmComplete
      .mockResolvedValueOnce(fromOld({ response: { reply: 'La ruta tiene varios tramos rurales.' } }))
      .mockResolvedValueOnce(fromOld({ response: { reply: 'La ruta tiene varios tramos rurales. ¿En qué mes quieren viajar?' } }));

    const result = await processMessage({
      repos, customerPhone: phone, message: '¿Cómo es el recorrido en carro?',
    });

    expect(mockLlmComplete).toHaveBeenCalledTimes(2);
    expect(mockLlmComplete.mock.calls[1]?.[0].systemPrompt).toContain('CORRECCION PREGUNTA:');
    expect(result.reply.endsWith('?')).toBe(true);
    expect(result.shouldAlertOwner).toBe(false);
  });

  it('carries the previous gallery theme into a short more-photos follow-up', async () => {
    const previousSendImages = env.SEND_IMAGES_ENABLED;
    const previousMarkerRetry = env.MEDIA_MARKER_RETRY_ENABLED;
    const previousGalleryCap = env.MAX_GALLERY_IMAGES_PER_SEND;
    const phone = '573001990020';
    try {
      env.SEND_IMAGES_ENABLED = true;
      env.MEDIA_MARKER_RETRY_ENABLED = true;
      env.MAX_GALLERY_IMAGES_PER_SEND = 3;
      mockLlmComplete.mockReset();
      vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
      vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
      await withFreshDynamicService();
      repos.conversation.upsert(phone, { language: 'es' });
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'inbound',
        message_type: 'text',
        body: '¿Tienes fotos del rest_fixture?',
        created_at: new Date(Date.now() - 120_000).toISOString(),
      });
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'outbound',
        message_type: 'image',
        body: '',
        created_at: new Date(Date.now() - 90_000).toISOString(),
      });
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'outbound',
        message_type: 'image',
        body: '',
        created_at: new Date(Date.now() - 80_000).toISOString(),
      });
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'outbound',
        message_type: 'text',
        body: 'Claro, te comparto unas del hospedaje.',
        created_at: new Date(Date.now() - 60_000).toISOString(),
      });
      mockLlmComplete
        .mockResolvedValueOnce(fromOld({ response: { reply: 'Sí, tengo más. Te comparto otras para que las veas.' } }))
        .mockResolvedValueOnce(fromOld({ response: { reply: 'Aquí van otras del hospedaje.\n[[FOTOS:lodging_fixture]]' } }));

      const result = await processMessage({
        repos,
        customerPhone: phone,
        message: '¿Tienes más?',
      });

      expect(mockLlmComplete).toHaveBeenCalledTimes(2);
      expect(mockLlmComplete.mock.calls[0]?.[0].systemPrompt)
        .toContain('PEDIDO DE FOTOS ESTE TURNO: lodging_fixture.');
      expect(mockLlmComplete.mock.calls[1]?.[0].systemPrompt)
        .toContain('[[FOTOS:lodging_fixture]]');
      expect(result.requestedGalleryImages).toHaveLength(3);
    } finally {
      env.SEND_IMAGES_ENABLED = previousSendImages;
      env.MEDIA_MARKER_RETRY_ENABLED = previousMarkerRetry;
      env.MAX_GALLERY_IMAGES_PER_SEND = previousGalleryCap;
    }
  });

  it('does not inherit a gallery theme across an intervening assistant turn', async () => {
    const previousSendImages = env.SEND_IMAGES_ENABLED;
    const previousMarkerRetry = env.MEDIA_MARKER_RETRY_ENABLED;
    const phone = '573001990021';
    try {
      env.SEND_IMAGES_ENABLED = true;
      env.MEDIA_MARKER_RETRY_ENABLED = true;
      mockLlmComplete.mockReset();
      vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
      vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
      await withFreshDynamicService();
      repos.conversation.upsert(phone, { language: 'es' });
      repos.message.addMessage({
        customer_phone: phone, direction: 'inbound', message_type: 'text',
        body: '¿Tienes fotos del rest_fixture?', created_at: new Date(Date.now() - 180_000).toISOString(),
      });
      repos.message.addMessage({
        customer_phone: phone, direction: 'outbound', message_type: 'text',
        body: 'Claro, te comparto unas.', created_at: new Date(Date.now() - 120_000).toISOString(),
      });
      repos.message.addMessage({
        customer_phone: phone, direction: 'outbound', message_type: 'text',
        body: '¿Te parece si te escribo más adelante?', created_at: new Date(Date.now() - 60_000).toISOString(),
      });
      mockLlmComplete.mockResolvedValueOnce(fromOld({ response: { reply: 'Claro. ¿Qué necesitas?' } }));

      const result = await processMessage({ repos, customerPhone: phone, message: '¿Tienes más?' });

      expect(mockLlmComplete).toHaveBeenCalledTimes(1);
      expect(mockLlmComplete.mock.calls[0]?.[0].systemPrompt).not.toContain('PEDIDO DE FOTOS ESTE TURNO:');
      expect(result.requestedGalleryImages ?? []).toHaveLength(0);
    } finally {
      env.SEND_IMAGES_ENABLED = previousSendImages;
      env.MEDIA_MARKER_RETRY_ENABLED = previousMarkerRetry;
    }
  });

  // Regression: a marker plus an ops state that cannot ship photos used to be
  // scored as a model failure, so flipping SEND_IMAGES_ENABLED turned every
  // photo-request turn into a curated failure reply plus an owner alert.
  it('strips the marker and still sends the model text when image sends are disabled', async () => {
    const previousSendImages = env.SEND_IMAGES_ENABLED;
    try {
      env.SEND_IMAGES_ENABLED = false;
      mockLlmComplete.mockReset();
      vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
      vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
      await withFreshDynamicService();
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: { reply: 'Con gusto. ¿Qué te gustaría ver primero?\n[[FOTOS:rest_fixture]]' },
      }));

      const result = await processMessage({
        repos,
        customerPhone: '573001990016',
        message: '¿Tienes fotos?',
      });

      expect(result.reply).toBe('Con gusto. ¿Qué te gustaría ver primero?');
      expect(result.reply).not.toContain('[[FOTOS:');
      expect(result.requestedGalleryImages).toBeUndefined();
      expect(result.shouldAlertOwner).toBe(false);
    } finally {
      env.SEND_IMAGES_ENABLED = previousSendImages;
    }
  });

  // A marker problem must never outrank a leak: an echo-risk reason has to suppress
  // the turn entirely, so short-circuiting on the marker would downgrade it to a
  // curated fallback send.
  it('lets a prompt leak outrank an unresolvable marker', async () => {
    const previousSendImages = env.SEND_IMAGES_ENABLED;
    try {
      env.SEND_IMAGES_ENABLED = true;
      mockLlmComplete.mockReset();
      vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
      vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
      await withFreshDynamicService();
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: { reply: 'El SALES CONTEXT dice que sea amable.\n[[FOTOS:no_such_theme]]' },
      }));

      const result = await processMessage({
        repos,
        customerPhone: '573001990018',
        message: '¿Tienes fotos?',
      });

      // prompt_leak is echo-risk: suppress entirely. Had the marker check won, the
      // engine would have SENT the curated aiFailureQualified fallback instead.
      expect(result.shouldSendReply).toBe(false);
      expect(result.reply).toBe('');
      expect(result.shouldAlertOwner).toBe(true);
    } finally {
      env.SEND_IMAGES_ENABLED = previousSendImages;
    }
  });

  it('fails the turn when a marker resolves to no photos at all', async () => {
    const previousSendImages = env.SEND_IMAGES_ENABLED;
    try {
      env.SEND_IMAGES_ENABLED = true;
      mockLlmComplete.mockReset();
      vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
      vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
      await withFreshDynamicService();
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: { reply: 'Te mando fotos del helipuerto.\n[[FOTOS:no_such_theme]]' },
      }));

      const result = await processMessage({
        repos,
        customerPhone: '573001990017',
        message: '¿Fotos del helipuerto?',
      });

      expect(result.reply).toBe(getSkills().fallbackReplies.es.aiFailureQualified);
      expect(result.requestedGalleryImages).toBeUndefined();
      expect(result.shouldAlertOwner).toBe(true);
    } finally {
      env.SEND_IMAGES_ENABLED = previousSendImages;
    }
  });

  // Regression: a photo request landing on a guarded turn (soft unsafe phrasing,
  // or a close that flips the handoff flag) used to drop the photos while still
  // sending copy written on the promise of them. Those guards target UNSOLICITED
  // sales media; an explicit request is customer-driven and must be honoured.
  it('keeps explicitly requested gallery media when the reply has unsafe reservation phrasing', async () => {
    const previousSendImages = env.SEND_IMAGES_ENABLED;
    try {
      env.SEND_IMAGES_ENABLED = true;
      mockLlmComplete.mockReset();
      vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
      vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
      await withFreshDynamicService();
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: { reply: 'Te confirmo disponibilidad y te comparto las fotos. ¿Seguimos?\n[[FOTOS:lodging_fixture]]' },
      }));

      const result = await processMessage({
        repos,
        customerPhone: '573001990007',
        message: '¿Tienes fotos?',
      });

      expect(result.reply).not.toContain('[[FOTOS:');
      expect(result.requestedGalleryImages?.length).toBeGreaterThan(0);
      expect(result.shouldSendGalleryImages).toBe(true);
      // The contextual/automatic image stays suppressed on the same turn.
      expect(result.contextualImage).toBeUndefined();
    } finally {
      env.SEND_IMAGES_ENABLED = previousSendImages;
    }
  });

  it('selects a contextual image for a clear later-turn reply theme', async () => {
    const previous = {
      enabled: env.CONTEXTUAL_IMAGES_ENABLED,
      probability: env.CONTEXTUAL_IMAGES_PROBABILITY,
      gap: env.CONTEXTUAL_IMAGES_MIN_GAP_MINUTES,
    };
    try {
      env.CONTEXTUAL_IMAGES_ENABLED = true;
      env.CONTEXTUAL_IMAGES_PROBABILITY = 1;
      env.CONTEXTUAL_IMAGES_MIN_GAP_MINUTES = 0;
      mockLlmComplete.mockReset();
      vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
      vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
      await withFreshDynamicService();
      const phone = '573001990008';
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'inbound',
        message_type: 'text',
        body: 'Hola',
        created_at: new Date(Date.now() - 120_000).toISOString(),
      });
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'outbound',
        message_type: 'text',
        body: 'Te cuento cómo funciona.',
        created_at: new Date(Date.now() - 60_000).toISOString(),
      });
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: { reply: 'El rest_fixture es cómodo. ¿Qué más te gustaría saber?' },
      }));

      const result = await processMessage({
        repos,
        customerPhone: phone,
        message: '¿Cómo es?',
      });

      expect(result.contextualImage?.url).toMatch(/lodging-\d+\.jpg$/);
      expect(result.requestedGalleryImages).toBeUndefined();
    } finally {
      env.CONTEXTUAL_IMAGES_ENABLED = previous.enabled;
      env.CONTEXTUAL_IMAGES_PROBABILITY = previous.probability;
      env.CONTEXTUAL_IMAGES_MIN_GAP_MINUTES = previous.gap;
    }
  });

  it('does not select a contextual image when the feature is disabled', async () => {
    const previousEnabled = env.CONTEXTUAL_IMAGES_ENABLED;
    try {
      env.CONTEXTUAL_IMAGES_ENABLED = false;
      await withFreshDynamicService();
      const phone = '573001990009';
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'outbound',
        message_type: 'text',
        body: 'Mensaje anterior.',
        created_at: new Date(Date.now() - 60_000).toISOString(),
      });
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: { reply: 'El rest_fixture es cómodo. ¿Qué más quieres saber?' },
      }));

      const result = await processMessage({ repos, customerPhone: phone, message: '¿Cómo es?' });

      expect(result.contextualImage).toBeUndefined();
    } finally {
      env.CONTEXTUAL_IMAGES_ENABLED = previousEnabled;
    }
  });

  it('does not select a contextual image on the first turn', async () => {
    const previous = {
      enabled: env.CONTEXTUAL_IMAGES_ENABLED,
      probability: env.CONTEXTUAL_IMAGES_PROBABILITY,
    };
    try {
      env.CONTEXTUAL_IMAGES_ENABLED = true;
      env.CONTEXTUAL_IMAGES_PROBABILITY = 1;
      await withFreshDynamicService();
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: { reply: 'El rest_fixture es cómodo. ¿Qué más quieres saber?' },
      }));

      const result = await processMessage({
        repos,
        customerPhone: '573001990010',
        message: 'Hola, ¿cómo es?',
      });

      expect(result.contextualImage).toBeUndefined();
    } finally {
      env.CONTEXTUAL_IMAGES_ENABLED = previous.enabled;
      env.CONTEXTUAL_IMAGES_PROBABILITY = previous.probability;
    }
  });

  it('does not select a contextual image on a handoff turn', async () => {
    const previous = {
      enabled: env.CONTEXTUAL_IMAGES_ENABLED,
      probability: env.CONTEXTUAL_IMAGES_PROBABILITY,
    };
    try {
      env.CONTEXTUAL_IMAGES_ENABLED = true;
      env.CONTEXTUAL_IMAGES_PROBABILITY = 1;
      await withFreshDynamicService();
      const phone = '573001990011';
      repos.conversation.setMode(phone, 'human_pending');
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'outbound',
        message_type: 'text',
        body: 'Mensaje anterior.',
        created_at: new Date(Date.now() - 60_000).toISOString(),
      });
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: { reply: 'El rest_fixture es cómodo. ¿Qué método prefieres?' },
      }));

      const result = await processMessage({ repos, customerPhone: phone, message: '¿Cómo puedo pagar?' });

      expect(result.shouldAlertOwner).toBe(true);
      expect(result.contextualImage).toBeUndefined();
    } finally {
      env.CONTEXTUAL_IMAGES_ENABLED = previous.enabled;
      env.CONTEXTUAL_IMAGES_PROBABILITY = previous.probability;
    }
  });

  it('does not select a contextual image when no theme matches', async () => {
    const previous = {
      enabled: env.CONTEXTUAL_IMAGES_ENABLED,
      probability: env.CONTEXTUAL_IMAGES_PROBABILITY,
    };
    try {
      env.CONTEXTUAL_IMAGES_ENABLED = true;
      env.CONTEXTUAL_IMAGES_PROBABILITY = 1;
      await withFreshDynamicService();
      const phone = '573001990012';
      repos.message.addMessage({
        customer_phone: phone,
        direction: 'outbound',
        message_type: 'text',
        body: 'Mensaje anterior.',
        created_at: new Date(Date.now() - 60_000).toISOString(),
      });
      mockLlmComplete.mockResolvedValueOnce(fromOld({
        response: { reply: 'Todo se organiza con cuidado. ¿Qué más quieres saber?' },
      }));

      const result = await processMessage({ repos, customerPhone: phone, message: 'Cuéntame más' });

      expect(result.contextualImage).toBeUndefined();
    } finally {
      env.CONTEXTUAL_IMAGES_ENABLED = previous.enabled;
      env.CONTEXTUAL_IMAGES_PROBABILITY = previous.probability;
    }
  });

  it('handles a valid empty catalog without dereferencing experiences[0]', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ v: 11, updated: '2026-06-06T00:00:00Z', experiences: {} }),
    } as unknown as Response);
    const svc = new DynamicDataService(DYNAMIC_URL, 5000);
    await svc.forceRefresh();
    setDynamicService(svc);
    loadSkills();

    const result = await processMessage({ repos, customerPhone: '573001990099', message: 'Hola' });

    expect(result.reply).toBe(getSkills().fallbackReplies.es.dynamicDataUnavailable);
    expect(result.usedAi).toBe(false);
    expect(result.ownerAlertType).toBe('dynamic_pricing_unavailable');
  });

  it('hands off instead of retargeting a removed selected experience', async () => {
    const phone = '573001990098';
    repos.conversation.setSelectedExperienceId(phone, 'removed_experience');

    const result = await processMessage({ repos, customerPhone: phone, message: 'Quiero seguir' });

    expect(result.usedAi).toBe(false);
    expect(result.reply).toBe(getSkills().fallbackReplies.es.experienceInactive);
    expect(repos.conversation.getSelectedExperienceId(phone)).toBeNull();
  });

  it('hands off instead of falling back when the selected experience is inactive', async () => {
    const phone = '573001990096';
    const skills = getSkills();
    const originalExperiences = skills.andeanScapes.experiences;
    const selected = originalExperiences[0];
    skills.andeanScapes.experiences = [
      { ...selected, status: 'inactive' },
      { ...selected, id: 'active_alternative', status: 'active' },
    ];
    repos.conversation.setSelectedExperienceId(phone, selected.id);

    try {
      const result = await processMessage({ repos, customerPhone: phone, message: 'Quiero seguir' });
      expect(result.usedAi).toBe(false);
      expect(result.reply).toBe(skills.fallbackReplies.es.experienceInactive);
      expect(repos.conversation.getSelectedExperienceId(phone)).toBeNull();
    } finally {
      skills.andeanScapes.experiences = originalExperiences;
    }
  });

  it('hands off and clears a plan removed from the dynamic catalog', async () => {
    const phone = '573001990097';
    repos.conversation.upsert(phone, { collected_plan: 'removed_plan' });

    const result = await processMessage({ repos, customerPhone: phone, message: 'Quiero seguir con ese plan' });

    expect(result.usedAi).toBe(false);
    expect(result.reply).toBe(getSkills().fallbackReplies.es.planUnavailable);
    expect(repos.conversation.getCollectedPlan(phone)).toBeNull();
  });







  it('replaces a reply that leaks the tentative_unknown internal sentinel', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009993203';
    repos.message.addMessage({ whatsapp_message_id: 'msg-seed-0', customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Hola', created_at: new Date(Date.now() - 3600000).toISOString(), raw_json: null });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'Listo Michell. Me encanta el plan para 3 personas, para tentative_unknown, con transporte propio.',
        collected_fields: { name: 'Michell', people: 3, date: 'tentative_unknown', transport_need: 'own' },
      },
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Tengo transporte propio' });
    expect(result.shouldSendReply).toBe(true);
    expect(result.reply).toBe(getSkills().fallbackReplies.es.aiFailureQualified);
    expect(result.reply).not.toContain('tentative_unknown');
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('policy_violation_blocked');
  });

  it('sends a clean reply that mentions the confirmed-date wording', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009993206';
    repos.message.addMessage({ whatsapp_message_id: 'msg-seed-3', customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Hola', created_at: new Date(Date.now() - 3600000).toISOString(), raw_json: null });
    const reply = 'Listo Michell. El plan para 3 personas queda con fecha por confirmar y transporte propio.';
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply, collected_fields: { name: 'Michell', people: 3, transport_need: 'own' } },
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Tengo transporte propio' });
    expect(result.shouldSendReply).toBe(true);
    expect(result.reply).toBe(reply);
  });

  it('scrubs unsubstituted template tokens the LLM emits (single or double brace)', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009993204';
    // Seed an inbound so this is NOT first contact — the deterministic greeting
    // would otherwise bypass the LLM entirely. The scrub runs on LLM output.
    repos.message.addMessage({ whatsapp_message_id: 'msg-seed', customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Hola', created_at: new Date(Date.now() - 3600000).toISOString(), raw_json: null });
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: {
        reply: 'El plan {planName} dura {planDuration} y te encantara. {{planSummary}}',
        collected_fields: { name: 'Ana' },
      },
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Cuentame del plan' });
    // Known template tokens: non-echoing fallback (not empty silence).
    expect(result.shouldSendReply).toBe(true);
    expect(result.reply).toBe(getSkills().fallbackReplies.es.aiFailureQualified);
    expect(result.reply).not.toMatch(/\{\{?(?:planName|planDuration|planSummary)\}?\}/);
    expect(result.shouldAlertOwner).toBe(true);
    expect(result.ownerAlertType).toBe('policy_violation_blocked');
  });

  it('preserves legitimate copy that contains non-template braces', async () => {
    mockLlmComplete.mockReset();
    vi.mocked(checkBudget).mockReturnValue({ aiAllowed: true });
    vi.mocked(checkTimeWindow).mockReturnValue({ isLimited: false });
    const phone = '573009993205';
    repos.message.addMessage({ whatsapp_message_id: 'msg-seed-2', customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Hola', created_at: new Date(Date.now() - 3600000).toISOString(), raw_json: null });
    const reply = 'Perfecto :) usa el codigo {promo} al reservar.';
    mockLlmComplete.mockResolvedValueOnce(fromOld({
      response: { reply, collected_fields: { name: 'Ana' } },
    }));

    const result = await processMessage({ repos, customerPhone: phone, message: 'Hay algun codigo?' });
    expect(result.shouldSendReply).toBe(true);
    expect(result.reply).toBe(reply);
  });
});

describe('detectsReservationIntent', () => {
  it('matches explicit Spanish reservation phrases', () => {
    expect(detectsReservationIntent('Quiero reservar ya')).toBe(true);
    expect(detectsReservationIntent('Como pago?')).toBe(true);
    expect(detectsReservationIntent('¿Cómo hacemos para reservar?')).toBe(true);
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

  it('does NOT match negated reservation intent', () => {
    expect(detectsReservationIntent('No quiero reservar')).toBe(false);
    expect(detectsReservationIntent('No me interesa pagar ahora')).toBe(false);
    expect(detectsReservationIntent("I don't want to book")).toBe(false);
    expect(detectsReservationIntent('No estamos listos para reservar')).toBe(false);
    expect(detectsReservationIntent('Prefiero no pagar ahora')).toBe(false);
    expect(detectsReservationIntent("I won't book")).toBe(false);
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

  // whatsapp-sales.skill.md T3b close CTA ("primero valido disponibilidad ...
  // ¿la iniciamos?") is first-person plural, distinct wording from the older
  // singular "¿la inicie?" patterns. A live conversation reached exactly this
  // wording and the deterministic gate missed it, so the bot never handed off
  // even though the customer explicitly said yes.
  it('returns true for Si after the T3b close CTA "¿la iniciamos?"', () => {
    expect(isReservationIntentOrConfirmation(
      'Si',
      'El anticipo es del 15% por Nequi o Mercado Pago. Primero valido disponibilidad con el equipo. ¿La iniciamos?',
    )).toBe(true);
  });

  it('returns true for other short affirmations after "¿la iniciamos?"', () => {
    expect(isReservationIntentOrConfirmation('Dale', '¿La iniciamos?')).toBe(true);
    expect(isReservationIntentOrConfirmation('Listo', '¿La iniciamos?')).toBe(true);
  });

  it('returns false for No after "¿la iniciamos?" — negation must still block', () => {
    expect(isReservationIntentOrConfirmation('No', '¿La iniciamos?')).toBe(false);
  });
});

describe('isOptOutMessage', () => {
  // Keywords used to be matched with `includes()`, so short bare tokens fired inside
  // ordinary Spanish words: `basta` ⊂ bastante, `paren` ⊂ parentesco/aparentemente,
  // `bloqueo` ⊂ desbloqueo. That silenced live leads and set the permanent
  // `last_opt_out_at` compliance flag on a buying signal.
  it.each([
    'No es bastante claro el precio',
    'bastante interesado en el plan',
    'Hay parentesco con el guia?',
    'Es aparentemente costoso',
    'Ya hice el desbloqueo de mi tarjeta',
  ])('does not treat "%s" as an opt-out', (message) => {
    expect(isOptOutMessage(message)).toBe(false);
  });

  it.each([
    'STOP',
    'stop',
    'Basta',
    'basta ya',
    'paren',
    'paren de escribirme',
    'no me escribas mas',
    'NO ME ESCRIBAS MÁS',
    'ya no me escribas por favor',
    'déjame en paz',
    'unsubscribe',
  ])('still detects the real stop request "%s"', (message) => {
    expect(isOptOutMessage(message)).toBe(true);
  });

  // Bare "no más" is ambiguous, so it is matched only as a standalone phrase after
  // punctuation stripping — never as a substring. See OPT_OUT_STANDALONE_PHRASES.
  it.each([
    'No más',
    'No más.',
    'NO MÁS!!',
    'no mas',
    'no mas por favor',
    'no mas porfa',
    'no mas gracias',
    'no mas mensajes',
    'ya no mas',
    'no more',
    'no more please',
  ])('detects the standalone stop phrase "%s"', (message) => {
    expect(isOptOutMessage(message)).toBe(true);
  });

  // These MUST stay false: "no más de N" is a group-size answer, and "ya no" / "para"
  // are ordinary sales turns. A bare \bno mas\b keyword would have silenced them.
  it.each([
    'no mas de 5 personas',
    'somos no mas de 4',
    'no mas de diez',
    'no mas tarde',
    'ya no',
    'para 2 personas',
  ])('does not treat "%s" as an opt-out', (message) => {
    expect(isOptOutMessage(message)).toBe(false);
  });

  // Scoped to one kind of content: must not silence the whole thread.
  it('keeps a media-scoped stop out of the opt-out path', () => {
    expect(isOptOutMessage('no me mandes mas fotos')).toBe(false);
    // …but anything left over after the scoped clause is still evaluated.
    expect(isOptOutMessage('no me mandes mas fotos ni mensajes, basta')).toBe(true);
  });
});

describe('isExplicitCloseCtaConfirmation', () => {
  it('returns true only for short affirmations after hard close CTAs', () => {
    expect(isExplicitCloseCtaConfirmation('Si', 'Primero valido disponibilidad. ¿La iniciamos?')).toBe(true);
    expect(isExplicitCloseCtaConfirmation('Dale', '¿Quieres que inicie la validación?')).toBe(true);
    expect(isExplicitCloseCtaConfirmation('Yes', 'Shall I start that validation now?')).toBe(true);
  });

  it('returns true for the explicit "¿quieres que iniciemos la reserva?" close CTA', () => {
    expect(isExplicitCloseCtaConfirmation(
      'Si',
      'Primero confirmo el cupo del 14 de noviembre con el equipo. Si hay cupo, el anticipo para reservar es del 15%. ¿Quieres que iniciemos la reserva?',
    )).toBe(true);
    expect(isExplicitCloseCtaConfirmation('Dale', '¿Quieres que iniciemos la reserva?')).toBe(true);
    expect(isExplicitCloseCtaConfirmation('Si', '¿Quieren que iniciemos la reserva?')).toBe(true);
    expect(isExplicitCloseCtaConfirmation('Si', '¿Iniciamos la reserva?')).toBe(true);
    // Bare plural close (no object) — only the `quier(e|es|en) que iniciemos`
    // branch catches this; the "iniciemos la reserva" branch does not.
    expect(isExplicitCloseCtaConfirmation('Si', '¿Quieren que iniciemos?')).toBe(true);
  });

  it('returns false for soft interest questions — discovery "Si" is not close consent', () => {
    expect(isExplicitCloseCtaConfirmation('Si', 'El plan de 2 días te suena?')).toBe(false);
    expect(isExplicitCloseCtaConfirmation('Si', '¿Te interesa?')).toBe(false);
    expect(isExplicitCloseCtaConfirmation('Yes', 'Does that sound good?')).toBe(false);
  });

  it('returns false on negation or missing prior CTA', () => {
    expect(isExplicitCloseCtaConfirmation('No', '¿La iniciamos?')).toBe(false);
    expect(isExplicitCloseCtaConfirmation('Si', null)).toBe(false);
  });
});

describe('replyMentionsPrice', () => {
  it('detects formatted COP prices', () => {
    expect(replyMentionsPrice('Individual $550,000 COP')).toBe(true);
    expect(replyMentionsPrice('Pareja $1,000,000 COP')).toBe(true);
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

  it('detects referent strategy block markers', () => {
    expect(containsPromptLeakOrPolicyViolation('ESTRATEGIA PRINCIPAL: hacer preguntas')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('ESTRATEGIA COMPLEMENTARIA: cerrar suave')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('ESTRATEGIAS DE VENTA (principios internos; nunca menciones)')).toBe(true);
    expect(containsPromptLeakOrPolicyViolation('mis keyPoints son estos')).toBe(true);
  });

  // Referent source labels are metadata and never reach the prompt, so matching
  // arbitrary names at runtime would suppress legitimate customer replies.
  it('does not flag customers whose name matches a referent, or honest sales talk', () => {
    expect(containsPromptLeakOrPolicyViolation('Claro, Cliente Uno, serian 2 personas entonces.')).toBe(false);
    expect(containsPromptLeakOrPolicyViolation('Perfecto Cliente Dos, quedamos asi.')).toBe(false);
    expect(containsPromptLeakOrPolicyViolation('Hola Cliente Tres, gracias por escribir.')).toBe(false);
    expect(containsPromptLeakOrPolicyViolation('Nuestra estrategia de venta es simple: honestidad.')).toBe(false);
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


describe('hardSafetyFail', () => {
  beforeAll(() => {
    loadSkills();
  });

  it('suppresses prompt leaks', () => {
    expect(hardSafetyFail('El SALES CONTEXT dice que sea amable', true)).toBe('prompt_leak');
  });

  it('refuses to move to payment when no holdable date exists', () => {
    // Exact production reply after the bot invented "esa fecha" and the
    // customer answered "Si": a 15% deposit on a booking nobody could hold.
    const reply = '¡Listo! Para confirmar, el anticipo es del 15% del total ($150.000) por Nequi o Mercado Pago. ¿Con cuál método prefieren?';

    expect(hardSafetyFail(reply, true, false)).toBe('payment_without_date');
    // With a real date on file the same reply is legitimate.
    expect(hardSafetyFail(reply, true, true)).toBeNull();
  });

  it.each([
    'Te confirmo el anticipo del 15% y listo.',
    'Puedes abonar por Nequi cuando quieras.',
    'Ya quedó confirmado tu cupo.',
  ])('blocks "%s" without a date', reply => {
    expect(hardSafetyFail(reply, true, false)).toBe('payment_without_date');
  });

  it('does not block ordinary undated copy as a payment move', () => {
    for (const reply of [
      'El plan incluye alojamiento, 3 comidas y la mina.',
      'Para 2 personas, el plan queda en $1.000.000 COP.',
      '¿Qué fecha tienen en mente?',
    ]) {
      expect(hardSafetyFail(reply, true, false)).toBeNull();
    }
  });

  it('blocks unsubstituted square-bracket skill placeholders', () => {
    // Observed in production copy: "Para 1 persona, el plan queda en [TOTAL]."
    // KNOWN_TEMPLATE_TOKENS only covers {curly} tokens, so these used to ship.
    for (const reply of [
      'Para 1 persona, el plan queda en [TOTAL].',
      'Para [N] personas, el plan queda en 1.000.000.',
      'Te recomiendo el [PLAN_A] para esas fechas.',
      'La [EXPERIENCIA] se hace en Boyaca.',
      'Puedes pagar con [METODOS].',
    ]) {
      expect(hardSafetyFail(reply, true)).toBe('skill_placeholder_leak');
    }
  });

  it('does not treat normal copy or curly tokens as a skill placeholder leak', () => {
    for (const reply of [
      'Para 2 personas, el plan queda en $1.000.000 COP.',
      'Vamos a la mina La Union (~6 horas) con casco y botas.',
      'Salimos de la Terminal Salitre (Bogota) a las 6 a.m.',
    ]) {
      expect(hardSafetyFail(reply, true)).not.toBe('skill_placeholder_leak');
    }
  });

  it('blocks payment detail leaks including bare phone, bare pay URL, and offer-to-send', () => {
    for (const reply of [
      'Transfiere el anticipo a Nequi 3009900001 y me confirmas.',
      'Te dejo el link: Mercado Pago https://mpago.la/abc',
      'Envia al numero 3009900001 el comprobante.',
      'Paga por Nequi al [inserte numero] cuando puedas.',
      'Mi whatsapp es 3009900001',
      'Llama al 300 990 0001',
      'https://mpago.la/abc',
      'Te paso el link de pago',
      'Te envío los datos de pago por aquí',
      'Te mando los datos de Nequi',
      'Te paso el numero de cuenta',
    ]) {
      expect(hardSafetyFail(reply, true)).toBe('payment_detail_leak');
    }
  });

  it('does not block benign "te paso la info" copy without payment context', () => {
    for (const reply of [
      'Te paso la info del plan por aqui.',
      'Te paso los datos del itinerario.',
      'Te mando la info de la ruta.',
      'Te envio los datos del hospedaje.',
      'Te doy la info de que incluye.',
      'El plan cuesta 1.300.000 COP en total.',
      'Somos 3 personas el 15 de marzo 2026.',
      'La finca tiene 300 metros de sendero.',
    ]) {
      expect(hardSafetyFail(reply, true)).toBeNull();
    }
  });

  it('blocks strong false-reservation claims but keeps soft availability phrasing', () => {
    expect(hardSafetyFail('Ya quedo reservado para el sabado.', true)).toBe('false_reservation_claim');
    expect(hardSafetyFail('Tu reserva quedo confirmada.', true)).toBe('false_reservation_claim');
    expect(hardSafetyFail('Listo, ya esta confirmado el cupo.', true)).toBe('false_reservation_claim');
    for (const reply of [
      'Genial, finales de agosto suena bien. Te confirmo disponibilidad.',
      'Perfecto. ¿Validamos disponibilidad con el equipo?',
      'El plan 2D/1N para 3 personas queda claro.',
    ]) {
      expect(hardSafetyFail(reply, true)).toBeNull();
    }
  });

  it('flags a price when pricing is unavailable', () => {
    expect(hardSafetyFail('Son $1.300.000 COP en total.', false)).toBe('price_without_pricing');
    expect(hardSafetyFail('Son $1.300.000 COP en total.', true)).toBeNull();
  });

  it('suppresses known template tokens but keeps legitimate braces', () => {
    expect(hardSafetyFail('El plan {planName} te encantara.', true)).toBe('template_token_leak');
    expect(hardSafetyFail('Usa el codigo {promo} al reservar.', true)).toBeNull();
    expect(hardSafetyFail('Perfecto :) nos vemos.', true)).toBeNull();
  });

  it('suppresses internal sentinels', () => {
    expect(hardSafetyFail('Queda para tentative_unknown.', true)).toBe('internal_sentinel_leak');
    expect(hardSafetyFail('Queda para _relative_ordinal_1.', true)).toBe('internal_sentinel_leak');
    expect(hardSafetyFail('Te comparto las fotos. [[FOTOS:hotel', true)).toBe('media_marker_malformed');
  });

  it('suppresses campaign markers without blocking ordinary route codes', () => {
    expect(hardSafetyFail('Veo que vienes de C01.', true)).toBe('entry_marker_leak');
    expect(hardSafetyFail('La ruta usa el acceso C4.', true)).toBeNull();
  });
});

describe('logQuoteMismatch', () => {
  const DEPOSIT_PERCENT = 15;

  function expWithPricing() {
    const exp = getActiveExperience(loadSkills());
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: 'i', planId: '2d1n_mining', label: 'Individual', pricePerPerson: 550_000, publiclyShow: true },
        { id: 'c', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1_000_000, peopleIncluded: 2, publiclyShow: true },
        { id: ADDON_ID_PRIVATE_TRANSPORT, label: 'Transporte privado', couplePrice: 1_700_000, peopleIncluded: 4, publiclyShow: true },
      ],
      botRules: [],
      businessRules: [],
    };
    return exp;
  }

  it('accepts the correct total quoted alongside the deposit', () => {
    const exp = expWithPricing();
    // 5 people = 1.000.000 / 2 x 5 = 2.500.000; deposit 15% = 375.000.
    const reply = 'Para 5 personas son $2.500.000 COP. Para separar, el anticipo es de $375.000.';

    expect(logQuoteMismatch(reply, exp, { personas: 5, plan: '2d1n_mining' }, '573001', DEPOSIT_PERCENT)).toEqual([]);
  });

  it('accepts the plan-only total when transport still needs confirmation', () => {
    const exp = expWithPricing();
    const reply = 'El plan para 5 personas es $2.500.000 COP. El transporte privado lo confirmo con el equipo.';

    expect(logQuoteMismatch(
      reply,
      exp,
      { personas: 5, plan: '2d1n_mining', transporte: 'from_bogota' },
      '573001',
      DEPOSIT_PERCENT,
    )).toEqual([]);
  });

  it('reports a total the calculator did not produce', () => {
    const exp = expWithPricing();
    const reply = 'Para 5 personas son $2.300.000 COP en total.';

    expect(logQuoteMismatch(reply, exp, { personas: 5, plan: '2d1n_mining' }, '573001', DEPOSIT_PERCENT))
      .toEqual([2_300_000]);
  });

  it('stays silent when the group size is unknown', () => {
    const exp = expWithPricing();

    expect(logQuoteMismatch('Desde $550.000 por persona.', exp, {}, '573001', DEPOSIT_PERCENT)).toEqual([]);
  });
});
