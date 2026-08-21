import type { ActiveExperience } from './product-registry.js';
import { ADDON_ID_APIARY_CATTLE, ADDON_ID_PRIVATE_TRANSPORT } from './dynamic-data-service.js';

export type TransportNeed = 'own' | 'public_bus' | 'from_bogota' | 'yes' | null | undefined;

export interface PriceQuoteInput {
  planId: string | null | undefined;
  siteId?: string | null;
  people: unknown;
  transportNeed?: TransportNeed;
  includeApiaryCattle?: boolean;
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
}

export interface StartingPrice {
  amount: number;
  currency: string;
  planId: string;
}

function toPeople(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function getPlanPrices(exp: ActiveExperience, planId: string, siteId?: string): { individual: number; couple: number } | null {
  const planItems = exp.pricing.items.filter(item => item.planId === planId
    && (!siteId || !item.siteId || item.siteId === siteId));
  const individual = planItems.find(item => item.pricePerPerson != null)?.pricePerPerson;
  const couple = planItems.find(item => item.couplePrice != null)?.couplePrice;
  return individual != null && couple != null ? { individual, couple } : null;
}

function getPrivateTransportPrice(exp: ActiveExperience, planId: string, siteId?: string): number | null {
  const item = exp.pricing.items.find(i => i.id === ADDON_ID_PRIVATE_TRANSPORT
    && i.couplePrice != null
    && (!i.planId || i.planId === planId)
    && (!siteId || !i.siteId || i.siteId === siteId));
  return item?.couplePrice ?? null;
}

function getApiaryCattlePrice(exp: ActiveExperience, planId: string, siteId?: string): number | null {
  const item = exp.pricing.items.find(i => i.id === ADDON_ID_APIARY_CATTLE
    && i.planId === planId
    && i.pricePerPerson != null
    && (!siteId || !i.siteId || i.siteId === siteId));
  return item?.pricePerPerson ?? null;
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
  const siteId = input.siteId ?? plan?.siteId;

  const people = toPeople(input.people);
  if (people == null) return null;

  const prices = getPlanPrices(exp, planId, siteId ?? undefined);
  if (!prices) return null;

  const planTotal = calculatePlanTotal(people, prices.individual, prices.couple);
  const addonPrice = input.includeApiaryCattle ? getApiaryCattlePrice(exp, planId, siteId ?? undefined) : null;
  const addonsTotal = addonPrice != null ? addonPrice * people : 0;

  const wantsTransport = input.transportNeed === 'from_bogota' || input.transportNeed === 'yes';
  const transportPrice = wantsTransport ? getPrivateTransportPrice(exp, planId, siteId ?? undefined) : null;
  const requiresTransportConfirmation = wantsTransport && (people > 4 || transportPrice == null);
  const transportTotal = wantsTransport && !requiresTransportConfirmation ? transportPrice : null;
  const total = requiresTransportConfirmation ? null : planTotal + addonsTotal + (transportTotal ?? 0);

  return {
    planId,
    people,
    currency: exp.pricing.currency,
    planTotal,
    addonsTotal,
    transportTotal,
    total,
    requiresTransportConfirmation,
  };
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
