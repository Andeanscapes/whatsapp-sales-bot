import { z } from 'zod';
import { logger } from '../config/logger.js';
import { dynamicDataSchema, type DynamicData } from './dynamic-data-schema.js';

export const PRICING_NOT_AVAILABLE = 'PRICING_NOT_AVAILABLE';
export const AVAILABILITY_NOT_AVAILABLE = 'AVAILABILITY_NOT_AVAILABLE';

export function shouldStripStaticPricing(dynamicSkillUrl: string, hasDynamicData: boolean): boolean {
  return dynamicSkillUrl.trim().length > 0 && !hasDynamicData;
}

export type InternalPricingItem = {
  id: string;
  planId?: string;
  label: string;
  pricePerPerson?: number | null;
  couplePrice?: number | null;
  peopleIncluded?: number | null;
  publiclyShow: boolean;
};

export interface InternalExperienceData {
  pricing: {
    currency: string;
    lastUpdated: string;
    items: InternalPricingItem[];
    botRules: string[];
  };
  availability: {
    lastUpdated: string;
    timezone: string;
    availableDates: Array<{
      date: string;
      status: string;
      slotsApprox: number | null;
    }>;
    botRule: string;
  };
}

export interface InternalDynamicData {
  experiences: Record<string, InternalExperienceData>;
}

export class DynamicDataService {
  private url: string;
  private refreshMs: number;
  private cache: {
    data: InternalDynamicData | null;
    etag: string | null;
    lastFetchMs: number;
  } = { data: null, etag: null, lastFetchMs: 0 };

  constructor(url: string, refreshMs: number) {
    this.url = url;
    this.refreshMs = refreshMs;
  }

  get isAvailable(): boolean {
    return this.cache.data !== null;
  }

  getData(): InternalDynamicData | null {
    return this.cache.data;
  }

  async refreshIfStale(): Promise<void> {
    if (this.refreshMs <= 0) return;
    const now = Date.now();
    if (now - this.cache.lastFetchMs < this.refreshMs) return;
    await this.fetch();
  }

  private async fetch(): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (this.cache.etag) {
        headers['If-None-Match'] = this.cache.etag;
      }

      const res = await fetch(this.url, {
        headers,
        signal: AbortSignal.timeout(5000),
      });

      if (res.status === 304) {
        this.cache.lastFetchMs = Date.now();
        return;
      }

      if (!res.ok) {
        logger.warn({ status: res.status }, '[DYNAMIC] fetch failed');
        return;
      }

      const etag = res.headers.get('etag');
      const raw = await res.json();
      const validated = dynamicDataSchema.parse(raw);
      const transformed = this.transform(validated);

      this.cache = { data: transformed, etag, lastFetchMs: Date.now() };
      logger.info(
        { experiences: Object.keys(transformed.experiences) },
        '[DYNAMIC] data updated',
      );
    } catch (err) {
      if (err instanceof z.ZodError) {
        logger.error({ issues: err.issues }, '[DYNAMIC] validation failed');
      } else {
        logger.error(err, '[DYNAMIC] fetch error');
      }
    }
  }

  private transform(data: DynamicData): InternalDynamicData {
    const experiences: Record<string, InternalExperienceData> = {};
    const today = data.updated?.split('T')[0] ?? new Date().toISOString().split('T')[0];

    for (const [expId, dynExp] of Object.entries(data.experiences)) {
      const items: InternalPricingItem[] = [];

      for (const [planId, planPricing] of Object.entries(dynExp.pricing.plans)) {
        if (planPricing.individual != null) {
          items.push({
            id: `${planId}_individual`,
            planId,
            label: `${planId}_individual`,
            pricePerPerson: planPricing.individual,
            publiclyShow: true,
          });
        }
        if (planPricing.couple != null) {
          items.push({
            id: `${planId}_couple`,
            planId,
            label: `${planId}_couple`,
            couplePrice: planPricing.couple,
            publiclyShow: true,
          });
        }
      }

      for (const [addonId, addon] of Object.entries(dynExp.pricing.addons ?? {})) {
        items.push({
          id: addonId,
          label: addon.label,
          pricePerPerson: addon.pp ?? null,
          couplePrice: addon.price ?? null,
          peopleIncluded: addon.max ?? null,
          publiclyShow: true,
          planId: addon.plans?.[0],
        });
      }

      const availableDates = dynExp.availability.dates.map(d => ({
        date: d.d,
        status: d.s,
        slotsApprox: d.sl ?? null,
      }));

      const botRules = dynExp.pricing.rules
        ? dynExp.pricing.rules.split('|').map(s => s.trim()).filter(Boolean)
        : [PRICING_NOT_AVAILABLE];

      const botRule = dynExp.availability.rule || AVAILABILITY_NOT_AVAILABLE;

      experiences[expId] = {
        pricing: {
          currency: dynExp.pricing.currency,
          lastUpdated: today,
          items,
          botRules,
        },
        availability: {
          lastUpdated: today,
          timezone: dynExp.availability.tz,
          availableDates,
          botRule,
        },
      };
    }

    return { experiences };
  }
}
