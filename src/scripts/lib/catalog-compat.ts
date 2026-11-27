/**
 * Catalog fields that bot releases before their introduction reject: the schema is
 * strict, so an older bot fails validation on the whole feed, keeps its last good copy
 * with `lastFetchOk=false`, and then answers every price/date/booking message with the
 * `dynamicDataUnavailable` fallback plus an owner alert. Publishing one of these fields
 * to prod is safe only after every running bot has been deployed from code that knows it.
 *
 * `level` is where the key lives: on the experience, on each of its sites, or on each
 * site plan. A field at another level needs a new branch in `findFieldsNewerThanProdBot`.
 * Remove an entry once the oldest production bot already supports the field.
 */
export const FIELDS_NEWER_THAN_PROD_BOT: ReadonlyArray<{ field: string; level: 'experience' | 'site' | 'plan'; since: string }> = [
  { field: 'sharedFacts', level: 'experience', since: 'the release after 2.5.1' },
  { field: 'quoteValue', level: 'site', since: 'the release after 2.5.1' },
  { field: 'cultureReels', level: 'experience', since: 'the release after 2.5.1' },
  { field: 'reels', level: 'plan', since: 'the release after 2.5.1' },
];

/**
 * Keys (or values) inside `plans.<id>.pricing` that older bots reject. `value` set means
 * only that enum value is new; omitted means the key itself is new.
 */
export const PLAN_PRICING_NEWER_THAN_PROD_BOT: ReadonlyArray<{ key: string; value?: string; since: string }> = [
  { key: 'calculation', value: 'couple_half_from_three', since: 'the release after 2.6.0' },
  { key: 'maxQuotedPeople', since: 'the release after 2.6.0' },
];

type CatalogNode = Record<string, unknown>;
interface CatalogShape {
  experiences?: Record<string, CatalogNode & { sites?: Record<string, CatalogNode & { plans?: Record<string, CatalogNode> }> }>;
}

/** Paths in the catalog that an older bot would reject. */
export function findFieldsNewerThanProdBot(json: unknown): string[] {
  const experiences = (json as CatalogShape | null)?.experiences ?? {};
  return [...findNewerFields(experiences), ...findNewerPlanPricing(experiences)];
}

function findNewerPlanPricing(experiences: NonNullable<CatalogShape['experiences']>): string[] {
  return Object.entries(experiences).flatMap(([experienceId, experience]) =>
    Object.entries(experience?.sites ?? {}).flatMap(([siteId, site]) =>
      Object.entries(site?.plans ?? {}).flatMap(([planId, plan]) => {
        const pricing = plan?.pricing;
        if (!pricing || typeof pricing !== 'object') return [];
        const node = pricing as CatalogNode;
        return PLAN_PRICING_NEWER_THAN_PROD_BOT
          .filter(({ key, value }) => Object.hasOwn(node, key) && (value == null || node[key] === value))
          .map(({ key, value, since }) => `experiences.${experienceId}.sites.${siteId}.plans.${planId}.pricing.${key}${value ? `=${value}` : ''} (needs ${since})`);
      })));
}

function findNewerFields(experiences: NonNullable<CatalogShape['experiences']>): string[] {
  return Object.entries(experiences).flatMap(([experienceId, experience]) =>
    FIELDS_NEWER_THAN_PROD_BOT.flatMap(({ field, level, since }) => {
      const sites = Object.entries(experience?.sites ?? {});
      const owners: Array<[string, CatalogNode | undefined]> = level === 'experience'
        ? [[`experiences.${experienceId}`, experience]]
        : level === 'site'
          ? sites.map(([siteId, site]) => [`experiences.${experienceId}.sites.${siteId}`, site])
          : sites.flatMap(([siteId, site]) => Object.entries(site?.plans ?? {})
            .map(([planId, plan]): [string, CatalogNode] => [`experiences.${experienceId}.sites.${siteId}.plans.${planId}`, plan]));
      return owners
        .filter(([, owner]) => owner && Object.hasOwn(owner, field))
        .map(([path]) => `${path}.${field} (needs ${since})`);
    }));
}
