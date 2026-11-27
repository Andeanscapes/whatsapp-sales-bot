import { getPlans, getSites, type ActiveExperience } from './product-registry.js';
import { calculatePerPersonEquivalent, calculatePriceQuote } from './pricing-calculator.js';
import { extractCopAmounts } from './qualification-engine.js';
import { normalizeText } from './language-service.js';

/**
 * Post-LLM price check (P0 2026-11-26). The calculator is the only source of totals;
 * the model writes the sentence. A figure in the reply passes only when the calculator
 * can produce it for the plan, site and group size the sentence names (or, when it names
 * none, for the plans and sizes in play this turn), or when it is a catalog unit price
 * valid for that group. Live 2026-11-26 the bot quoted PRIME Chivor for 3 and 4 as
 * 1.440.000 and 1.920.000 (BASIC's solo rate times N): both are unaccounted figures.
 */
export interface QuoteGuardContext {
  /** Plans whose figures may appear (every active plan). */
  planIds: string[];
  /** The conversation's chosen site: a sentence that names no site binds to it. Null = any site. */
  preferredSiteId?: string | null;
  /** Group sizes in play: the stored size and any scenario asked this turn. */
  peopleCounts: number[];
  depositPercentFor: (planId: string) => number | null;
  /** COP figures the customer wrote this turn (a budget, an amount they saw elsewhere). */
  customerAmounts?: number[];
}

export interface QuoteMismatch {
  amount: number;
  planId: string | null;
  people: number | null;
}

const COUNT_WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const COUNT = String.raw`(\d{1,2}|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|one|two|three|four|five|six|seven|eight|nine|ten)`;
// "para 3", "for 4 people", "3 personas". Never "para el 14", "para 2 noches", "for 2 days",
// nor a count of couples, adults or children (those are read below or not at all).
const NOT_PEOPLE_AFTER = String.raw`(?!\s+(?:de|del|noches?|nights?|dias?|days?|horas?|hours?|minas?|mines?|am|pm|parejas?|couples?|adult\w*|nin\w*|kids?|child\w*|hij\w*))`;
const PEOPLE_COUNT = new RegExp(String.raw`\b(?:para|for)\s+${COUNT}\b${NOT_PEOPLE_AFTER}|\b${COUNT}\s+(?:personas?|viajeros?|people|persons?|travell?ers?|pax)\b`, 'g');
const COUPLE_COUNT = new RegExp(String.raw`\b(?:${COUNT}|a)\s+(?:parejas?|couples?)\b`, 'g');
/** Adults and children named apart: the count is the team's call, so the sentence binds no size. */
const MIXED_GROUP = /\b(?:adult\w*|nin[oa]s?|kids?|child\w*|hij[oa]s?)\b/;
const SOLO_LABEL = /\b(?:individual|sol[oa]|una\s+persona|1\s+persona|solo\s+traveler|alone|single)\b/;
const COUPLE_LABEL = /\b(?:pareja|couple)\b/;

function countsIn(sentence: string): number[] | null {
  const norm = normalizeText(sentence);
  if (MIXED_GROUP.test(norm)) return null;
  const people = [...norm.matchAll(PEOPLE_COUNT)].map(match => {
    const raw = match[1] ?? match[2];
    return COUNT_WORDS[raw] ?? Number.parseInt(raw, 10);
  });
  const couples = [...norm.matchAll(COUPLE_COUNT)].map(match => 2 * (COUNT_WORDS[match[1] ?? 'a'] ?? Number.parseInt(match[1], 10)));
  const labels = [...(SOLO_LABEL.test(norm) ? [1] : []), ...(COUPLE_LABEL.test(norm) && couples.length === 0 ? [2] : [])];
  return [...people, ...couples, ...labels].filter(n => Number.isInteger(n) && n > 0 && n <= 30);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shortName(name: string): string {
  return name.split(' — ')[0].trim();
}

function namedIn(sentence: string, words: string[]): boolean {
  const norm = normalizeText(sentence);
  return words.some(word => {
    const target = normalizeText(word).trim();
    return target.length > 0 && new RegExp(String.raw`\b${escape(target)}\b`).test(norm);
  });
}

/** Every figure the calculator can produce for one plan and one group size. */
function figuresFor(exp: ActiveExperience, planId: string, people: number, depositPercent: number | null): number[] {
  const figures: number[] = [];
  for (const transportNeed of ['own', 'from_bogota'] as const) {
    const quote = calculatePriceQuote(exp, { planId, people, transportNeed });
    if (!quote) continue;
    const totals = [quote.planTotal, ...(quote.total == null ? [] : [quote.total])];
    for (const total of totals) {
      figures.push(total);
      const equivalent = calculatePerPersonEquivalent(total, people);
      if (equivalent) figures.push(equivalent.amount);
      if (depositPercent != null) {
        const deposit = Math.round(total * depositPercent / 100);
        figures.push(deposit, total - deposit);
      }
    }
    if (quote.transportTotal != null) figures.push(quote.transportTotal);
  }
  return figures;
}

interface UnitPrices {
  /** A plan's solo rate: valid only for one traveller. */
  solo: Set<number>;
  /** Couple totals, group rate per traveller and addon prices. */
  shared: Set<number>;
}

function unitPrices(exp: ActiveExperience, planIds: ReadonlySet<string>): UnitPrices {
  const solo = new Set<number>();
  const shared = new Set<number>();
  for (const item of exp.pricing.items) {
    if (item.kind === 'addon') {
      if (item.planId && !planIds.has(item.planId)) continue;
      for (const amount of [item.pricePerPerson, item.couplePrice]) if (amount != null) shared.add(amount);
      continue;
    }
    if (!item.planId || !planIds.has(item.planId)) continue;
    if (item.pricePerPerson != null) solo.add(item.pricePerPerson);
    if (item.couplePrice != null) {
      shared.add(item.couplePrice);
      shared.add(Math.round(item.couplePrice / 2));
    }
  }
  return { solo, shared };
}

/**
 * The reply restates the customer's own figure ("con tu presupuesto de $1.500.000", "you
 * mentioned $1,500,000"). Only then may a customer amount pass: echoed as the bot's own
 * quote ("para 3 queda en $1.440.000") it stays blocked.
 */
// "presupuesto" alone also means "quote" ("el presupuesto queda en $X"): only the owned forms count.
const CUSTOMER_REFERENCE_BEFORE = /(?:(?:tu|su)\s+presupuesto(?:\s+(?:de|es))?|presupuesto\s+de|(?:your\s+)?budget(?:\s+(?:of|is))?|cuentas\s+con|you\s+can\s+spend)\s*(?:COP\s*)?$/i;

function customerFigures(sentence: string, customerAmounts: ReadonlySet<number>): Set<number> {
  const referenced = new Set<number>();
  if (customerAmounts.size === 0) return referenced;
  for (const match of sentence.matchAll(AMOUNT_TOKEN)) {
    const amount = Number.parseInt(match[0].replace(/[^\d]/g, ''), 10);
    if (customerAmounts.has(amount) && CUSTOMER_REFERENCE_BEFORE.test(sentence.slice(0, match.index ?? 0))) referenced.add(amount);
  }
  return referenced;
}

function sentencesOf(reply: string): string[] {
  return reply.split(/\n+|(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡*])/).map(part => part.trim()).filter(Boolean);
}

/** Amounts written as the gap between two plans ("$750.000 más", "una diferencia de $750.000"). */
const GAP_AFTER = /^\s*(?:COP|pesos)?\s*(?:m[aá]s|de\s+diferencia|more|extra|adicional(?:es)?|additional)\b/i;
const GAP_BEFORE = /(?:diferencia(?:\s+es)?\s+de|suma|extra\s+de|adicional\s+de|difference\s+(?:is\s+)?(?:of\s+)?|only)\s*$/i;
const AMOUNT_TOKEN = /(?:\$\s*)?\d{1,3}(?:[.,']\d{3})+|\$\s*\d{6,}/g;

function gapAmounts(sentence: string): Set<number> {
  const gaps = new Set<number>();
  for (const match of sentence.matchAll(AMOUNT_TOKEN)) {
    const index = match.index ?? 0;
    const after = sentence.slice(index + match[0].length);
    const before = sentence.slice(0, index);
    if (GAP_AFTER.test(after) || GAP_BEFORE.test(before)) {
      gaps.add(Number.parseInt(match[0].replace(/[^\d]/g, ''), 10));
    }
  }
  return gaps;
}

export function findQuoteMismatches(reply: string, exp: ActiveExperience, ctx: QuoteGuardContext): QuoteMismatch[] {
  if (extractCopAmounts(reply).length === 0) return [];
  const plans = getPlans(exp).filter(plan => ctx.planIds.includes(plan.id));
  if (plans.length === 0) return [];
  const sites = getSites(exp);
  const customerAmounts = new Set(ctx.customerAmounts ?? []);
  const replyCounts = countsIn(reply) ?? [];
  const allCounts = [...new Set([...ctx.peopleCounts, ...replyCounts])];
  const cache = new Map<string, Set<number>>();
  const figures = (planId: string, people: number): Set<number> => {
    const key = `${planId}:${people}`;
    let set = cache.get(key);
    if (!set) {
      set = new Set(figuresFor(exp, planId, people, ctx.depositPercentFor(planId)));
      cache.set(key, set);
    }
    return set;
  };
  const planTotal = (planId: string, people: number): number | null =>
    calculatePriceQuote(exp, { planId, people, transportNeed: 'own' })?.planTotal ?? null;

  const mismatches: QuoteMismatch[] = [];
  for (const sentence of sentencesOf(reply)) {
    const amounts = extractCopAmounts(sentence);
    if (amounts.length === 0) continue;
    // Site: the one the sentence names, else the conversation's, else any.
    const namedSites = sites.filter(site => namedIn(sentence, [site.name ?? site.id, site.id, ...(site.selectionAliases ?? [])]));
    const siteIds = namedSites.length > 0
      ? namedSites.map(site => site.id)
      : ctx.preferredSiteId && plans.some(plan => plan.siteId === ctx.preferredSiteId) ? [ctx.preferredSiteId] : null;
    const sitePlans = siteIds ? plans.filter(plan => !plan.siteId || siteIds.includes(plan.siteId)) : plans;
    const namedPlans = sitePlans.filter(plan => namedIn(sentence, [shortName(plan.name)]));
    const planScope = (namedPlans.length > 0 ? namedPlans : sitePlans).map(plan => plan.id);
    const sentenceCounts = countsIn(sentence);
    // No size anywhere: only the catalog's own 1- and 2-traveller figures can be meant.
    const countScope = sentenceCounts && sentenceCounts.length > 0 ? sentenceCounts : allCounts.length > 0 ? allCounts : [1, 2];
    const units = unitPrices(exp, new Set(planScope));

    const allowed = new Set(units.shared);
    // The solo rate is never a group's per-person price (the P0 shape: "$960.000 por persona" for 3).
    if (countScope.includes(1) || sentenceCounts === null) {
      for (const amount of units.solo) allowed.add(amount);
    }
    for (const planId of planScope) for (const people of countScope) for (const amount of figures(planId, people)) allowed.add(amount);
    for (const amount of customerFigures(sentence, customerAmounts)) allowed.add(amount);
    const gaps = gapAmounts(sentence);
    if (gaps.size > 0) {
      for (const people of countScope.length > 0 ? countScope : [1, 2]) {
        const totals = sitePlans.map(plan => planTotal(plan.id, people)).filter((total): total is number => total != null);
        for (const a of totals) for (const b of totals) if (a > b && gaps.has(a - b)) allowed.add(a - b);
      }
    }
    for (const amount of amounts) {
      if (!allowed.has(amount)) {
        mismatches.push({
          amount,
          planId: planScope.length === 1 ? planScope[0] : null,
          people: countScope.length === 1 ? countScope[0] : null,
        });
      }
    }
  }
  return mismatches;
}
