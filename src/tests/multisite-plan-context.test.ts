import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { loadSkills } from '../services/skill-loader.js';
import { allSitesActivePayload, useAllSitesActive, withSamePricing, withoutPlans } from './helpers/all-sites-catalog.js';
import { getActiveExperience, getSiteCommonQuestions, getEntrySegment, getSiteSelection } from '../services/product-registry.js';
import { contextAwareExtract, detectPlan, detectSite, detectSiteChoice, extractBookingFields, isPlanQuestion, reconstructFromHistory, resolveBrochurePlanId, resolveSiteAnswer, resolveSiteContext, detectQuotedPlan } from '../services/qualification-engine.js';
import { calculatePriceQuote, formatCop } from '../services/pricing-calculator.js';
import { assembleSystemPrompt } from '../services/skills-prompt-assembly.js';

const CORE = 'core_2d1n_chivor';
const PRIME = 'prime_2d1n_chivor';
const COSCUEZ_CORE = 'core_2d1n_coscuez';
const COSCUEZ_PRIME = 'prime_2d1n_coscuez';
const phone = '573009998111';

let db: Database.Database;
let repos: ReturnType<typeof createRepositories>;

beforeEach(() => {
  useAllSitesActive();
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
});
afterEach(() => db.close());

describe('two-site catalog selection', () => {
  it.each(['Borbur', 'San Pablo de Borbur'])('resolves the destination alias %s', alias => {
    const experience = getActiveExperience(loadSkills());
    expect(detectSite(`Me interesa ${alias}`, experience)).toBe('coscuez');
    expect(detectPlan(`quiero el prime de ${alias}`, experience)).toBe(COSCUEZ_PRIME);
    expect(detectSite(`no es ${alias}cito`, experience)).toBeNull();
  });

  // "este" is "this" in Spanish: as a Chivor alias it switched a Coscuez customer
  // who said "quiero este plan" to Chivor.
  it.each(['quiero este plan', 'me interesa este', 'este fin de semana'])(
    'an everyday word never names a destination: %s', message => {
      const experience = getActiveExperience(loadSkills());
      expect(detectSite(message, experience)).toBeNull();
      expect(detectSiteChoice(message, experience)).toBeNull();
    },
  );

  it.each([
    ['mejor en Coscuez', 'coscuez'],
    ['Coscuez', 'coscuez'],
    ['me interesa Borbur', 'coscuez'],
    ['no sé, me interesa coscuez', 'coscuez'],
    ['no, mejor Chivor', 'chivor'],
    ['quiero coscuez, ¿cuánto vale?', 'coscuez'],
    ['y coscuez queda cerca de bogota?', null],
    ['mi tio vive en borbur', null],
    ['ya conocemos coscuez', null],
    ['¿y en Coscuez?', null],
    ['no quiero Coscuez', null],
    ['quiero saber si coscuez es seguro', null],
    ['me interesa chivor o coscuez', null],
  ])('treats only an explicit choice as a destination choice: %s', (message, expected) => {
    const experience = getActiveExperience(loadSkills());
    expect(detectSiteChoice(message, experience)).toBe(expected);
  });

  it.each(['y coscuez queda cerca de bogota?', 'mi tio vive en borbur', 'ya conocemos coscuez'])(
    'a destination mention does not replace the stored plan: %s', message => {
      const experience = getActiveExperience(loadSkills());
      repos.conversation.upsert(phone, { collected_plan: PRIME });
      expect(contextAwareExtract(message, repos, phone, {}, experience).collected_plan).toBeUndefined();
      expect(resolveSiteContext(experience, PRIME, [message])).toBe('chivor');
    },
  );

  it('resolves context from a choice that follows a declined hesitation', () => {
    const experience = getActiveExperience(loadSkills());
    expect(resolveSiteContext(experience, null, ['no sé, me interesa coscuez'])).toBe('coscuez');
    expect(resolveSiteContext(experience, null, ['mi tio vive en borbur'])).toBeUndefined();
  });

  it.each(['mejor en Coscuez', 'quiero conocer Borbur'])('carries the tier across a destination choice: %s', message => {
    const experience = getActiveExperience(loadSkills());
    repos.conversation.upsert(phone, { collected_plan: PRIME });
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'quiero el prime en Chivor', created_at: new Date(Date.now() - 60_000).toISOString() });
    const fields = contextAwareExtract(message, repos, phone, {}, experience);
    expect(fields.collected_plan).toBe(COSCUEZ_PRIME);
    repos.conversation.upsert(phone, fields);
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: message, created_at: new Date().toISOString() });
    expect(reconstructFromHistory(repos, phone, { plan: COSCUEZ_PRIME }, experience).plan).toBe(COSCUEZ_PRIME);
  });

  it.each(['¿y en Coscuez?', 'no quiero Coscuez'])('keeps the stored destination for %s', message => {
    const experience = getActiveExperience(loadSkills());
    repos.conversation.upsert(phone, { collected_plan: PRIME });
    expect(contextAwareExtract(message, repos, phone, {}, experience).collected_plan).toBeUndefined();
    expect(resolveSiteContext(experience, PRIME, [message])).toBe('chivor');
  });

  it('clears an unmatched tier and does not resurrect an older plan from history', () => {
    const base = getActiveExperience(loadSkills());
    const experience = { ...base, plans: base.plans.filter(plan => plan.id !== COSCUEZ_PRIME) };
    repos.conversation.upsert(phone, { collected_plan: PRIME });
    expect(contextAwareExtract('mejor en Coscuez', repos, phone, {}, experience).collected_plan).toBeNull();
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'quiero el prime en Chivor', created_at: new Date(Date.now() - 60_000).toISOString() });
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'mejor en Coscuez', created_at: new Date().toISOString() });
    expect(reconstructFromHistory(repos, phone, {}, experience).plan).toBeUndefined();
  });

  it('keeps a single question while the destination is pending on an entry lead', () => {
    const skills = loadSkills();
    const runtime = assembleSystemPrompt({ skills, entryMarker: { code: 'R01', temperature: 'retargeting' } })
      .split('\nRUNTIME:').at(-1) ?? '';
    expect(runtime).toContain('SITIO PENDIENTE');
    expect(runtime).toContain('única pregunta de este turno');
    expect(runtime).toContain('UNA SOLA PREGUNTA');
    expect(runtime).not.toContain('SEGMENT_DETECTED');
  });

  it('renders catalog-owned coming-soon destinations as context only', () => {
    const skills = loadSkills();
    const experience = getActiveExperience(skills);
    const prompt = assembleSystemPrompt({ skills: {
      ...skills,
      andeanScapes: { ...skills.andeanScapes, experiences: [{
        ...experience, siteSelection: { context: 'context_fixture', comingSoon: [{ name: 'soon_fixture' }] },
      }] },
    } });
    expect(prompt).toContain('SITE_SELECTION: context_fixture');
    expect(prompt).toContain('COMING_SOON: soon_fixture');
    expect(prompt).not.toMatch(/SITE soon_fixture/);
  });

  it('renders catalog-owned regional context and only the selected campaign segment', () => {
    const skills = loadSkills();
    const experience = getActiveExperience(skills);
    const entryMarker = { code: 'H02', temperature: 'funnel' as const };
    const pending = assembleSystemPrompt({ skills, entryMarker });
    const selection = getSiteSelection(experience);
    expect(selection).toBeDefined();
    expect(pending).toContain(selection!.context);
    expect(pending).toContain('SITIO PENDIENTE');
    expect(pending.split('\nRUNTIME:').at(-1)).not.toContain('SEGMENT_DETECTED:');
    expect(pending).not.toContain('  ENTRY_SEGMENT H02');

    const selected = assembleSystemPrompt({ skills, entryMarker, collectedFields: { site: 'coscuez' } });
    const segment = getEntrySegment(skills, experience.id, 'H02', 'coscuez');
    const otherSegment = getEntrySegment(skills, experience.id, 'H02', 'chivor');
    expect(segment).not.toBeNull();
    expect(selected).toContain('SITIO ACTIVO: coscuez');
    expect(selected).toContain('SEGMENT_DETECTED: H02');
    expect(selected).toContain(segment!.segment.diagnosisQuestion);
    expect(selected).not.toContain(otherSegment!.segment.diagnosisQuestion);
    expect(selected.match(/ {2}ENTRY_SEGMENT H02/g)).toHaveLength(1);
  });

  it.each(['core', 'prime'])('requires a destination for an ambiguous first %s selection', alias => {
    const experience = getActiveExperience(loadSkills());
    expect(experience.plans).toHaveLength(5);
    expect(detectPlan(`quiero el ${alias}`, experience)).toBeNull();
  });

  it.each([['chivor', CORE], ['coscuez', COSCUEZ_CORE]])('remembers destination-first selection: %s', (site, plan) => {
    const experience = getActiveExperience(loadSkills());
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: `Me interesa ${site}`, created_at: new Date(Date.now() - 60_000).toISOString() });
    const message = 'quiero el core';
    const fields = contextAwareExtract(message, repos, phone, extractBookingFields(message, experience), experience);
    expect(fields.collected_plan).toBe(plan);
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: message, created_at: new Date().toISOString() });
    expect(reconstructFromHistory(repos, phone, {}, experience).plan).toBe(plan);
  });

  it('uses the stored plan site without relying on transcript retention', () => {
    const experience = getActiveExperience(loadSkills());
    repos.conversation.upsert(phone, { collected_plan: COSCUEZ_CORE });
    expect(contextAwareExtract('mejor el prime', repos, phone, {}, experience).collected_plan).toBe(COSCUEZ_PRIME);
  });

  it('does not persist an unscoped alias from another site', () => {
    const experience = getActiveExperience(loadSkills());
    repos.conversation.upsert(phone, { collected_plan: COSCUEZ_CORE });
    const message = 'quiero la de cabalgata';
    const raw = extractBookingFields(message, experience);
    expect(raw.collected_plan).toBeUndefined();
    expect(contextAwareExtract(message, repos, phone, raw, experience).collected_plan).toBeUndefined();
  });

  it('keeps site comparisons from changing destination context', () => {
    const experience = getActiveExperience(loadSkills());
    expect(resolveSiteContext(experience, CORE, ['¿cuánto vale el prime en coscuez?'])).toBe('chivor');
    expect(detectPlan('core de chivor o coscuez', experience, 'chivor')).toBeNull();
  });

  it.each(['quiero el brochure de chivor', 'dale, mandame el brochure de chivor', 'me interesa el folleto de chivor'])(
    'keeps the stored destination after a brochure-only request: %s', message => {
      const experience = getActiveExperience(loadSkills());
      repos.conversation.upsert(phone, { collected_plan: COSCUEZ_CORE });
      expect(detectSiteChoice(message, experience)).toBeNull();
      expect(contextAwareExtract(message, repos, phone, {}, experience).collected_plan).toBeUndefined();
      repos.message.addMessage({
        customer_phone: phone, direction: 'inbound', message_type: 'text',
        body: message, created_at: new Date(Date.now() - 60_000).toISOString(),
      });
      expect(resolveSiteContext(experience, COSCUEZ_CORE, [message])).toBe('coscuez');
      const choice = 'quiero el prime';
      expect(contextAwareExtract(choice, repos, phone, {}, experience).collected_plan).toBe(COSCUEZ_PRIME);
      repos.message.addMessage({
        customer_phone: phone, direction: 'inbound', message_type: 'text',
        body: choice, created_at: new Date().toISOString(),
      });
      expect(reconstructFromHistory(repos, phone, { plan: COSCUEZ_PRIME }, experience).plan).toBe(COSCUEZ_PRIME);
    },
  );

  it.each(['mejor en Chivor, mandame su brochure', 'mejor en Chivor y mandame su brochure', 'mejor en Chivor, brochure porfa', 'mejor en Chivor mándame su brochure'])(
    'preserves an explicit destination choice with a brochure request: %s', message => {
      const experience = getActiveExperience(loadSkills());
      repos.conversation.upsert(phone, { collected_plan: COSCUEZ_CORE });
      expect(detectSiteChoice(message, experience)).toBe('chivor');
      expect(isPlanQuestion(message)).toBe(false);
      expect(contextAwareExtract(message, repos, phone, {}, experience).collected_plan).toBe(CORE);
    },
  );

  it.each([[CORE, 'chivor'], [COSCUEZ_CORE, 'coscuez']])('resolves brochure within the stored or named site: %s', (stored, site) => {
    // "del otro plan" is a two-plan rule.
    const experience = getActiveExperience(useAllSitesActive(withoutPlans(allSitesActivePayload(), ['basic_1d_chivor'])));
    const otherSite = site === 'chivor' ? 'coscuez' : 'chivor';
    // Without naming a different site, resolves "otro plan" within same site → PRIME counterpart
    expect(resolveBrochurePlanId('brochure del otro plan', stored, null, experience, site)).toBe(
      site === 'chivor' ? PRIME : COSCUEZ_PRIME
    );
    // Naming the other site with same tier, resolves to that site's counterpart plan
    expect(resolveBrochurePlanId(`brochure de ${otherSite}`, stored, null, experience, site)).toBe(
      otherSite === 'chivor' ? CORE : COSCUEZ_CORE
    );
  });

  it.each(['quiero el prime, mandame su brochure', 'quiero el prime y mandame su brochure', 'quiero el prime mandame su brochure'])('persists an explicit choice plus a brochure: %s', message => {
    const experience = getActiveExperience(loadSkills());
    repos.conversation.upsert(phone, { collected_plan: CORE });
    expect(isPlanQuestion(message)).toBe(false);
    expect(contextAwareExtract(message, repos, phone, {}, experience).collected_plan).toBe(PRIME);
  });

  it.each(['quiero el brochure del prime', 'mandame el brochure del prime', 'dale, mandame el brochure del prime', 'no quiero el prime, mandame su brochure'])('does not treat wanting a brochure as choosing a plan: %s', message => {
    const experience = getActiveExperience(loadSkills());
    repos.conversation.upsert(phone, { collected_plan: CORE });
    expect(isPlanQuestion(message)).toBe(true);
    expect(contextAwareExtract(message, repos, phone, {}, experience).collected_plan).toBeUndefined();
  });

  it('resolves identical quoted prices within the requested site only', () => {
    // Pin the collision: site prices may differ in the catalog, the site scoping must not.
    const experience = getActiveExperience(useAllSitesActive(withSamePricing(allSitesActivePayload(), PRIME, COSCUEZ_PRIME)));
    const amount = calculatePriceQuote(experience, { planId: PRIME, people: 2 })!.planTotal;
    expect(calculatePriceQuote(experience, { planId: COSCUEZ_PRIME, people: 2 })!.planTotal).toBe(amount);
    const reply = `El total es ${formatCop(amount)}.`;
    expect(detectQuotedPlan(reply, experience, 2)).toBeNull();
    expect(detectQuotedPlan(reply, experience, 2, 'chivor')).toBe(PRIME);
    expect(detectQuotedPlan(reply, experience, 2, 'coscuez')).toBe(COSCUEZ_PRIME);
  });

  it('renders restored transport facts and keeps site-specific safety data scoped', () => {
    const skills = loadSkills();
    const experience = getActiveExperience(skills);
    const prompt = assembleSystemPrompt({ skills, collectedFields: { site: 'coscuez' } });
    expect(prompt).toContain('05:10, 09:30 y 11:30');
    expect(prompt).toContain('no horarios de paso o recogida en Borbur');
    expect(prompt).toContain('referencia de aproximadamente 194km y 4h07m');
    expect(prompt).toContain('punto exacto y pin requieren confirmacion');
    expect(prompt).not.toMatch(/\+57\d{10}/);
    expect(getSiteCommonQuestions(skills, experience, 'coscuez').some(faq => faq.answer.includes('Magenta'))).toBe(false);
    // Only Coscuez's own unrestricted themes: never Chivor's (bike, kids, ...), and
    // not the PRIME-only excursion while no plan is chosen.
    expect(prompt).toContain('TEMAS DE GALERIA DISPONIBLES: mine, hotel.');
  });
});

// Live 2026-10-14: "Si el más completo" on Coscuez stored no plan, so no QUOTE LOCK
// and no plan card. The tier words the bot itself offers must resolve on both sites.
describe('tier words the bot offers resolve on every site', () => {
  it.each([
    ['Si el más completo', 'coscuez', COSCUEZ_PRIME],
    ['la más completa', 'coscuez', COSCUEZ_PRIME],
    ['la esencial', 'coscuez', COSCUEZ_CORE],
    ['Si el más completo', 'chivor', PRIME],
    ['la esencial', 'chivor', CORE],
  ])('%s on %s', (message, site, plan) => {
    expect(detectPlan(message, getActiveExperience(loadSkills()), site)).toBe(plan);
  });
});

describe('bare yes to a site question', () => {
  const OFFER = 'Chivor es la otra región.\n\n¿Te interesa Chivor para el mismo grupo de 2?';

  it.each(['Si', 'si!', 'Ok', 'dale', 'claro', 'de una', 'listo', 'me interesa'])('chooses the offered site: %s', message => {
    expect(resolveSiteAnswer(message, OFFER, getActiveExperience(loadSkills()))).toBe('chivor');
  });

  it.each([
    '¿Quieres que primero te cuente el plan de Chivor?',
    '¿Quieres revisar los planes de Chivor primero?',
    '¿Te gustaría conocer la información de Chivor?',
  ])('accepts a plan-review offer: %s', question => {
    expect(resolveSiteAnswer('Si', question, getActiveExperience(loadSkills()))).toBe('chivor');
  });

  it.each([
    ['no', OFFER],
    ['si pero Coscuez', OFFER],
    ['si, cuanto vale?', OFFER],
    ['Si', '¿Te mando fotos de la mina en Chivor?'],
    ['Si', '¿Qué fecha les sirve?'],
    ['Si', '¿Les sirve el 31 de octubre para Chivor?'],
    ['Si', '¿Les sirve el 31 para Chivor?'],
    ['Si', '¿Te interesa el sábado para Chivor?'],
    ['Si', '¿Prefieres esa fecha para Chivor?'],
    ['Si', '¿Les sirve el 31/10 para Chivor?'],
    ['Si', '¿Te gustaría iniciar la reserva de Chivor?'],
    ['Si', '¿Te interesa que reservemos en Chivor?'],
    ['Si', '¿Quieres revisar las fotos de Chivor primero?'],
    ['Si', '¿Te interesa Chivor o Coscuez?'],
    ['Si', 'Te interesa Chivor? Bueno, ¿qué fecha les sirve?'],
  ])('does not choose a site: %s after %s', (message, question) => {
    expect(resolveSiteAnswer(message, question, getActiveExperience(loadSkills()))).toBeNull();
  });

  it('switches the stored plan to the offered site and history does not revert it', () => {
    const experience = getActiveExperience(loadSkills());
    repos.conversation.upsert(phone, { collected_plan: COSCUEZ_PRIME });
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Coscuez', created_at: new Date(Date.now() - 180_000).toISOString() });
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Si la de Fura y Tena', created_at: new Date(Date.now() - 120_000).toISOString() });
    repos.message.addMessage({ customer_phone: phone, direction: 'outbound', message_type: 'text', body: OFFER, created_at: new Date(Date.now() - 60_000).toISOString() });

    const fields = contextAwareExtract('Si', repos, phone, {}, experience);
    expect(fields.collected_plan).toBe(PRIME);
    repos.conversation.upsert(phone, fields);
    repos.message.addMessage({ customer_phone: phone, direction: 'inbound', message_type: 'text', body: 'Si', created_at: new Date().toISOString() });

    expect(resolveSiteContext(experience, PRIME, ['Ok si como se llega?', 'Si', 'Si la de Fura y Tena', 'Coscuez'])).toBe('chivor');
    expect(reconstructFromHistory(repos, phone, { plan: PRIME }, experience).plan).toBe(PRIME);
  });
});

describe('RUNTIME cues for group and other-site photos', () => {
  const runtimeOf = (input: Partial<Parameters<typeof assembleSystemPrompt>[0]>): string =>
    assembleSystemPrompt({ skills: loadSkills(), ...input }).split('\nRUNTIME:').at(-1) ?? '';

  it('asks the group once a plan is chosen and the group is unknown', () => {
    expect(runtimeOf({ collectedFields: { plan: PRIME } })).toContain('GRUPO DESCONOCIDO');
    expect(runtimeOf({ collectedFields: { plan: PRIME, personas: 2 } })).not.toContain('GRUPO DESCONOCIDO');
    expect(runtimeOf({ collectedFields: {} })).not.toContain('GRUPO DESCONOCIDO');
  });

  it('leaves the question to close, consent, proactive and other-site turns', () => {
    const collectedFields = { plan: PRIME };
    expect(runtimeOf({ collectedFields, closeCtaAcceptedThisTurn: true })).not.toContain('GRUPO DESCONOCIDO');
    expect(runtimeOf({ collectedFields, consentAcceptedThisTurn: true })).not.toContain('GRUPO DESCONOCIDO');
    expect(runtimeOf({ collectedFields, proactiveMode: 'consent_ask' })).not.toContain('GRUPO DESCONOCIDO');
    expect(runtimeOf({ collectedFields, otherSitePhotoRequest: 'coscuez' })).not.toContain('GRUPO DESCONOCIDO');
  });

  it('cues the other-site photo question only when set', () => {
    expect(runtimeOf({ collectedFields: { plan: COSCUEZ_PRIME, personas: 2 }, otherSitePhotoRequest: 'chivor' }))
      .toContain('CLIENTE PIDIO FOTOS DE OTRO SITIO: "chivor"');
    expect(runtimeOf({ collectedFields: { plan: COSCUEZ_PRIME, personas: 2 } })).not.toContain('CLIENTE PIDIO FOTOS DE OTRO SITIO');
  });
});
