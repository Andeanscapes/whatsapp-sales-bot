import type { ActiveExperience } from './product-registry.js';
import { ADDON_ID_APIARY_CATTLE, ADDON_ID_PRIVATE_TRANSPORT } from './dynamic-data-service.js';

export type TransportNeed = 'own' | 'public_bus' | 'from_bogota' | 'yes' | null | undefined;

export interface PriceQuoteInput {
  planId: string | null | undefined;
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

function toPeople(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function getPlanPrices(exp: ActiveExperience, planId: string): { individual: number; couple: number } | null {
  const planItems = exp.pricing.items.filter(item => item.planId === planId);
  const individual = planItems.find(item => item.pricePerPerson != null)?.pricePerPerson;
  const couple = planItems.find(item => item.couplePrice != null)?.couplePrice;
  return individual != null && couple != null ? { individual, couple } : null;
}

function getPrivateTransportPrice(exp: ActiveExperience): number | null {
  const item = exp.pricing.items.find(i => i.id === ADDON_ID_PRIVATE_TRANSPORT && i.couplePrice != null);
  return item?.couplePrice ?? null;
}

function getApiaryCattlePrice(exp: ActiveExperience, planId: string): number | null {
  const item = exp.pricing.items.find(i => i.id === ADDON_ID_APIARY_CATTLE && i.planId === planId && i.pricePerPerson != null);
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

  const people = toPeople(input.people);
  if (people == null) return null;

  const prices = getPlanPrices(exp, planId);
  if (!prices) return null;

  const planTotal = calculatePlanTotal(people, prices.individual, prices.couple);
  const addonPrice = input.includeApiaryCattle ? getApiaryCattlePrice(exp, planId) : null;
  const addonsTotal = addonPrice != null ? addonPrice * people : 0;

  const wantsTransport = input.transportNeed === 'from_bogota' || input.transportNeed === 'yes';
  const transportPrice = wantsTransport ? getPrivateTransportPrice(exp) : null;
  const requiresTransportConfirmation = wantsTransport && people > 4;
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

export function formatCop(amount: number): string {
  return amount.toLocaleString('en-US');
}
