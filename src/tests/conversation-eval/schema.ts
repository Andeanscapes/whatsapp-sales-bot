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
});

const scoreCardSchema = z.object({
  qualification: z.object({
    minFieldsBeforeEnd: z.number().int().min(0).max(6).optional(),
  }).optional(),
  salesStrategy: z.object({
    forbidPriceBeforeMinFields: z.number().int().min(1).max(6).optional(),
  }).optional(),
  closeStrategy: z.object({
    requireHandoffOnReserve: z.boolean().optional(),
  }).optional(),
  safety: z.object({
    forbidPatterns: z.array(z.string()).optional(),
  }).optional(),
  mediaGuards: z.object({
    maxImagesPerTurn: z.number().int().min(1).optional(),
  }).optional(),
  weights: z.object({
    qualification: z.number().min(0).max(1).optional(),
    salesStrategy: z.number().min(0).max(1).optional(),
    closeStrategy: z.number().min(0).max(1).optional(),
    safety: z.number().min(0).max(1).optional(),
    mediaGuards: z.number().min(0).max(1).optional(),
  }).optional(),
}).strict();

export const scenarioSchema = z.object({
  id: z.string().min(1),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  lang: z.enum(['es', 'en']).default('es'),
  turns: z.array(turnSchema).min(1),
  scorecard: scoreCardSchema.default({}),
}).strict();

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioTurn = z.infer<typeof turnSchema>;

const dimensionScoreSchema = z.object({
  qualification: z.number(),
  salesStrategy: z.number(),
  closeStrategy: z.number(),
  safety: z.number(),
  mediaGuards: z.number(),
});

const llmJudgeSchema = z.object({
  qualification: z.number(),
  salesStrategy: z.number(),
  closeStrategy: z.number(),
  safety: z.number(),
  mediaGuards: z.number(),
  total: z.number(),
  approved: z.boolean(),
  notes: z.string(),
  recommendations: z.string(),
});

const scenarioResultSchema = z.object({
  id: z.string(),
  scores: dimensionScoreSchema,
  total: z.number(),
  hardFail: z.boolean(),
  notes: z.array(z.string()),
  turnResults: z.array(z.object({
    user: z.string(),
    reply: z.string(),
    leadScore: z.number(),
    shouldAlertOwner: z.boolean(),
    shouldSendImage: z.boolean(),
  })),
  llmJudge: llmJudgeSchema.optional(),
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
  mode: z.enum(['deterministic', 'live']),
  gitSha: z.string(),
  generatedAt: z.string(),
  suite: suiteMetaSchema,
  scenarios: z.array(scenarioResultSchema),
});

export type EvalReport = z.infer<typeof evalReportSchema>;
export type ScenarioResult = z.infer<typeof scenarioResultSchema>;
export type DimensionScores = z.infer<typeof dimensionScoreSchema>;
export type LlmJudgeResult = z.infer<typeof llmJudgeSchema>;
