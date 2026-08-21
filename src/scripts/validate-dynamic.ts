import { readFileSync } from 'fs';
import { assertDynamicCatalogReady, dynamicDataSchema, type DynamicData } from '../services/dynamic-data-schema.js';
import { assertReferentAttributionMatches } from '../services/sales-composition.js';

/** Validated experiences, so these checks track the schema instead of restating it. */
type ValidatedExperiences = DynamicData['experiences'];

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: tsx src/scripts/validate-dynamic.ts <path-to-dynamic.json>');
  process.exit(1);
}

/**
 * Group arithmetic is owned by `pricing-calculator.ts` and injected as a resolved
 * total (QUOTE LOCK). Prose that re-states the formula lands in PRICING_RULES and
 * competes with that figure — it caused odd groups of 5+ to be overcharged by
 * `individual - couple/2`. Remote rules must describe policy, never composition.
 */
const ARITHMETIC_PROSE = [
  { pattern: /\b\d+\s*p(?:ersonas?)?\s*=/i, hint: 'per-group-size formula (e.g. "3p = ...")' },
  { pattern: /pareja\s*(?:\+|x\s*\d|\*)/i, hint: 'composition from couple/individual prices' },
  { pattern: /couplePrice|precio\s+por\s+persona\s*=/i, hint: 'explicit price formula' },
  { pattern: /\bmultiplicad|\bdividid/i, hint: 'multiply/divide instruction' },
];

function checkPricingRules(experiences: ValidatedExperiences): string[] {
  const failures: string[] = [];
  for (const [expId, exp] of Object.entries(experiences)) {
    for (const [siteId, site] of Object.entries(exp.sites)) {
      const rules = Array.isArray(site.rules) ? site.rules : site.rules.split('|');
      for (const rule of rules.map(r => r.trim()).filter(Boolean)) {
        for (const { pattern, hint } of ARITHMETIC_PROSE) {
          if (pattern.test(rule)) {
            failures.push(`   ${expId}.${siteId}: ${hint}\n     -> "${rule.slice(0, 120)}"`);
          }
        }
      }
    }
  }
  return failures;
}

/**
 * An addon with neither `pp` nor `price` renders as a priceless line the bot cannot
 * quote. That is never intentional and is easy to introduce by hand-editing the feed,
 * so fail loudly instead of shipping a silently unquotable extra.
 */
function checkAddonPrices(experiences: ValidatedExperiences): string[] {
  const failures: string[] = [];
  for (const [expId, exp] of Object.entries(experiences)) {
    for (const [siteId, site] of Object.entries(exp.sites)) {
      for (const [addonId, addon] of Object.entries(site.addons)) {
        if (addon.pp == null && addon.price == null) {
          failures.push(`   ${expId}.${siteId}.${addonId}: addon has neither "pp" nor "price"`);
        }
      }
    }
  }
  return failures;
}

/** A plan with no individual and no couple price cannot be quoted either. */
function checkPlanPrices(experiences: ValidatedExperiences): string[] {
  const failures: string[] = [];
  for (const [expId, exp] of Object.entries(experiences)) {
    for (const [siteId, site] of Object.entries(exp.sites)) {
      for (const [planId, plan] of Object.entries(site.plans)) {
        if (plan.pricing?.individual == null && plan.pricing?.couple == null) {
          failures.push(`   ${expId}.${siteId}.${planId}: plan has no "individual" or "couple" price`);
        }
      }
    }
  }
  return failures;
}

/**
 * Addons are a per-site catalog (Chivor's extras are not Coscuez's extras). A plan's
 * `addons[]` eligibility list must reference a key that exists in that SAME site's
 * `addons{}` catalog — never another site's, and never a typo'd id that silently
 * renders as nothing.
 */
function checkAddonReferences(experiences: ValidatedExperiences): string[] {
  const failures: string[] = [];
  for (const [expId, exp] of Object.entries(experiences)) {
    for (const [siteId, site] of Object.entries(exp.sites)) {
      const catalogIds = new Set(Object.keys(site.addons));
      for (const [planId, plan] of Object.entries(site.plans)) {
        for (const addonId of plan.addons) {
          if (!catalogIds.has(addonId)) {
            failures.push(`   ${expId}.${siteId}.${planId}: addon "${addonId}" is not in this site's addon catalog`);
          }
        }
      }
    }
  }
  return failures;
}

try {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  const validated = dynamicDataSchema.parse(parsed);
  assertDynamicCatalogReady(validated);
  if (validated.referentAttribution) {
    assertReferentAttributionMatches(validated.referentAttribution);
  }

  const expCount = Object.keys(validated.experiences).length;
  const siteCount = Object.values(validated.experiences).reduce(
    (sum, e) => sum + Object.keys(e.sites).length, 0
  );
  const planCount = Object.values(validated.experiences).reduce(
    (sum, e) => sum + Object.values(e.sites).reduce((s, site) => s + Object.keys(site.plans).length, 0), 0
  );
  const addonCount = Object.values(validated.experiences).reduce(
    (sum, e) => sum + Object.values(e.sites).reduce((s, site) => s + Object.keys(site.addons).length, 0), 0
  );
  const dateCount = Object.values(validated.experiences).reduce(
    (sum, e) => sum + Object.values(e.sites).reduce((s, site) => s + site.availability.dates.length, 0), 0
  );

  const arithmeticFailures = checkPricingRules(validated.experiences);
  if (arithmeticFailures.length > 0) {
    console.error('Dynamic skill file is INVALID');
    console.error('pricing rules must not restate group arithmetic (pricing-calculator.ts owns it):\n');
    console.error(arithmeticFailures.join('\n'));
    process.exit(1);
  }

  const referenceFailures = checkAddonReferences(validated.experiences);
  if (referenceFailures.length > 0) {
    console.error('Dynamic skill file is INVALID');
    console.error('every plan addon must reference an id in its OWN site\'s addon catalog:\n');
    console.error(referenceFailures.join('\n'));
    process.exit(1);
  }

  const priceFailures = [
    ...checkAddonPrices(validated.experiences),
    ...checkPlanPrices(validated.experiences),
  ];
  if (priceFailures.length > 0) {
    console.error('Dynamic skill file is INVALID');
    console.error('every plan and addon must carry a price the bot can quote:\n');
    console.error(priceFailures.join('\n'));
    process.exit(1);
  }

  console.log('Dynamic skill file is VALID');
  console.log(`   Experiences: ${expCount}`);
  console.log(`   Sites: ${siteCount}`);
  console.log(`   Plans with pricing: ${planCount}`);
  console.log(`   Addons priced: ${addonCount}`);
  console.log(`   Available dates: ${dateCount}`);
  console.log(`   Last updated: ${validated.updated}`);
  console.log('   pricing.rules: no group arithmetic prose');
  console.log('   addon references: every plan addon resolves within its own site');
  console.log('   entry segments: campaign copy constraints satisfied');
  process.exit(0);
} catch (err) {
  console.error('Dynamic skill file is INVALID');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
