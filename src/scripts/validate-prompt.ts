import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getReferentDisplayNames, getSalesComposition, renderReferentStrategies } from '../services/sales-composition.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FILES: ReadonlyArray<{ path: string; label: string }> = [
  { path: join(__dirname, '..', 'prompts', 'seller-personality.skill.md'), label: 'seller-personality.skill.md' },
  { path: join(__dirname, '..', 'prompts', 'entry-strategy.skill.md'), label: 'entry-strategy.skill.md' },
  { path: join(__dirname, '..', 'prompts', 'cold-info-handler.skill.md'), label: 'cold-info-handler.skill.md' },
  { path: join(__dirname, '..', 'prompts', 'whatsapp-sales.skill.md'), label: 'whatsapp-sales.skill.md' },
  { path: join(__dirname, '..', 'prompts', 'andean-scapes.skill.md'), label: 'andean-scapes.skill.md' },
  { path: join(__dirname, '..', 'prompts', 'dynamic-context.template.md'), label: 'dynamic-context.template.md' },
];

interface Check {
  label: string;
  pattern: RegExp;
}

const SKILL_GUARDS: Check[] = [
  // Any COP-formatted amount, not just the three that happened to leak once. Catches
  // "$550.000" and "$82.500" alike. Placeholders like [PRECIO] carry no digits.
  { label: 'money amount (use [PRECIO]/[TOTAL])', pattern: /\$\s?\d{1,3}(?:[.,]\d{3})+/ },
  { label: 'price amounts (e.g. 550000)', pattern: /\b550[.,]?000\b/ },
  { label: 'price amounts (e.g. 1000000)', pattern: /\b1[.,]?000[.,]?000\b/ },
  { label: 'price amounts (e.g. 1700000)', pattern: /\b1[.,]?700[.,]?000\b/ },
  // `\b15%\b` never matched "15% " — `%` to space is not a word boundary, so the
  // deposit literal slipped through this guard for as long as it existed. Any
  // numeric percentage is business data; the prompt must use [ANTICIPO%].
  { label: 'percentage literal (use [ANTICIPO%])', pattern: /\b\d{1,3}\s?%/ },
  { label: 'phone number literal', pattern: /\b319[.\s-]?251[.\s-]?0498\b/ },
  { label: 'any Colombian mobile', pattern: /\b3\d{2}[.\s-]?\d{3}[.\s-]?\d{4}\b/ },
  { label: 'hardcoded plan id', pattern: /\b2d1n_mining\b/ },
  { label: 'hardcoded experience id', pattern: /\bemerald_mining\b/ },
  // Experience-specific literals: the skill MD files are experience-agnostic
  // (docs/skills-architecture.md). Duration shorthand and destination names bind
  // the prompt to one product and go stale when a second experience is added.
  { label: 'plan duration shorthand (use [PLAN]/[PLAN_A])', pattern: /\b\d+\s*D\s*\/\s*\d+\s*N\b/ },
  { label: 'plan duration prose (use [PLAN])', pattern: /\b\d+\s*d[ií]as?\s*\/\s*\d+\s*noche/i },
  // Destinations and campaign nouns live in the CDN feed (`entrySegments`, site
  // narrative). A segment can be retuned or retired without a prompt edit.
  { label: 'destination literal (use [EXPERIENCIA])', pattern: /\b(?:Chivor|Ubal[aá]|Macanal|Boyac[aá])\b/i },
  { label: 'campaign noun (belongs in entrySegments)', pattern: /\bMinecraft\b/i },
  // Payment method names come from DATOS `methods_enabled`; disabling one in the
  // feed must remove it from the bot's mouth, which fails if it is baked in here.
  { label: 'payment method name (use [METODOS])', pattern: /\b(?:Nequi|Mercado\s*Pago|Daviplata)\b/i },
];

/**
 * Tone guards: opening copy must read like a human on WhatsApp, not a sales
 * script. These ban process/meta language and internal jargon that would leak
 * verbatim into a customer reply. Keep patterns specific so legitimate internal
 * instructions in the same files are not flagged.
 */
const TONE_GUARDS: Check[] = [
  { label: 'process language ("pregunta clave")', pattern: /\bpregunta\s+clave\b/i },
  { label: 'process language ("para recomendarte bien")', pattern: /para\s+recomendarte\s+bien/i },
  { label: 'process language ("lo importante ahora")', pattern: /\blo\s+importante\s+ahora\b/i },
  { label: 'process language ("primero debemos entender")', pattern: /primero\s+debemos\s+entender/i },
  { label: 'internal term ("todo operado")', pattern: /\btodo\s+operad[oa]\b/i },
  { label: 'internal term ("paquete base")', pattern: /\bpaquete\s+base\b/i },
  { label: 'internal term ("calificación")', pattern: /\bcalificaci[oó]n\b/i },
  { label: 'quote wording ("el total exacto es")', pattern: /\bel\s+total\s+exacto\s+es\b/i },
  { label: 'availability claim ("hay/está disponible")', pattern: /\b(?:hay|est[aá])\s+disponible\b/i },
];

interface PlanEntry { name?: unknown }
interface ExperienceEntry { name?: unknown; plans?: unknown }
interface RegistryShape { experiences?: unknown }

/**
 * Guards derived from the product registry so a newly added plan/experience name
 * cannot be pasted into an experience-agnostic skill MD without failing CI.
 *
 * Deliberately scoped to product nouns (experience + plan names). Region/country
 * are brand voice ("la Colombia real", `shortBrandIntro`) and are NOT guarded.
 */
function registryGuards(): Check[] {
  const raw = readFileSync(join(__dirname, '..', 'data', 'andean-scapes.skill.json'), 'utf-8');
  const parsed = JSON.parse(raw) as RegistryShape;
  const literals: string[] = [];

  const experiences = Array.isArray(parsed.experiences) ? parsed.experiences : [];
  for (const exp of experiences as ExperienceEntry[]) {
    if (typeof exp.name === 'string' && exp.name.trim()) literals.push(exp.name.trim());
    const plans = Array.isArray(exp.plans) ? exp.plans : [];
    for (const plan of plans as PlanEntry[]) {
      if (typeof plan.name === 'string' && plan.name.trim()) literals.push(plan.name.trim());
    }
  }

  return literals.map(literal => ({
    label: `registry literal (use a placeholder): "${literal}"`,
    pattern: new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  }));
}

interface AttributionSource { sourceLabel?: unknown }
interface AttributionShape {
  referentAttribution?: { sources?: Record<string, AttributionSource> };
}

/**
 * Person names live only in `referentAttribution` (audit metadata). Skill MD files and
 * the rendered strategy block must never mention them — `displayName` is a role label
 * ("Funnel recommend"), not "Cris", so a separate scan is required.
 *
 * Reads both the CI fixture and the local dev payload when present so a new sourceLabel
 * fails the gate before it can leak into a skill edit.
 */
function referentPersonNameGuards(): Check[] {
  const names = new Set<string>();
  const payloadPaths = [
    join(__dirname, '..', '..', 'scripts', 'bot-dynamic-dev.json'),
    join(__dirname, '..', '..', 'scripts', 'bot-dynamic.ci.json'),
  ];

  for (const payloadPath of payloadPaths) {
    let raw: string;
    try {
      raw = readFileSync(payloadPath, 'utf-8');
    } catch {
      continue;
    }
    const parsed = JSON.parse(raw) as AttributionShape;
    const sources = parsed.referentAttribution?.sources ?? {};
    for (const source of Object.values(sources)) {
      if (typeof source.sourceLabel !== 'string') continue;
      const label = source.sourceLabel.trim();
      // CI fixture uses a non-person placeholder; skip it.
      if (!label || /^ci\s+fixture$/i.test(label)) continue;
      // Full label always ("Cris Urzua"). First token only for given names — last
      // names alone collide with Spanish vocabulary ("Pasos" = steps).
      names.add(label);
      const first = label.split(/\s+/)[0];
      if (first && first.length >= 4 && !/^(de|del|las|los|la|el|y|and|the|hermanas?)$/i.test(first)) {
        names.add(first);
      }
    }
  }

  return [...names]
    .sort((a, b) => b.length - a.length)
    .map(name => ({
      label: `referent person name (attribution-only): "${name}"`,
      pattern: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
    }));
}

function collectFailures(label: string, content: string, checks: Check[]): string[] {
  const failures: string[] = [];
  for (const check of checks) {
    const match = content.match(check.pattern)?.[0];
    if (match) {
      failures.push(`  FAIL: ${label}: ${check.label} — matched: "${match.slice(0, 60)}"`);
    }
  }
  return failures;
}

function main(): void {
  const failures: string[] = [];
  const personNameGuards = referentPersonNameGuards();
  const checks = [...SKILL_GUARDS, ...TONE_GUARDS, ...registryGuards(), ...personNameGuards];

  for (const file of FILES) {
    const content = readFileSync(file.path, 'utf-8');
    failures.push(...collectFailures(file.label, content, checks));
  }

  const referentBlock = renderReferentStrategies();
  failures.push(...collectFailures('referent strategies', referentBlock, checks));
  const allReferentContent = [...getSalesComposition().referents.values()]
    .map(pack => JSON.stringify({ summary: pack.summary, keyPoints: pack.keyPoints }))
    .join('\n');
  failures.push(...collectFailures('referent packs', allReferentContent, checks));
  for (const name of getReferentDisplayNames()) {
    if (referentBlock.toLocaleLowerCase().includes(name.toLocaleLowerCase())) {
      failures.push(`  FAIL: referent strategy block contains metadata name: "${name}"`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} hardcoded business data pattern(s) found in skill prompt files:\n`);
    console.error(failures.join('\n'));
    console.error('\nSkill MD files must not contain literal prices, phone numbers, plan/experience ids,\nplan or experience names, destinations, or duration shorthand. Use the §7 placeholders.\n');
    process.exit(1);
  }

  console.log(`OK: no hardcoded business data found in skill prompt files (${checks.length} guards).`);
  process.exit(0);
}

main();
