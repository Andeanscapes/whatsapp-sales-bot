import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { allSitesActivePayload, useAllSitesActive } from './helpers/all-sites-catalog.js';
import { dynamicDataSchema } from '../services/dynamic-data-schema.js';
import { getSkills } from '../services/skill-loader.js';
import { getActiveExperience, resolveCurrentPlanId } from '../services/product-registry.js';
import { processMessage } from '../services/response-engine.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';

const CORE = 'core_2d1n_chivor';
const PRIME = 'prime_2d1n_chivor';

let db: Database.Database;
let repos: Repositories;

beforeEach(() => {
  useAllSitesActive();
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
});
afterEach(() => db.close());

describe('resolveCurrentPlanId', () => {
  it.each(['duplicate', 'current', 'cross-site'] as const)('rejects %s legacy aliases at runtime validation', kind => {
    const payload = dynamicDataSchema.parse(allSitesActivePayload());
    const sites = payload.experiences.emerald_mining_tour.sites;
    if (kind === 'duplicate') sites.chivor.plans[PRIME].legacyPlanIds = ['2d1n_mining'];
    if (kind === 'current') sites.chivor.plans[PRIME].legacyPlanIds = [CORE];
    if (kind === 'cross-site') sites.coscuez.plans.core_2d1n_coscuez.legacyPlanIds = ['2d1n_mining'];

    const result = dynamicDataSchema.safeParse(payload);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some(issue => issue.path.includes('legacyPlanIds'))).toBe(true);
  });

  it('keeps a current plan id as it is', () => {
    expect(resolveCurrentPlanId(getActiveExperience(getSkills()), CORE)).toBe(CORE);
  });

  it('maps the retired 2D/1N mining id to CORE and the retired 3D/2N rural id to PRIME', () => {
    const exp = getActiveExperience(getSkills());
    expect(resolveCurrentPlanId(exp, '2d1n_mining')).toBe(CORE);
    expect(resolveCurrentPlanId(exp, '3d2n_rural')).toBe(PRIME);
  });

  it('returns null for an unknown id and for an empty id', () => {
    const exp = getActiveExperience(getSkills());
    expect(resolveCurrentPlanId(exp, 'plan_that_never_existed')).toBeNull();
    expect(resolveCurrentPlanId(exp, null)).toBeNull();
    expect(resolveCurrentPlanId(exp, undefined)).toBeNull();
  });

  it('moves a lead on a retired plan id to its catalog successor', async () => {
    const phone = '573001990098';
    repos.conversation.upsert(phone, { collected_plan: '2d1n_mining' });

    await processMessage({ repos, customerPhone: phone, message: 'Quiero seguir con ese plan' });

    expect(repos.conversation.getCollectedPlan(phone)).toBe(CORE);
  });
});
