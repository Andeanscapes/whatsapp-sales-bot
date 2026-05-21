import { z } from 'zod';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function substituteTokens(text: string): string {
  return text
    .replace(/\{\{OWNER_NAME\}\}/g, env.OWNER_NAME)
    .replace(/\{\{PARTNER_NAME\}\}/g, env.PARTNER_NAME);
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const availableDateSchema = z.object({
  date: dateSchema,
  status: z.enum(['available', 'limited', 'unavailable', 'soldout']),
  slotsApprox: z.number().int().nullable(),
  internalNote: z.string().optional(),
});

const pricingItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  pricePerPerson: z.number().int().nullable().optional(),
  couplePrice: z.number().int().nullable().optional(),
  peopleIncluded: z.number().int().nullable().optional(),
  minimumPeople: z.number().int().nullable().optional(),
  publiclyShow: z.boolean(),
  internalNote: z.string().optional(),
  botResponse: z.string().optional(),
});

const commonQuestionSchema = z.object({
  lang: z.enum(['es', 'en']).optional(),
  intent: z.string(),
  question: z.string(),
  answer: z.string(),
});

const experienceSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  shortDescription: z.string(),
  meetingPoint: z.string(),
  route: z.object({
    fromBogota: z.string(),
    localAccess: z.string(),
    botRules: z.array(z.string()),
  }).passthrough(),
  availability: z.object({
    lastUpdated: dateSchema,
    timezone: z.string(),
    availableDates: z.array(availableDateSchema),
    botRule: z.string(),
  }),
  pricing: z.object({
    currency: z.string(),
    lastUpdated: dateSchema,
    items: z.array(pricingItemSchema),
    botRules: z.array(z.string()),
  }),
  included: z.array(z.string()),
  notIncludedUnlessConfirmed: z.array(z.string()),
  whatToBring: z.array(z.string()),
  difficulty: z.object({
    level: z.string(),
    notes: z.array(z.string()),
  }),
  reservationFlow: z.array(z.string()),
  commonQuestions: z.array(commonQuestionSchema),
}).passthrough();

const andeanScapesSchema = z.object({
  skillVersion: z.string(),
  business: z.object({
    name: z.string(),
    location: z.string(),
    mainExperience: z.string(),
    publicTourUrlEnv: z.string(),
    languages: z.array(z.string()),
  }).passthrough(),
  experiences: z.array(experienceSchema).min(1),
});

const signalSchema = z.object({
  id: z.string(),
  score: z.number().int(),
  keywords: z.array(z.string()).optional(),
  patterns: z.array(z.string()).optional(),
});

const negativeSignalSchema = z.object({
  id: z.string(),
  score: z.number().int(),
  keywords: z.array(z.string()),
});

const salesStrategySchema = z.object({
  hotLeadThreshold: z.number().int(),
  urgentLeadThreshold: z.number().int(),
  maxScore: z.number().int(),
  signals: z.array(signalSchema),
  negativeSignals: z.array(negativeSignalSchema),
  ownerAlertTemplate: z.string(),
}).passthrough();

const mediaPolicySchema = z.object({
  sendImagesEnabled: z.boolean(),
  maxImagesPerCustomerPer72h: z.number().int(),
  preferTourUrlOverImages: z.boolean(),
  botRules: z.array(z.string()),
});

const imageSchema = z.object({
  id: z.string(),
  experienceId: z.string(),
  type: z.string(),
  value: z.string(),
  caption: z.string(),
});

const mediaSchema = z.object({
  mediaPolicy: mediaPolicySchema,
  images: z.array(imageSchema),
});

const langFallbackSchema = z.object({
  optOutConfirmation: z.string(),
  askName: z.string(),
  askPeople: z.string(),
  askDate: z.string(),
  askTransport: z.string(),
  aiFailureQualified: z.string(),
  messageLimitReached: z.string(),
  messageLimitAfterPrice: z.string(),
  handoffMessage: z.string(),
  repairPriceNotPresented: z.string(),
  repairPricePresented: z.string(),
  handedOffVariant0: z.string(),
  handedOffVariant1: z.string(),
  handedOffTypo: z.string(),
  handedOffQuestion: z.string(),
  handedOffThanks: z.string(),
  adventureClarifier: z.string(),
  disculpaYaDicho: z.string(),
  objectionResolvedContinue: z.string(),
  partnerConsultSummary: z.string(),
  safeReservationHandoff: z.string(),
  safeReservationHandoffAlt1: z.string(),
  safeReservationHandoffAlt2: z.string(),
  softCloseReply: z.string(),
  confirmReservationPrompt: z.string(),
  answerQuestionBeforeQualification: z.string(),
  itineraryReply: z.string(),
});

const fallbackRepliesSchema = z.object({
  es: langFallbackSchema,
  en: langFallbackSchema,
});

export type AndeanScapesSkill = z.infer<typeof andeanScapesSchema>;
export type SalesStrategySkill = z.infer<typeof salesStrategySchema>;
export type MediaSkill = z.infer<typeof mediaSchema>;
export type FallbackReplies = z.infer<typeof fallbackRepliesSchema>;

export interface Skills {
  andeanScapes: AndeanScapesSkill;
  salesStrategy: SalesStrategySkill;
  media: MediaSkill;
  fallbackReplies: FallbackReplies;
}

let cached: Skills | null = null;

function loadJson(filename: string): unknown {
  const path = join(__dirname, '..', 'data', filename);
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(substituteTokens(raw));
}

export function loadSkills(): Skills {
  const rawAndean = loadJson('andean-scapes.skill.json');
  const rawSales = loadJson('sales-strategy.skill.json');
  const rawMedia = loadJson('media.skill.json');
  const rawFallback = loadJson('fallback-replies.json');

  const skills: Skills = {
    andeanScapes: andeanScapesSchema.parse(rawAndean),
    salesStrategy: salesStrategySchema.parse(rawSales),
    media: mediaSchema.parse(rawMedia),
    fallbackReplies: fallbackRepliesSchema.parse(rawFallback),
  };

  cached = skills;
  return skills;
}

export function getSkills(): Skills {
  if (!cached) {
    return loadSkills();
  }
  return cached;
}
