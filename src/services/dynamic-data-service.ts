import { z } from 'zod';
import { logger } from '../config/logger.js';
import { dynamicDataSchema, type DynamicData, type DynamicMedia } from './dynamic-data-schema.js';

export const PRICING_NOT_AVAILABLE = 'PRICING_NOT_AVAILABLE';
export const AVAILABILITY_NOT_AVAILABLE = 'AVAILABILITY_NOT_AVAILABLE';

// Well-known addon ids. The remote feed owns the numbers, but these keys are the
// contract between bot-dynamic.json addons and the pricing calculator. Kept here
// (next to the transform that produces the items) so a rename is a single edit.
export const ADDON_ID_PRIVATE_TRANSPORT = 'private_transport';
export const ADDON_ID_APIARY_CATTLE = 'apiary_cattle';

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

export interface InternalPlanImage {
  id: string;
  experienceId: string;
  planId?: string;
  url: string;
  caption: string;
}

export interface InternalGalleryImage {
  url: string;
  caption: string;
}

export interface InternalDynamicMedia {
  ownerImage: { url: string; caption: string } | null;
  planImages: InternalPlanImage[];
  galleryImages: InternalGalleryImage[];
}

export interface InternalDynamicData {
  experiences: Record<string, InternalExperienceData>;
  media: InternalDynamicMedia | null;
}

export class DynamicDataService {
  private url: string;
  private refreshMs: number;
  private cache: {
    data: InternalDynamicData | null;
    etag: string | null;
    lastFetchMs: number;
    lastFetchOk: boolean;
  } = { data: null, etag: null, lastFetchMs: 0, lastFetchOk: false };

  private lastErrorLogMs = 0;
  private static readonly ERROR_LOG_INTERVAL_MS = 60_000;

  constructor(url: string, refreshMs: number) {
    this.url = url;
    this.refreshMs = refreshMs;
  }

  // Throttles repeated failure logs so a persistent R2 outage does not spam logs
  // when forceRefresh runs on every new conversation.
  private logError(payload: Record<string, unknown> | Error, msg: string): void {
    const now = Date.now();
    if (now - this.lastErrorLogMs < DynamicDataService.ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLogMs = now;
    logger.warn(payload, msg);
  }

  get isAvailable(): boolean {
    return this.cache.data !== null;
  }

  /** True only when the last remote fetch completed successfully (non-304, valid JSON). */
  get lastFetchOk(): boolean {
    return this.cache.lastFetchOk;
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

  // Bypasses the refresh throttle so team edits to bot-dynamic.json take effect
  // without restarting the container. Cheap: sends If-None-Match (304 on no change).
  async forceRefresh(): Promise<void> {
    await this.fetch();
  }

  private transformMedia(raw: DynamicMedia | null): InternalDynamicMedia | null {
    if (!raw) return null;
    const planImages: InternalPlanImage[] = raw.planImages.map(pi => ({
      id: pi.id,
      experienceId: pi.experienceId,
      planId: pi.planId,
      url: pi.url,
      caption: pi.caption,
    }));
    const galleryImages: InternalGalleryImage[] = raw.galleryImages.map(gi => ({
      url: gi.url,
      caption: gi.caption,
    }));
    const ownerImage = raw.ownerImage
      ? { url: raw.ownerImage.url, caption: raw.ownerImage.caption }
      : null;
    return { ownerImage, planImages, galleryImages };
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
        this.cache.lastFetchOk = true;
        return;
      }

      if (!res.ok) {
        this.logError({ status: res.status }, '[DYNAMIC] fetch failed');
        this.cache.lastFetchOk = false;
        return;
      }

      const etag = res.headers.get('etag');
      const raw = await res.json();
      const validated = dynamicDataSchema.parse(raw);
      const transformed = this.transform(validated);

      this.cache = { data: transformed, etag, lastFetchMs: Date.now(), lastFetchOk: true };
      logger.info(
        { experiences: Object.keys(transformed.experiences) },
        '[DYNAMIC] data updated',
      );
    } catch (err) {
      this.cache.lastFetchOk = false;
      if (err instanceof z.ZodError) {
        this.logError({ issues: err.issues }, '[DYNAMIC] validation failed');
      } else {
        this.logError(err instanceof Error ? err : { err: String(err) }, '[DYNAMIC] fetch error');
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

    return { experiences, media: this.transformMedia(data.media ?? null) };
  }
}
