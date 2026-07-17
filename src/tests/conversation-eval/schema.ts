import { z } from 'zod';

const expectSchema = z.object({
  shouldSendReply: z.boolean().optional(),
  shouldAlertOwner: z.boolean().optional(),
  shouldSendImage: z.boolean().optional(),
  shouldSendOwnerImage: z.boolean().optional(),
  shouldSendGalleryImages: z.boolean().optional(),
  usedAi: z.boolean().optional(),
  priceJustGiven: z.boolean().optional(),
  reply: z.string().optional(),
  replyMustNotMatch: z.array(z.string()).optional(),
  replyMustContain: z.array(z.string()).optional(),
}).strict();

const turnSchema = z.object({
  user: z.string().min(1),
  mockReply: z.string(),
  expect: expectSchema.optional(),
  mockAnalysis: z.object({
    intent: z.enum(['cold', 'curious', 'qualified', 'price_aware_interested', 'ready_to_book', 'not_interested']),
    scoreDelta: z.number().int().min(-30).max(35),
    confidence: z.number().min(0).max(1),
    afterPriceInterest: z.boolean(),
    reservationReadiness: z.enum(['none', 'weak', 'medium', 'strong']),
  }).strict().optional(),
  seedPriceGiven: z.boolean().optional(),
  seedGalleryNudge: z.boolean().optional(),
  seedLeadScore: z.number().int().min(0).max(100).optional(),
  seedQualification: z.object({
    name: z.string().optional(),
    people: z.number().int().positive().optional(),
    date: z.string().optional(),
    transport: z.string().optional(),
    plan: z.string().optional(),
  }).strict().optional(),
});

const criterionRuleSchema = z.enum([
  'reply_must_match',
  'reply_must_not_match',
  'output_flag_equals',
  'known_field_not_reasked',
  'price_after_min_fields',
  'big_group_date_validation',
  'big_group_price_review',
  'partner_name_not_customer_name',
  'unsafe_pattern_absent',
  'group_quote_integrity',
]);

const criterionSchema = z.object({
  id: z.string().min(1),
  rule: criterionRuleSchema,
  weight: z.number().positive().default(1),
  critical: z.boolean().default(false),
  patterns: z.array(z.string().min(1)).min(1).optional(),
  field: z.enum(['name', 'people', 'date', 'transport']).optional(),
  flag: z.enum(['shouldSendReply', 'shouldAlertOwner', 'shouldSendImage', 'shouldSendOwnerImage', 'shouldSendGalleryImages', 'usedAi', 'priceJustGiven']).optional(),
  expected: z.boolean().optional(),
  turn: z.number().int().min(1).optional(),
  suppliedTurn: z.number().int().min(1).optional(),
  minFields: z.number().int().min(0).max(6).optional(),
  threshold: z.number().int().min(1).max(100).optional(),
  people: z.number().int().positive().optional(),
  planId: z.string().min(1).optional(),
  expectedTotal: z.number().int().positive().optional(),
}).strict().superRefine((criterion, ctx) => {
  if (['reply_must_match', 'reply_must_not_match', 'unsafe_pattern_absent'].includes(criterion.rule) && !criterion.patterns) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${criterion.rule} requires patterns` });
  }
  if (criterion.rule === 'known_field_not_reasked' && (!criterion.field || criterion.suppliedTurn === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'known_field_not_reasked requires field and suppliedTurn' });
  }
  if (criterion.rule === 'output_flag_equals' && (criterion.flag === undefined || criterion.expected === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'output_flag_equals requires flag and expected' });
  }
  if (criterion.rule === 'group_quote_integrity' && (criterion.people === undefined || criterion.planId === undefined || criterion.expectedTotal === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'group_quote_integrity requires people, planId, and expectedTotal' });
  }
});

export const scenarioSchema = z.object({
  id: z.string().min(1),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  lang: z.enum(['es', 'en']).default('es'),
  runner: z.enum(['message', 'follow_up']).default('message'),
  followUpMockReply: z.string().optional(),
  liveRuns: z.number().int().min(1).max(5).default(1),
  minLiveScore: z.number().min(0).max(100).optional(),
  mockPricing: z.object({
    planId: z.string().min(1),
    individual: z.number().int().positive(),
    couple: z.number().int().positive(),
  }).strict().optional(),
  turns: z.array(turnSchema).min(1),
  criteria: z.array(criterionSchema).min(1),
}).strict().superRefine((scenario, ctx) => {
  if (scenario.runner === 'follow_up' && scenario.followUpMockReply === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'follow_up runner requires followUpMockReply' });
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
