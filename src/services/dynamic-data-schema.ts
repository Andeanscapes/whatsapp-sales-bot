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
    rules: z.string().default(''),
  }).strict(),
  availability: z.object({
    tz: z.string().default('America/Bogota'),
    dates: z.array(dynamicDateSchema).default([]),
    rule: z.string().default(''),
  }).strict(),
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
  media: dynamicMediaSchema.optional(),
  experiences: z.record(dynamicExperienceSchema),
}).strict();

export type DynamicData = z.infer<typeof dynamicDataSchema>;
export type DynamicExperience = z.infer<typeof dynamicExperienceSchema>;
export type DynamicMedia = z.infer<typeof dynamicMediaSchema>;
export type DynamicPlanImage = z.infer<typeof dynamicPlanImageSchema>;
