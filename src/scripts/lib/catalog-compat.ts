/**
 * Catalog fields that bot releases before their introduction reject: the schema is
 * strict, so an older bot fails validation on the whole feed, keeps its last good copy
 * with `lastFetchOk=false`, and then answers every price/date/booking message with the
 * `dynamicDataUnavailable` fallback plus an owner alert. Publishing one of these fields
 * to prod is safe only after every running bot has been deployed from code that knows it.
 *
 * `level` is where the key lives: on the experience, or on each of its sites. A field at
 * another level needs a new branch in `findFieldsNewerThanProdBot` before it is listed.
 * Remove an entry once the oldest production bot already supports the field.
 */
export const FIELDS_NEWER_THAN_PROD_BOT: ReadonlyArray<{ field: string; level: 'experience' | 'site'; since: string }> = [
  { field: 'sharedFacts', level: 'experience', since: 'the release after 2.5.1' },
  { field: 'quoteValue', level: 'site', since: 'the release after 2.5.1' },
];

interface CatalogShape {
  experiences?: Record<string, Record<string, unknown> & { sites?: Record<string, Record<string, unknown>> }>;
}

/** Paths in the catalog that an older bot would reject. */
export function findFieldsNewerThanProdBot(json: unknown): string[] {
  const experiences = (json as CatalogShape | null)?.experiences ?? {};
  return Object.entries(experiences).flatMap(([experienceId, experience]) =>
    FIELDS_NEWER_THAN_PROD_BOT.flatMap(({ field, level, since }) => {
      const owners: Array<[string, Record<string, unknown> | undefined]> = level === 'experience'
        ? [[`experiences.${experienceId}`, experience]]
        : Object.entries(experience?.sites ?? {}).map(([siteId, site]) => [`experiences.${experienceId}.sites.${siteId}`, site]);
      return owners
        .filter(([, owner]) => owner && Object.hasOwn(owner, field))
        .map(([path]) => `${path}.${field} (needs ${since})`);
    }));
}
