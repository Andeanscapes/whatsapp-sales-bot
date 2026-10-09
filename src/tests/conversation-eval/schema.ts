import { z } from 'zod';

const expectSchema = z.object({
  shouldSendReply: z.boolean().optional(),
  shouldAlertOwner: z.boolean().optional(),
  shouldSendImage: z.boolean().optional(),
  shouldSendOwnerImage: z.boolean().optional(),
  shouldSendGalleryImages: z.boolean().optional(),
  /**
   * How many photos this turn actually ships. `shouldSendGalleryImages` alone
   * cannot catch a marker that resolved to an empty list, which is exactly how
   * the "reply promises photos, zero delivered" defect reached production.
   */
  requestedGalleryImagesCount: z.number().int().nonnegative().optional(),
  sendOwnerImage: z.boolean().optional(),
  usedAi: z.boolean().optional(),
  priceJustGiven: z.boolean().optional(),
  reply: z.string().optional(),
  replyMustNotMatch: z.array(z.string()).optional(),
  replyMustContain: z.array(z.string()).optional(),
  queueForReactivationAfterWindow: z.boolean().optional(),
  reactivationEligible: z.boolean().optional(),
  reactivationSegment: z.string().optional(),
  conversationStarted: z.boolean().optional(),
  meaningfulSecondInbound: z.boolean().optional(),
  qualified: z.boolean().optional(),
  reservationReady: z.boolean().optional(),
  salesPhase: z.string().optional(),
  intent: z.string().optional(),
  mediaPlanId: z.string().optional(),
  bookingIntent: z.boolean().optional(),
  handoffCreated: z.boolean().optional(),
  leadLifecycle: z.enum(['quoted', 'human_pending', 'payment_pending', 'decision_pending', 'lost_price']).optional(),
  suppressGenericFollowups: z.boolean().optional(),
}).strict();

const qualificationSeedSchema = z.object({
  name: z.string().optional(),
  people: z.number().int().positive().optional(),
  date: z.string().nullable().optional(),
  transport: z.string().optional(),
  transportNeed: z.string().optional(),
  plan: z.string().optional(),
  leadScore: z.number().int().min(0).max(100).optional(),
}).strict();

const conversationModeSchema = z.enum(['bot', 'bridge_active', 'referred', 'human_pending']);

const turnSchema = z.object({
  user: z.string().min(1),
  mockReply: z.string(),
  replay: z.boolean().optional(),
  consentAnswer: z.enum(['affirm', 'decline', 'ambiguous']).optional(),
  expect: expectSchema.optional(),
  mockAnalysis: z.object({
    intent: z.enum(['cold', 'curious', 'qualified', 'price_aware_interested', 'ready_to_book', 'not_interested']),
    scoreDelta: z.number().int().min(-30).max(35),
    confidence: z.number().min(0).max(1),
    afterPriceInterest: z.boolean(),
    reservationReadiness: z.enum(['none', 'weak', 'medium', 'strong']),
  }).strict().optional(),
  seedPriceGiven: z.boolean().optional(),
  seedLeadScore: z.number().int().min(0).max(100).optional(),
  seedQualification: qualificationSeedSchema.optional(),
});

const seedConversationSchema = z.object({
  conversationMode: conversationModeSchema.optional(),
  phase: z.string().optional(),
  softClosed: z.boolean().optional(),
  priceGiven: z.boolean().optional(),
  qualification: qualificationSeedSchema.optional(),
  followupStatus: z.enum(['unasked', 'pending', 'active', 'declined', 'revoked']).optional(),
}).strict();

const seedSystemSchema = z.object({
  dynamicSkillAvailable: z.boolean().optional(),
  dynamicSkillRequired: z.boolean().optional(),
  withinCustomerServiceWindow: z.boolean().optional(),
  approvedTemplateAvailable: z.boolean().optional(),
  meaningfulSecondInbound: z.boolean().optional(),
  priorAutomatedFollowUps: z.number().int().min(0).optional(),
  hoursSinceLastInbound: z.number().nonnegative().optional(),
  hoursSinceBotReply: z.number().nonnegative().optional(),
  receivedBotReply: z.boolean().optional(),
  isReserved: z.boolean().optional(),
  isHumanPending: z.boolean().optional(),
  isPaused: z.boolean().optional(),
  isOptOut: z.boolean().optional(),
  decisionPause: z.string().optional(),
  userPromisedUpdateAfter: z.string().datetime({ offset: true }).optional(),
  currentTime: z.string().datetime({ offset: true }).optional(),
  knownIntent: z.string().optional(),
  knownMonth: z.string().optional(),
  knownPeople: z.number().int().positive().optional(),
  knownDate: z.string().optional(),
  knownPrice: z.string().optional(),
  leadLifecycle: z.string().optional(),
  hoursSincePaymentLinkSent: z.number().nonnegative().optional(),
  paymentCompleted: z.boolean().optional(),
  priceShown: z.boolean().optional(),
  explicitRejection: z.boolean().optional(),
  groupType: z.string().optional(),
  travelStyle: z.string().optional(),
  knownPlan: z.string().optional(),
  reservationPolicy: z.object({
    depositPercent: z.number().nonnegative().nullable(),
    securePaymentLinkAvailable: z.boolean().nullable(),
    reschedulingAllowed: z.boolean().nullable(),
  }).strict().optional(),
  availabilityVerified: z.boolean().optional(),
  primaryObjection: z.string().optional(),
  privateTransportWasQuoted: z.boolean().optional(),
  publicTransportAlternativeAvailable: z.boolean().optional(),
  currentDate: z.string().optional(),
  timezone: z.string().optional(),
  availability: z.union([z.object({
    date: z.string(),
    status: z.string(),
    remainingSpots: z.number().int().nonnegative().nullable(),
  }).strict(), z.array(z.object({
    date: z.string(),
    weekday: z.string().optional(),
    status: z.string(),
  }).strict())]).optional(),
}).strict();

const criterionRuleSchema = z.enum([
  'reply_must_match',
  'reply_must_not_match',
  'output_flag_equals',
  'output_flag_not_equals',
  'known_field_not_reasked',
  'price_after_min_fields',
  'big_group_date_validation',
  'big_group_price_review',
  'partner_name_not_customer_name',
  'unsafe_pattern_absent',
  'group_quote_integrity',
  'no_unpublished_date',
  'max_question_marks',
  'max_emojis',
  'reply_length_at_most',
  'output_question_count_at_most',
  'output_count_at_most',
]);

const outputFlagSchema = z.enum([
  'leadScore',
  'shouldSendReply',
  'shouldAlertOwner',
  'shouldSendImage',
  'shouldSendOwnerImage',
  'shouldSendGalleryImages',
  'usedAi',
  'priceJustGiven',
  'conversationMode',
  'salesPhase',
  'softClosed',
  'sendOwnerImage',
  'queueForReactivationAfterWindow',
  'reactivationEligible',
  'reactivationSegment',
  'conversationStarted',
  'meaningfulSecondInbound',
  'qualified',
  'reservationReady',
  'intent',
  'mediaPlanId',
  'bookingIntent',
  'handoffCreated',
  'leadLifecycle',
  'suppressGenericFollowups',
]);

const criterionSchema = z.object({
  id: z.string().min(1),
  rule: criterionRuleSchema,
  weight: z.number().positive().default(1),
  critical: z.boolean().default(false),
  patterns: z.array(z.string().min(1)).min(1).optional(),
  field: z.enum(['name', 'people', 'date', 'transport', 'transportNeed', 'plan']).optional(),
  flag: outputFlagSchema.optional(),
  output: z.enum(['media']).optional(),
  expected: z.union([z.boolean(), z.string(), z.number().int().nonnegative()]).optional(),
  turn: z.number().int().min(1).optional(),
  suppliedTurn: z.number().int().min(1).optional(),
  minFields: z.number().int().min(0).max(6).optional(),
  threshold: z.number().int().min(1).max(100).optional(),
  people: z.number().int().positive().optional(),
  planId: z.string().min(1).optional(),
  expectedTotal: z.number().int().positive().optional(),
  max: z.number().int().min(0).max(20).optional(),
}).strict().superRefine((criterion, ctx) => {
  if (['reply_must_match', 'reply_must_not_match', 'unsafe_pattern_absent'].includes(criterion.rule) && !criterion.patterns) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${criterion.rule} requires patterns` });
  }
  if (criterion.rule === 'known_field_not_reasked' && (!criterion.field || criterion.suppliedTurn === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'known_field_not_reasked requires field and suppliedTurn' });
  }
  if ((criterion.rule === 'output_flag_equals' || criterion.rule === 'output_flag_not_equals')
    && (criterion.flag === undefined || criterion.expected === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${criterion.rule} requires flag and expected` });
  }
  if (criterion.rule === 'group_quote_integrity' && (criterion.people === undefined || criterion.planId === undefined || criterion.expectedTotal === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'group_quote_integrity requires people, planId, and expectedTotal' });
  }
  if ((criterion.rule === 'max_question_marks' || criterion.rule === 'max_emojis') && criterion.max === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${criterion.rule} requires max` });
  }
  if (['reply_length_at_most', 'output_question_count_at_most', 'output_count_at_most'].includes(criterion.rule)
    && typeof criterion.expected !== 'number') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${criterion.rule} requires numeric expected` });
  }
  if (criterion.rule === 'output_count_at_most' && criterion.output === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'output_count_at_most requires output' });
  }
});

export const scenarioSchema = z.object({
  id: z.string().min(1),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  lang: z.enum(['es', 'en']).default('es'),
  runner: z.enum(['message', 'lifecycle']).default('message'),
  seedQualification: qualificationSeedSchema.optional(),
  seedConversation: seedConversationSchema.optional(),
  seedSystem: seedSystemSchema.optional(),
  liveRuns: z.number().int().min(1).max(5).default(1),
  minLiveScore: z.number().min(0).max(100).optional(),
  mockPricing: z.object({
    planId: z.string().min(1),
    individual: z.number().int().positive(),
    couple: z.number().int().positive(),
    privateTransport: z.number().int().positive().optional(),
  }).strict().optional(),
  turns: z.array(turnSchema).min(1),
  criteria: z.array(criterionSchema).min(1),
}).strict().superRefine((scenario, ctx) => {
  for (const criterion of scenario.criteria) {
    const checkedTurns = criterion.turn === undefined
      ? scenario.turns
      : [scenario.turns[criterion.turn - 1]];
    if (checkedTurns.some(turn => turn?.replay)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${criterion.id} checks a replay turn` });
    }
  }
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioTurn = z.infer<typeof turnSchema>;
export type Criterion = z.infer<typeof criterionSchema>;
export type CriterionRule = z.infer<typeof criterionRuleSchema>;

const criterionResultSchema = z.object({
  id: z.string(),
  rule: criterionRuleSchema,
  passed: z.boolean(),
  score: z.number().min(0).max(100),
  weight: z.number(),
  critical: z.boolean(),
  evidence: z.string(),
});

const scenarioResultSchema = z.object({
  id: z.string(),
  score: z.number().min(0).max(100),
  hardFail: z.boolean(),
  notes: z.array(z.string()),
  criteria: z.array(criterionResultSchema),
  turnResults: z.array(z.object({
    user: z.string(),
    reply: z.string(),
    leadScore: z.number(),
    shouldAlertOwner: z.boolean(),
    shouldSendImage: z.boolean(),
  })),
  runs: z.object({ total: z.number().int().min(1), passed: z.number().int().min(0) }).optional(),
});

const suiteMetaSchema = z.object({
  average: z.number(),
  min: z.number(),
  count: z.number(),
  hardFails: z.number(),
  costUsd: z.number().optional(),
  totalTokens: z.number().optional(),
});

export const evalReportSchema = z.object({
  version: z.literal(2),
  mode: z.enum(['deterministic', 'live']),
  gitSha: z.string(),
  generatedAt: z.string(),
  suite: suiteMetaSchema,
  scenarios: z.array(scenarioResultSchema),
});

export type CriterionResult = z.infer<typeof criterionResultSchema>;
export type EvalReport = z.infer<typeof evalReportSchema>;
export type ScenarioResult = z.infer<typeof scenarioResultSchema>;
