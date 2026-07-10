import { z } from 'zod';

const cdnMediaUrlSchema = z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'cdn.andeanscapes.com';
  } catch {
    return false;
  }
}, 'Media URL must use https://cdn.andeanscapes.com');

export const dynamicDateSchema = z.object({
  d: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  s: z.enum(['available', 'limited', 'unavailable', 'soldout']),
  sl: z.number().int().optional(),
}).strict();

export const dynamicPlanPricingSchema = z.object({
  individual: z.number().int().optional(),
  couple: z.number().int().optional(),
}).strict();

export const dynamicAddonSchema = z.object({
  label: z.string(),
  pp: z.number().int().optional(),
  price: z.number().int().optional(),
  max: z.number().int().optional(),
  plans: z.array(z.string()).optional(),
}).strict();

export const dynamicExperienceSchema = z.object({
  pricing: z.object({
    currency: z.string().default('COP'),
    plans: z.record(dynamicPlanPricingSchema),
    addons: z.record(dynamicAddonSchema).default({}),
    paymentPolicy: z.object({
      depositRequired: z.boolean(),
      depositPercentage: z.number().min(0).max(100),
      remainingBalancePercentage: z.number().min(0).max(100).optional(),
      paymentMethods: z.array(z.string()),
      paymentDataReference: z.literal('payments'),
      requiresAvailabilityValidation: z.boolean().optional(),
      requiresPaymentValidation: z.boolean().optional(),
    }).strict().optional(),
    rules: z.union([z.string(), z.array(z.string())]).default(''),
  }).strict(),
  availability: z.object({
    tz: z.string().default('America/Bogota'),
    dates: z.array(dynamicDateSchema).default([]),
    rule: z.string().default(''),
  }).strict().default({ tz: 'America/Bogota', dates: [], rule: '' }),
}).strict();

export const dynamicOwnerImageSchema = z.object({
  url: cdnMediaUrlSchema,
  caption: z.string().default(''),
}).strict();

export const dynamicPlanImageSchema = z.object({
  id: z.string().min(1),
  experienceId: z.string().min(1),
  planId: z.string().optional(),
  url: cdnMediaUrlSchema,
  caption: z.string().default(''),
}).strict();

export const dynamicGalleryImageSchema = z.object({
  url: cdnMediaUrlSchema,
  caption: z.string().default(''),
}).strict();

export const dynamicMediaSchema = z.object({
  ownerImage: dynamicOwnerImageSchema.optional(),
  planImages: z.array(dynamicPlanImageSchema).default([]),
  galleryImages: z.array(dynamicGalleryImageSchema).default([]),
}).strict();

export const dynamicDataSchema = z.object({
  v: z.number().int(),
  updated: z.string(),
  payments: z.object({
    currency: z.string(),
    deposit: z.object({
      type: z.literal('percentage'),
      value: z.number().min(0).max(100),
      label: z.string(),
      calculationRule: z.string(),
      remainingBalancePercentage: z.number().min(0).max(100),
    }).strict(),
    methods: z.array(z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      enabled: z.boolean(),
      phoneNumber: z.string().regex(/^\d{10}$/).optional(),
      formattedPhoneNumber: z.string().optional(),
      countryCode: z.string().regex(/^\+\d{1,3}$/).optional(),
      fullPhoneNumber: z.string().regex(/^\+\d{10,15}$/).optional(),
      currency: z.string(),
      instructions: z.string(),
      paymentLink: z.string().url().refine(value => new URL(value).protocol === 'https:', 'Payment URL must use HTTPS').nullable().optional(),
      requiresPaymentProof: z.boolean(),
    }).strict()),
    confirmation: z.object({
      automatic: z.boolean(),
      requiresTeamValidation: z.boolean(),
      message: z.string(),
    }).strict(),
    displayPolicy: z.object({
      showAfterAvailabilityValidation: z.boolean(),
      showWhenCustomerWantsToReserve: z.boolean(),
      showWhenCustomerAsksHowToPay: z.boolean(),
      doNotRequestPaymentBeforeAvailabilityValidation: z.boolean(),
      neverRequestFullPaymentWithoutConfirmation: z.boolean(),
    }).strict(),
  }).strict().optional(),
  media: dynamicMediaSchema.optional(),
  experiences: z.record(dynamicExperienceSchema),
}).strict();

export type DynamicData = z.infer<typeof dynamicDataSchema>;
export type DynamicExperience = z.infer<typeof dynamicExperienceSchema>;
export type DynamicMedia = z.infer<typeof dynamicMediaSchema>;
export type DynamicPlanImage = z.infer<typeof dynamicPlanImageSchema>;
