import type { DynamicData } from './dynamic-data-schema.js';
import { todayInTimeZone } from './dynamic-data-service.js';

/**
 * Operator (Telegram seller) views over the full catalog, paused sites included.
 * Never used to build customer replies or the LLM prompt.
 */

type RawSite = DynamicData['experiences'][string]['sites'][string];
type RawPlan = RawSite['plans'][string];

export interface OperatorSite {
  id: string;
  name: string;
  aliases: string[];
  active: boolean;
  site: RawSite;
}

export interface OperatorPlanCard {
  id: string;
  name: string;
  tier: string | null;
  active: boolean;
  individual: number | null;
  couple: number | null;
  card: { url: string; caption: string } | null;
}

export interface OperatorDate {
  date: string;
  status: string;
  slots: number | null;
}

export interface OperatorPhoto {
  url: string;
  caption: string;
}

const BOOKABLE_DATE_STATUSES = new Set(['available', 'limited']);

export function normalizeLabel(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function listOperatorSites(raw: DynamicData): OperatorSite[] {
  return Object.entries(raw.experiences).flatMap(([, exp]) =>
    Object.entries(exp.sites).map(([id, site]) => ({
      id,
      name: site.name ?? id,
      aliases: site.selectionAliases ?? [],
      active: site.status !== 'inactive',
      site,
    })),
  );
}

export function resolveOperatorSite(sites: OperatorSite[], query: string): OperatorSite | null {
  const wanted = normalizeLabel(query);
  if (!wanted) return null;
  return sites.find(s =>
    normalizeLabel(s.id) === wanted
    || normalizeLabel(s.name) === wanted
    || s.aliases.some(alias => normalizeLabel(alias) === wanted),
  ) ?? null;
}

export function listPlanCards(site: RawSite): OperatorPlanCard[] {
  return Object.entries(site.plans).map(([id, plan]: [string, RawPlan]) => {
    const image = plan.media.planImages[0];
    return {
      id,
      name: plan.name ?? id,
      tier: plan.tier ?? null,
      active: plan.status !== 'inactive',
      individual: plan.pricing?.individual ?? null,
      couple: plan.pricing?.couple ?? null,
      card: image ? { url: image.url, caption: image.caption } : null,
    };
  });
}

export function listFutureDates(site: RawSite, today = todayInTimeZone(site.availability.tz)): OperatorDate[] {
  return site.availability.dates
    .filter(d => d.d >= today && BOOKABLE_DATE_STATUSES.has(d.s))
    .map(d => ({ date: d.d, status: d.s, slots: d.sl ?? null }));
}

export function listGalleryThemes(site: RawSite): string[] {
  const themes = new Set<string>(site.media.types);
  for (const photo of site.media.gallery) {
    if (photo.type) themes.add(photo.type);
  }
  return [...themes];
}

export function listGalleryPhotos(site: RawSite, theme: string): OperatorPhoto[] {
  const wanted = normalizeLabel(theme);
  return site.media.gallery
    .filter(photo => photo.type !== undefined && normalizeLabel(photo.type) === wanted)
    .map(photo => ({ url: photo.url, caption: photo.caption }));
}
