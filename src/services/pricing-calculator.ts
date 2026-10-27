import { createHash } from 'node:crypto';
import { getPlans, getSites, type ActiveExperience } from './product-registry.js';
import { ADDON_ID_APIARY_CATTLE, ADDON_ID_PRIVATE_TRANSPORT } from './dynamic-data-service.js';

export type TransportNeed = 'own' | 'public_bus' | 'from_bogota' | 'yes' | null | undefined;

export interface PriceQuoteInput {
  planId: string | null | undefined;
  siteId?: string | null;
  people: unknown;
  transportNeed?: TransportNeed;
  includeApiaryCattle?: boolean;
  addonIds?: string[];
}

export interface PriceQuote {
  planId: string;
  people: number;
  currency: string;
  planTotal: number;
  addonsTotal: number;
  transportTotal: number | null;
  total: number | null;
  requiresTransportConfirmation: boolean;
  separateAddons: Array<{ id: string; amount: number | null; requiresConfirmation: boolean }>;
}

export interface StartingPrice {
  amount: number;
  currency: string;
  planId: string;
}

export interface CheaperPlanQuote {
  planId: string;
  planName: string;
  siteId: string | null;
  siteName: string;
  /** Complete total with the same requested transport for every option. */
  total: number;
  planTotal: number;
  currency: string;
  requiresTransportConfirmation: boolean;
}

/** Cheaper confirmed totals. Null means comparison is incomplete, not that no cheaper plan exists. */
export function listCheaperPlanQuotes(
  exp: ActiveExperience,
  referencePlanId: string | null | undefined,
  people: number,
  transportNeed?: TransportNeed,
): CheaperPlanQuote[] | null {
  const plans = getPlans(exp);
  const referencePlan = plans.find(plan => plan.id === referencePlanId);
  if (!referencePlan?.siteId) return null;
  const quoteOf = (planId: string): PriceQuote | null => calculatePriceQuote(exp, { planId, people, transportNeed });
  const reference = quoteOf(referencePlan.id);
  if (!reference || reference.total == null || reference.requiresTransportConfirmation) return null;
  const referenceTotal = reference.total;

  const quoted = plans.flatMap(plan => {
    const quote = plan.siteId ? quoteOf(plan.id) : null;
    return quote && quote.total != null && !quote.requiresTransportConfirmation
      ? [{ plan, quote, amount: quote.total }] : [];
  });
  if (quoted.length !== plans.length) return null;
  const local = quoted.filter(({ plan }) => plan.siteId === referencePlan.siteId);
  const cheapestLocal = Math.min(...local.map(({ amount }) => amount));
  const cheaper = quoted.filter(({ plan, amount }) => plan.siteId === referencePlan.siteId
    ? plan.id !== referencePlan.id && amount < referenceTotal
    : amount < cheapestLocal);
  const siteNames = new Map(getSites(exp).map(site => [site.id, site.name ?? site.id]));

  return cheaper
    .sort((a, b) => a.amount - b.amount)
    .map(({ plan, quote, amount }) => ({
      planId: plan.id,
      planName: plan.name,
      siteId: plan.siteId ?? null,
      siteName: plan.siteId ? siteNames.get(plan.siteId) ?? plan.siteId : '',
      total: amount,
      planTotal: quote.planTotal,
      currency: quote.currency,
      requiresTransportConfirmation: quote.requiresTransportConfirmation,
    }));
}

/** The single alternative whose total (or plan-only total) the reply quotes; null when none or several. */
export function findQuotedAlternative(alternatives: CheaperPlanQuote[], replyAmounts: readonly number[]): string | null {
  const amounts = new Set(replyAmounts);
  const matches = alternatives.filter(option => amounts.has(option.total) || amounts.has(option.planTotal));
  return matches.length === 1 ? matches[0].planId : null;
}

function toPeople(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function getPlanPrices(exp: ActiveExperience, planId: string, siteId?: string, perPersonOnly = false): { individual: number; couple: number } | null {
  const planItems = exp.pricing.items.filter(item => item.kind !== 'addon' && item.planId === planId
    && (!siteId || !item.siteId || item.siteId === siteId));
  const individual = planItems.find(item => item.pricePerPerson != null)?.pricePerPerson;
  const couple = planItems.find(item => item.couplePrice != null)?.couplePrice;
  return individual != null && (couple != null || perPersonOnly)
    ? { individual, couple: couple ?? individual * 2 } : null;
}

// The 5+ formula divides the couple price by 2 per person. Remote couple prices
// are whole COP and may be odd, so round to the nearest peso to avoid emitting a
// fractional currency amount to the customer.
function calculatePlanTotal(people: number, individual: number, couple: number): number {
  if (people === 1) return individual;
  if (people === 2) return couple;
  if (people === 3) return couple + individual;
  if (people === 4) return couple * 2;
  return Math.round((couple / 2) * people);
}

export function calculatePriceQuote(exp: ActiveExperience, input: PriceQuoteInput): PriceQuote | null {
  const planId = input.planId ?? exp.plans[0]?.id;
  if (!planId) return null;
  const plan = exp.plans.find(candidate => candidate.id === planId);
  if (!plan || (input.siteId && plan.siteId && input.siteId !== plan.siteId)) return null;
  const siteId = input.siteId ?? plan?.siteId;

  const people = toPeople(input.people);
  if (people == null) return null;

  const prices = getPlanPrices(exp, planId, siteId ?? undefined, plan.calculation === 'per_person');
  if (!prices) return null;

  const planTotal = plan.calculation === 'per_person'
    ? prices.individual * people
    : plan.calculation === 'pairs_plus_single'
      ? Math.floor(people / 2) * prices.couple + (people % 2) * prices.individual
      : calculatePlanTotal(people, prices.individual, prices.couple);
  const eligible = exp.pricing.items.filter(item => item.kind === 'addon'
    && (!item.planId || item.planId === planId)
    && (!siteId || !item.siteId || item.siteId === siteId));
  const requested = new Set(input.addonIds ?? []);
  if (input.includeApiaryCattle) requested.add(ADDON_ID_APIARY_CATTLE);
  const wantsTransport = input.transportNeed === 'from_bogota' || input.transportNeed === 'yes';
  const transport = eligible.find(item => item.role === 'transport' || item.id === ADDON_ID_PRIVATE_TRANSPORT);
  if (wantsTransport && transport) requested.add(transport.id);
  let addonsTotal = 0;
  let transportTotal: number | null = null;
  let requiresTransportConfirmation = wantsTransport && !transport;
  let requiresConfirmation = requiresTransportConfirmation;
  const separateAddons: PriceQuote['separateAddons'] = [];
  for (const id of requested) {
    if (plan.includedAddonIds?.includes(id)) continue;
    const item = eligible.find(candidate => candidate.id === id);
    if (!item) return null;
    if (item.category === 'included') continue;
    const needsConfirmation = item.category === 'team_confirmation'
      || item.quoteMode === 'team_confirmation'
      || (item.peopleIncluded != null && people > item.peopleIncluded);
    const amount = needsConfirmation ? null : item.pricePerPerson != null
      ? item.pricePerPerson * people : item.couplePrice ?? null;
    const isTransport = item.role === 'transport' || item.id === ADDON_ID_PRIVATE_TRANSPORT;
    if (isTransport) {
      transportTotal = amount;
      requiresTransportConfirmation = amount == null;
    }
    if (item.quoteMode === 'separate') {
      separateAddons.push({ id, amount, requiresConfirmation: amount == null });
    } else {
      requiresConfirmation ||= amount == null;
      if (!isTransport) addonsTotal += amount ?? 0;
    }
  }
  const transportInTotal = transport?.quoteMode === 'separate' ? 0 : transportTotal ?? 0;
  const total = requiresConfirmation ? null : planTotal + addonsTotal + transportInTotal;

  return {
    planId,
    people,
    currency: exp.pricing.currency,
    planTotal,
    addonsTotal,
    transportTotal,
    total,
    requiresTransportConfirmation,
    separateAddons,
  };
}

/**
 * Hash of the catalog facts a quote for `planId` depends on (plan prices, eligible
 * addon prices and modes, calculation rule, included addons, deposit). Customer
 * inputs (group size, transport) are deliberately excluded: only a catalog change
 * invalidates a delivered quote.
 */
export function getQuoteFingerprint(exp: ActiveExperience, planId: string | null | undefined, depositPercent: number): string | null {
  const resolvedId = planId ?? (exp.plans.length === 1 ? exp.plans[0].id : null);
  const plan = exp.plans.find(candidate => candidate.id === resolvedId);
  if (!plan) return null;
  const items = exp.pricing.items
    .filter(item => (!item.planId || item.planId === plan.id) && (!plan.siteId || !item.siteId || item.siteId === plan.siteId))
    .map(item => [item.id, item.kind, item.pricePerPerson, item.couplePrice, item.peopleIncluded, item.category, item.quoteMode, item.role])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const hash = createHash('sha256').update(JSON.stringify({
    items, depositPercent, calculation: plan.calculation ?? null,
    includedAddonIds: [...(plan.includedAddonIds ?? [])].sort(),
  })).digest('hex');
  return `${plan.id}:${hash}`;
}

/** Plan id a stored `<planId>:<hash>` fingerprint was computed for; null when malformed. */
export function quoteFingerprintPlanId(stored: string): string | null {
  const separator = stored.lastIndexOf(':');
  return separator > 0 ? stored.slice(0, separator) : null;
}

/** True when the catalog facts behind a stored fingerprint changed (or its plan is gone). */
export function isQuoteFingerprintStale(exp: ActiveExperience, stored: string, depositPercent: number): boolean {
  const planId = quoteFingerprintPlanId(stored);
  if (!planId) return true;
  return getQuoteFingerprint(exp, planId, depositPercent) !== stored;
}

/** Lowest one-person package total, excluding optional add-ons and transport. */
export function getStartingPrice(exp: ActiveExperience, planId?: string | null): StartingPrice | null {
  const individualItems = exp.pricing.items.filter(item => item.publiclyShow
    && item.pricePerPerson != null
    && item.kind !== 'addon'
    && item.id !== ADDON_ID_APIARY_CATTLE
    && (!planId || item.planId === planId));
  const item = individualItems.reduce<typeof individualItems[number] | null>(
    (lowest, candidate) => lowest == null || candidate.pricePerPerson! < lowest.pricePerPerson! ? candidate : lowest,
    null,
  );
  if (!item?.planId || item.pricePerPerson == null) return null;
  return { amount: item.pricePerPerson, currency: exp.pricing.currency, planId: item.planId };
}

export function formatCop(amount: number): string {
  return amount.toLocaleString('en-US');
}

/** Display equivalent of an already computed total, never the catalog's solo rate. */
export function calculatePerPersonEquivalent(total: number, people: number): { amount: number; approximate: boolean } | null {
  if (!Number.isFinite(total) || total < 0 || !Number.isInteger(people) || people <= 0) return null;
  const amount = total / people;
  return { amount: Math.round(amount), approximate: !Number.isInteger(amount) };
}
