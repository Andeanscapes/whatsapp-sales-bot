import { readFileSync } from 'node:fs';
import { dynamicDataSchema } from '../../services/dynamic-data-schema.js';
import { DynamicDataService, transformDynamicData, type InternalDynamicData } from '../../services/dynamic-data-service.js';
import { loadSkills, setDynamicService, type Skills } from '../../services/skill-loader.js';

const CI_FIXTURE = new URL('../../../scripts/bot-dynamic.ci.json', import.meta.url);

interface RawFixture {
  experiences: Record<string, { sites: Record<string, {
    status?: string;
    unavailableNote?: string;
    plans: Record<string, { pricing?: { individual?: number; couple?: number } }>;
  }> }>;
}

/**
 * Removes plans from a payload. For rules defined on a two-plan site ("el otro
 * plan"), which a third plan makes ambiguous by design.
 */
export function withoutPlans(payload: unknown, planIds: string[]): unknown {
  for (const experience of Object.values((payload as RawFixture).experiences)) {
    for (const site of Object.values(experience.sites)) {
      for (const planId of planIds) delete site.plans[planId];
    }
  }
  return payload;
}

/** Copies one plan's pricing onto another, to pin a cross-site price collision. */
export function withSamePricing(payload: unknown, fromPlanId: string, toPlanId: string): unknown {
  const sites = Object.values((payload as RawFixture).experiences).flatMap(experience => Object.values(experience.sites));
  const from = sites.find(site => site.plans[fromPlanId])?.plans[fromPlanId];
  const to = sites.find(site => site.plans[toPlanId])?.plans[toPlanId];
  if (!from?.pricing || !to) throw new Error(`withSamePricing: unknown plan ${fromPlanId} or ${toPlanId}`);
  to.pricing = { ...to.pricing, individual: from.pricing.individual, couple: from.pricing.couple };
  return payload;
}

/**
 * The CI fixture with every paused destination reopened. The multi-site regression
 * net (site switching, other-site photos, cross-site cards) must not depend on which
 * destinations happen to be on sale today. Returned as plain JSON so callers can
 * edit it before parsing, as the fixture-reading tests already do.
 */
export function allSitesActivePayload(): unknown {
  const payload = JSON.parse(readFileSync(CI_FIXTURE, 'utf8')) as RawFixture;
  for (const experience of Object.values(payload.experiences)) {
    for (const site of Object.values(experience.sites)) {
      delete site.status;
      delete site.unavailableNote;
    }
  }
  return payload;
}

/** Serves fixed data and never fetches, so a background refresh cannot mark it stale. */
class SeededDynamicService extends DynamicDataService {
  constructor(data: InternalDynamicData) {
    super('', 0);
    this.seedData(data);
  }

  override async refreshIfStale(): Promise<void> {}

  override async forceRefresh(): Promise<void> {}
}

/** Loads skills from the CI fixture with every destination active. */
export function useAllSitesActive(payload: unknown = allSitesActivePayload()): Skills {
  setDynamicService(new SeededDynamicService(transformDynamicData(dynamicDataSchema.parse(payload))));
  return loadSkills();
}
