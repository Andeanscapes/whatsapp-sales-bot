import { beforeEach, describe, expect, it } from 'vitest';
import { loadSkills } from '../services/skill-loader.js';
import { getActiveExperience, type ActiveExperience } from '../services/product-registry.js';
import { calculatePriceQuote, formatCop } from '../services/pricing-calculator.js';
import { resolveBrochurePlanId, detectQuotedPlan, siteNamedRecently } from '../services/qualification-engine.js';
import { assembleSystemPrompt } from '../services/skills-prompt-assembly.js';
import { allSitesActivePayload, useAllSitesActive, withoutPlans } from './helpers/all-sites-catalog.js';

// Every destination active, and Chivor reduced to its two overnight plans: "del otro
// plan" is defined on a two-plan site. The three-plan case is tested on its own below.
beforeEach(() => {
  useAllSitesActive(withoutPlans(allSitesActivePayload(), ['basic_1d_chivor']));
});

const CHIVOR_CORE = 'core_2d1n_chivor';
const CHIVOR_PRIME = 'prime_2d1n_chivor';
const COSCUEZ_CORE = 'core_2d1n_coscuez';

let experience: ActiveExperience;
const total = (planId: string, people = 2): string =>
  formatCop(calculatePriceQuote(experience, { planId, people })?.planTotal ?? 0);

beforeEach(() => {
  experience = getActiveExperience(loadSkills());
});

describe('resolveBrochurePlanId', () => {
  it('resolves within the stored site when no different site is named', () => {
    // "la mas completa" → PRIME
    expect(resolveBrochurePlanId('tienes brochure de la mas completa ?', CHIVOR_CORE, null, experience, 'chivor')).toBe(CHIVOR_PRIME);
    // No plan named → fallback to stored
    expect(resolveBrochurePlanId('tienes brochure ?', CHIVOR_CORE, null, experience, 'chivor')).toBe(CHIVOR_CORE);
  });

  it('resolves within the named site when customer names a different site', () => {
    // Naming "chivor" when stored is Coscuez → resolve within chivor
    expect(resolveBrochurePlanId('brochure de chivor prime', COSCUEZ_CORE, null, experience, 'coscuez')).toBe(CHIVOR_PRIME);
  });

  it('falls back through counterpart and only plan when resolving within a named site', () => {
    // Named site chivor, stored is CORE, asks for "prime" → CHIVOR_PRIME
    expect(resolveBrochurePlanId('brochure de chivor prime', COSCUEZ_CORE, null, experience, 'coscuez')).toBe(CHIVOR_PRIME);
    // Named site chivor, stored is CORE, no tier named → counterpart CHIVOR_CORE
    expect(resolveBrochurePlanId('chivor', COSCUEZ_CORE, null, experience, 'coscuez')).toBe(CHIVOR_CORE);
  });

  it('resolves "del otro plan" relative to the stored plan, in the same site', () => {
    expect(resolveBrochurePlanId('brochure del otro plan', CHIVOR_CORE, null, experience, 'chivor')).toBe(CHIVOR_PRIME);
  });

  it('resolves "del otro plan" relative to the counterpart in a different named site', () => {
    expect(resolveBrochurePlanId('brochure del otro plan de chivor', COSCUEZ_CORE, null, experience, 'coscuez')).toBe(CHIVOR_PRIME);
  });

  it('resolves a same-site other-plan brochure without legacy catalog tiers', () => {
    const legacyExperience = {
      ...experience,
      plans: experience.plans.map(plan => ({ ...plan, tier: undefined })),
    };
    expect(resolveBrochurePlanId('brochure del otro plan', CHIVOR_CORE, null, legacyExperience, 'chivor')).toBe(CHIVOR_PRIME);
  });

  it('returns null for an unmatched cross-site request instead of the stored card', () => {
    const legacyExperience = {
      ...experience,
      plans: experience.plans.map(plan => ({ ...plan, tier: undefined })),
    };
    expect(resolveBrochurePlanId('brochure de chivor', COSCUEZ_CORE, null, legacyExperience, 'coscuez')).toBeNull();
  });

  it('prefers the bot-quoted plan for the named site over a counterpart', () => {
    const quotedReply = `La PRIME de Chivor queda en ${total(CHIVOR_PRIME, 2)}.`;
    expect(resolveBrochurePlanId('chivor', COSCUEZ_CORE, quotedReply, experience, 'coscuez', 2)).toBe(CHIVOR_PRIME);
  });
});

describe('brochure prompt availability', () => {
  it.each([
    { brochurePlanId: null, advertised: false },
    { brochurePlanId: undefined, advertised: true },
  ])('advertises the stored card only when brochurePlanId is omitted: $brochurePlanId', ({ brochurePlanId, advertised }) => {
    const prompt = assembleSystemPrompt({
      skills: loadSkills(), collectedFields: { plan: CHIVOR_CORE }, brochurePlanId,
    });
    const themes = prompt.split('\n').find(line => line.startsWith('TEMAS DE GALERIA DISPONIBLES:')) ?? '';
    expect(/\bplan\b/.test(themes)).toBe(advertised);
  });
});

describe('detectQuotedPlan', () => {
  it('returns the plan whose total appears in the reply, scoped to a site', () => {
    expect(detectQuotedPlan(`La PRIME queda en ${total(CHIVOR_PRIME)}.`, experience, 2, 'chivor')).toBe(CHIVOR_PRIME);
  });

  it('returns null when both totals appear (comparison)', () => {
    expect(detectQuotedPlan(`CORE ${total(CHIVOR_CORE)} o PRIME ${total(CHIVOR_PRIME)}.`, experience, 2)).toBeNull();
  });

  it('returns null when no plan total matches, even if a plan is named', () => {
    expect(detectQuotedPlan('La PRIME con transporte queda en $9.999.000.', experience, 2)).toBeNull();
  });

  it('returns null without a people count', () => {
    expect(detectQuotedPlan(`La PRIME queda en ${total(CHIVOR_PRIME)}.`, experience, null)).toBeNull();
  });

  it('returns the quoted plan from another site when scoped to that site', () => {
    expect(detectQuotedPlan(`La PRIME de Chivor queda en ${total(CHIVOR_PRIME)}.`, experience, 2, 'chivor')).toBe(CHIVOR_PRIME);
  });
});

describe('siteNamedRecently', () => {
  it('null when the reply names no site', () => {
    expect(siteNamedRecently('la prima de ese plan', [], experience)).toBeNull();
  });

  it('null when the reply names a site not in recent inbounds', () => {
    expect(siteNamedRecently('quiero chivor', ['coscuez es más cerca'], experience)).toBeNull();
  });

  it('returns the site when it appears in current message and recent inbounds', () => {
    expect(siteNamedRecently('chivor', ['coscuez es más cerca', 'chivor mejor'], experience)).toBe('chivor');
  });

  it('ignores sites named in the reply only (not in recents)', () => {
    expect(siteNamedRecently('chivor queda cerca', ['coscuez'], experience)).toBeNull();
  });

  it('null when the reply names several sites', () => {
    expect(siteNamedRecently('chivor o coscuez', ['chivor', 'coscuez'], experience)).toBeNull();
  });
});

describe('resolveBrochurePlanId on a site with three plans', () => {
  it('leaves "del otro plan" unresolved instead of shipping the stored plan card', () => {
    const full = getActiveExperience(useAllSitesActive());
    expect(full.plans.filter(plan => plan.siteId === 'chivor')).toHaveLength(3);
    expect(resolveBrochurePlanId('brochure del otro plan', CHIVOR_CORE, null, full, 'chivor')).toBeNull();
    expect(resolveBrochurePlanId('tienes brochure de la mas completa ?', CHIVOR_CORE, null, full, 'chivor')).toBe(CHIVOR_PRIME);
  });
});
