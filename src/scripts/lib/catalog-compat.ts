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

type CatalogNode = Record<string, unknown>;
interface CatalogShape {
  experiences?: Record<string, CatalogNode & { sites?: Record<string, CatalogNode & { plans?: Record<string, CatalogNode> }> }>;
}

/** Paths in the catalog that an older bot would reject. */
export function findFieldsNewerThanProdBot(json: unknown): string[] {
  const experiences = (json as CatalogShape | null)?.experiences ?? {};
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
