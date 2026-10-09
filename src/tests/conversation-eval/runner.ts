import Database from 'better-sqlite3';
import { migrate } from '../../db/migrate.js';
import { createRepositories } from '../../db/repositories/index.js';
import { processMessage } from '../../services/response-engine.js';
import type { ProcessMessageOutput, ProcessMessageInput } from '../../services/response-engine.js';
import type { ConversationMode, Repositories } from '../../db/repositories/index.js';
import type { LlmResult, LlmTurn } from '../../services/llm/llm-client.js';
import type { LlmClientInput } from '../../services/llm/llm-client.js';
import type { Scenario, ScenarioTurn } from './schema.js';
import { getDynamicService, getSkills, loadSkills, setDynamicService } from '../../services/skill-loader.js';
import { getActiveExperience } from '../../services/product-registry.js';
import { DynamicDataService, PRICING_NOT_AVAILABLE } from '../../services/dynamic-data-service.js';
import type { InternalDynamicData, InternalPaymentData } from '../../services/dynamic-data-service.js';
import { DEFAULT_SITE_ID } from '../../services/dynamic-data-schema.js';

export interface TurnRecord {
  turnNumber: number;
  user: string;
  reply: string;
  processOutput: EvaluationOutput;
}

export type EvaluationOutput = ProcessMessageOutput & Partial<Record<
  'queueForReactivationAfterWindow' | 'reactivationEligible' | 'reactivationSegment' | 'conversationStarted' | 'meaningfulSecondInbound' | 'qualified' | 'leadLifecycle' | 'bookingIntent' | 'handoffCreated' | 'suppressGenericFollowups',
  boolean | number | string
>>;

export interface RunContext {
  repos: Repositories;
  db: Database.Database;
  customerPhone: string;
  turns: TurnRecord[];
  destroy: () => void;
}

export function defaultMockResult(reply: string, overrides?: Partial<LlmTurn>): LlmResult | null {
  if (!reply) return null;
  const turn: LlmTurn = {
    reply,
    sales_phase: overrides?.sales_phase ?? 'discovery',
    action: overrides?.action ?? 'answer',
    collected_fields: overrides?.collected_fields ?? {
      name: null, plan: null, people: null, date: null, transport_need: null, pet: null,
    },
    lead: overrides?.lead ?? {
      intent: 'curious', buying_signals: [], blockers: [], score_delta: 0, confidence: 0.5,
    },
    img: overrides?.img ?? false,
  };
  return { turn, tokens: { prompt: 100, completion: 20 } };
}

export type MockLlmFunction = (input: LlmClientInput) => Promise<LlmResult | null>;

export interface RunOptions {
  customerPhone?: string;
  phoneSuffix?: number;
}

function createDynamicData(scenario: Scenario): InternalDynamicData {
  const seed = scenario.seedSystem;
  const experience = getActiveExperience(getSkills());
  const rawAvailability = Array.isArray(seed?.availability)
    ? seed.availability
    : seed?.availability ? [seed.availability] : [];
  const currentDate = seed?.currentDate?.slice(0, 10) ?? '2026-01-01';
  const availability = rawAvailability
    .filter(item => !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || item.date >= currentDate)
    .map(item => ({ date: item.date, status: item.status, slotsApprox: 'remainingSpots' in item ? item.remainingSpots : null }));
  const policy = seed?.reservationPolicy;
  const payments: InternalPaymentData | null = policy
    && policy.depositPercent !== null
    && policy.securePaymentLinkAvailable !== null
    && policy.reschedulingAllowed !== null
    ? {
      currency: experience.pricing.currency,
      deposit: {
        type: 'percentage', value: policy.depositPercent, label: `${policy.depositPercent}%`, calculationRule: 'Test scenario policy',
        remainingBalance: { type: 'percentage', value: 100 - policy.depositPercent },
      },
      methods: policy.securePaymentLinkAvailable ? [{
        id: 'secure_link', name: 'Secure payment link', type: 'link', enabled: true,
        currency: experience.pricing.currency, requiresPaymentProof: false,
      }] : [],
      confirmation: { automatic: false, requiresTeamValidation: true, message: 'Test scenario confirmation' },
      displayPolicy: {
        showMethodsAfterAvailabilityValidation: true,
        showWhenCustomerAsks: true,
        neverRequestFullPaymentWithoutConfirmation: true,
      },
    }
    : null;
  const availabilityBlock = {
    lastUpdated: seed?.currentDate ?? '2026-01-01',
    timezone: seed?.timezone ?? 'America/Bogota',
    availableDates: availability,
    botRule: seed?.availabilityVerified ? 'Availability is authoritative for this test scenario.' : 'Confirm availability with the team.',
  };

  return {
    experiences: {
      [experience.id]: {
        plans: experience.plans.map(plan => ({
          id: plan.id,
          siteId: DEFAULT_SITE_ID,
          name: plan.name,
          duration: plan.duration,
          shortDescription: plan.shortDescription,
          benefits: plan.benefits,
          keywords: plan.keywords,
          clarifications: plan.clarifications ?? [],
          imageId: plan.imageId,
        })),
        pricing: {
          currency: experience.pricing.currency,
          lastUpdated: seed?.currentDate ?? '2026-01-01',
          items: experience.pricing.items.map(item => ({
            id: item.id,
            siteId: DEFAULT_SITE_ID,
            planId: item.planId,
            label: item.label,
            pricePerPerson: item.pricePerPerson,
            couplePrice: item.couplePrice,
            peopleIncluded: item.peopleIncluded,
            publiclyShow: item.publiclyShow,
          })),
          botRules: experience.pricing.botRules,
        },
        availability: availabilityBlock,
        sites: {
          [DEFAULT_SITE_ID]: {
            id: DEFAULT_SITE_ID,
            clarifications: [],
            rules: experience.pricing.botRules,
            availability: availabilityBlock,
          },
        },
      },
    },
    media: null,
    payments,
  };
}

function createDynamicService(data: InternalDynamicData | null, fresh: boolean): DynamicDataService {
  const service = new DynamicDataService('https://conversation-eval.invalid/dynamic.json', 0);
  service.getData = () => data;
  service.forceRefresh = async () => undefined;
  service.refreshIfStale = async () => undefined;
  Object.defineProperty(service, 'lastFetchOk', { get: () => fresh });
  return service;
}

export function createRunContext(options: RunOptions): RunContext {
  const db = new Database(':memory:');
  migrate(db);
  const repos = createRepositories(db);

  const phone = options.customerPhone ?? `57300${String(options.phoneSuffix ?? 0).padStart(7, '0')}`;

  return {
    repos,
    db,
    customerPhone: phone,
    turns: [],
    destroy: () => db.close(),
  };
}

function applyQualificationSeed(
  repos: Repositories,
  phone: string,
  seed?: {
    name?: string;
    people?: number;
    date?: string | null;
    transport?: string;
    transportNeed?: string;
    plan?: string;
    leadScore?: number;
  },
): void {
  if (!seed) return;
  repos.conversation.upsert(phone, {
    collected_name: seed.name,
    collected_people: seed.people,
    collected_date: seed.date,
    collected_transport_need: seed.transportNeed ?? seed.transport,
    collected_plan: seed.plan,
  });
  if (seed.leadScore !== undefined) repos.conversation.updateLeadScore(phone, seed.leadScore);
}

export function applyScenarioSeeds(ctx: RunContext, scenario: Scenario): () => void {
  applyQualificationSeed(ctx.repos, ctx.customerPhone, scenario.seedQualification);

  const seed = scenario.seedConversation;
  if (seed) {
    applyQualificationSeed(ctx.repos, ctx.customerPhone, seed.qualification);
    if (seed.phase) ctx.repos.conversation.setSalesPhase(ctx.customerPhone, seed.phase);
    if (seed.conversationMode) ctx.repos.conversation.setMode(ctx.customerPhone, seed.conversationMode as ConversationMode);
    if (seed.softClosed) ctx.repos.conversation.setSoftClosed(ctx.customerPhone);
    if (seed.priceGiven) ctx.repos.conversation.setPriceGiven(ctx.customerPhone);
    // Seed followup subscription status: primarily for consent-path testing.
    if (seed.followupStatus) {
      ctx.repos.followupSubscription.ensureExists(ctx.customerPhone);
      const status = seed.followupStatus;
      if (status === 'pending') {
        ctx.repos.followupSubscription.markAsked(ctx.customerPhone, null);
      } else if (status === 'active') {
        ctx.repos.followupSubscription.markAsked(ctx.customerPhone, null);
        ctx.repos.followupSubscription.affirm(ctx.customerPhone, `test_seed_${Date.now()}`, 'test_seed');
      } else if (status === 'declined') {
        ctx.repos.followupSubscription.markAsked(ctx.customerPhone, null);
        ctx.repos.followupSubscription.decline(ctx.customerPhone, `test_seed_${Date.now()}`);
      } else if (status === 'revoked') {
        ctx.repos.followupSubscription.markAsked(ctx.customerPhone, null);
        ctx.repos.followupSubscription.affirm(ctx.customerPhone, `test_seed_${Date.now()}`, 'test_seed');
        ctx.repos.followupSubscription.revoke(ctx.customerPhone, 'test_seed');
      }
      // 'unasked' is the default state, so no action needed
    }
  }

  const dynamicAvailable = scenario.seedSystem?.dynamicSkillAvailable;
  const previousDynamicService = dynamicAvailable !== undefined ? getDynamicService() : null;
  if (dynamicAvailable !== undefined) {
    setDynamicService(createDynamicService(dynamicAvailable ? createDynamicData(scenario) : null, dynamicAvailable));
    loadSkills();
  } else {
    const exp = getActiveExperience(getSkills());
    const prevRules = [...exp.pricing.botRules];
    exp.pricing.botRules = exp.pricing.botRules.filter(rule => rule !== PRICING_NOT_AVAILABLE);
    return () => {
      exp.pricing.botRules = prevRules;
    };
  }

  return () => {
    if (dynamicAvailable !== undefined) {
      setDynamicService(previousDynamicService);
      loadSkills();
    }
  };
}

export async function runTurn(
  ctx: RunContext,
  turnDef: ScenarioTurn,
  turnNumber: number,
  mode: 'deterministic' | 'live' = 'deterministic',
): Promise<TurnRecord> {
  if (turnDef.seedPriceGiven) ctx.repos.conversation.setPriceGiven(ctx.customerPhone);
  if (turnDef.seedLeadScore !== undefined) ctx.repos.conversation.updateLeadScore(ctx.customerPhone, turnDef.seedLeadScore);
  applyQualificationSeed(ctx.repos, ctx.customerPhone, turnDef.seedQualification);

  // Replay turns bypass LLM: store inbound and outbound directly with applied seeds.
  if (mode === 'live' && turnDef.replay) {
    ctx.repos.runInTransaction(() => {
      ctx.repos.message.addMessage({
        customer_phone: ctx.customerPhone,
        direction: 'inbound',
        message_type: 'text',
        body: turnDef.user.slice(0, 1500),
        created_at: new Date().toISOString(),
      });
      ctx.repos.message.addMessage({
        customer_phone: ctx.customerPhone,
        direction: 'outbound',
        message_type: 'text',
        body: turnDef.mockReply,
        created_at: new Date().toISOString(),
      });
    });
    // Return a minimal output for replay turns (no AI call, no analysis).
    const replayOutput: ProcessMessageOutput = {
      shouldSendReply: true,
      reply: turnDef.mockReply,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
      shouldSendOwnerImage: false,
      shouldSendGalleryImages: false,
      priceJustGiven: false,
      leadScore: ctx.repos.conversation.getByPhone(ctx.customerPhone)?.lead_score ?? 0,
    };
    return {
      turnNumber,
      user: turnDef.user,
      reply: turnDef.mockReply,
      processOutput: replayOutput,
    };
  }

  const messageId = `sim_${Date.now()}_${turnNumber}`;
  if (turnDef.consentAnswer === 'affirm') {
    ctx.repos.followupSubscription.affirm(ctx.customerPhone, messageId, 'customer_reply');
  } else if (turnDef.consentAnswer === 'decline') {
    ctx.repos.followupSubscription.decline(ctx.customerPhone, messageId);
  }
  const input: ProcessMessageInput = {
    repos: ctx.repos,
    customerPhone: ctx.customerPhone,
    message: turnDef.user.slice(0, 1500),
    messageId,
    consentAcceptedThisTurn: turnDef.consentAnswer === 'affirm',
    consentDeclinedThisTurn: turnDef.consentAnswer === 'decline',
  };

  const output = await processMessage(input);
  if (output.shouldSendReply && output.reply) {
    ctx.repos.runInTransaction(() => {
      ctx.repos.message.addMessage({
        customer_phone: ctx.customerPhone,
        direction: 'outbound',
        message_type: 'text',
        body: output.reply,
        created_at: new Date().toISOString(),
      });
      if (output.outboundDateAction === 'asked') ctx.repos.conversation.setDateAsked(ctx.customerPhone);
      if (output.outboundDateAction === 'options_offered') ctx.repos.conversation.setDateOptionsOffered(ctx.customerPhone);
    });
  }

  return {
    turnNumber,
    user: turnDef.user,
    reply: output.reply,
    processOutput: output,
  };
}
