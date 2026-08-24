import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadSkills, type Skills } from '../services/skill-loader.js';
import {
  assembleSystemPrompt,
  renderBusinessData,
  renderCatalog,
  USED_EMOJIS_RUNTIME_LABEL,
} from '../services/skills-prompt-assembly.js';
import {
  assertReferentPacksExist,
  assertReferentAttributionMatches,
  getEntrySalesComposition,
  getReferentDisplayNames,
  getSalesComposition,
  renderReferentStrategies,
} from '../services/sales-composition.js';
import { getActiveExperience } from '../services/product-registry.js';
import { PRICING_NOT_AVAILABLE, AVAILABILITY_NOT_AVAILABLE } from '../services/dynamic-data-service.js';

describe('skills-prompt-assembly', () => {
  it('assembles sales skill + catalog + business data markers', () => {
    const skills = withLivePricing(loadSkills());
    const prompt = assembleSystemPrompt({ skills, lang: 'es' });

    expect(prompt).toContain('WHATSAPP SALES SKILL');
    expect(prompt).toContain('CATALOG PROTOCOL');
    expect(prompt).toContain('ENTRY STRATEGY');
    expect(prompt).toContain('COLD INFO HANDLER');
    expect(prompt).toContain('ESTRATEGIAS DE VENTA');
    expect(prompt).toContain('Cuando: cliente comparte necesidad');
    expect(prompt).not.toContain('Private Source B');
    expect(prompt).toContain('## CATALOGO');
    expect(prompt).toContain('## DATOS DEL NEGOCIO');
    expect(prompt).toContain('shortBrandIntro:');
    expect(prompt).toContain('1–3 líneas');
    expect(prompt).toContain('Language: es');
  });

  it('renders gallery type ids from the registry instead of site ids', () => {
    const base = loadSkills();
    const experienceId = getActiveExperience(base).id;
    const skills: Skills = {
      ...base,
      dynamicMedia: {
        ownerImage: null,
        planImages: [],
        galleryImages: [{
          experienceId,
          siteId: 'site_fixture',
          url: 'https://cdn.example.com/gallery/lodging.jpg',
          caption: '',
          type: 'lodging_fixture',
        }],
        siteTypes: { [`${experienceId}/site_fixture`]: ['lodging_fixture'] },
        typeKeywords: { [`${experienceId}/site_fixture`]: { lodging_fixture: ['rest_fixture'] } },
      },
    };

    const runtime = runtimeSection(assembleSystemPrompt({ skills, selectedExperienceId: experienceId }));

    expect(runtime).toContain('TEMAS DE GALERIA DISPONIBLES: lodging_fixture');
    expect(runtime).not.toContain('TEMAS DE GALERIA DISPONIBLES: site_fixture');
  });

  it('exposes delivered gallery state without adding sales copy in runtime', () => {
    const runtime = runtimeSection(assembleSystemPrompt({
      skills: withLivePricing(loadSkills()),
      galleryShown: true,
    }));

    expect(runtime).toContain('GALERIA_YA_MOSTRADA: true');
  });

  it('exposes the current photo request and independent remaining image budget', () => {
    const runtime = runtimeSection(assembleSystemPrompt({
      skills: withLivePricing(loadSkills()),
      galleryRequestThemes: ['hotel_fixture', 'car_fixture'],
      galleryImagesRemaining: 3,
    }));

    expect(runtime).toContain('PEDIDO DE FOTOS ESTE TURNO: hotel_fixture, car_fixture.');
    expect(runtime).toContain('CUPO_FOTOS_RESTANTE: 3.');
  });

  it('renders the exact validated media marker in the corrective retry instruction', () => {
    const runtime = runtimeSection(assembleSystemPrompt({
      skills: withLivePricing(loadSkills()),
      galleryRequestThemes: ['hotel_fixture', 'car_fixture'],
      galleryRetryInstruction: true,
    }));

    expect(runtime).toContain('termina literalmente con [[FOTOS:hotel_fixture,car_fixture]]');
    expect(runtime).not.toContain('[[FOTOS:tema]]');
  });

  it('requires the corrective rewrite to end visible copy with one advancing question', () => {
    const runtime = runtimeSection(assembleSystemPrompt({
      skills: withLivePricing(loadSkills()),
      galleryRequestThemes: ['car_fixture'],
      galleryRetryInstruction: true,
      advanceQuestionRetryInstruction: true,
    }));

    expect(runtime).toContain('CORRECCION PREGUNTA:');
    expect(runtime).toContain('terminar con exactamente una pregunta de avance');
    expect(runtime).toContain('[[FOTOS:car_fixture]]');
  });

  it('omits cross-site ambiguous themes until a plan selects the site', () => {
    const base = loadSkills();
    const experience = getActiveExperience(base);
    const plan = experience.plans.find(candidate => candidate.siteId === 'chivor');
    expect(plan).toBeDefined();
    const skills: Skills = {
      ...base,
      dynamicMedia: {
        ownerImage: null,
        planImages: [],
        galleryImages: [
          { experienceId: experience.id, siteId: 'chivor', url: 'https://cdn.example.com/chivor.jpg', caption: '', type: 'lodging_fixture' },
          { experienceId: experience.id, siteId: 'other', url: 'https://cdn.example.com/other.jpg', caption: '', type: 'lodging_fixture' },
          { experienceId: experience.id, siteId: 'chivor', url: 'https://cdn.example.com/mine.jpg', caption: '', type: 'mine_fixture' },
        ],
        siteTypes: {
          [`${experience.id}/chivor`]: ['lodging_fixture', 'mine_fixture'],
          [`${experience.id}/other`]: ['lodging_fixture'],
        },
        typeKeywords: {},
      },
    };

    const unresolved = runtimeSection(assembleSystemPrompt({ skills }));
    const scoped = runtimeSection(assembleSystemPrompt({
      skills,
      collectedFields: { plan: plan!.id },
    }));

    expect(unresolved).toContain('TEMAS DE GALERIA DISPONIBLES: mine_fixture');
    expect(unresolved).not.toContain('lodging_fixture');
    expect(scoped).toContain('TEMAS DE GALERIA DISPONIBLES: lodging_fixture, mine_fixture');
  });

  it('uses the selected experience when resolving the plan site for gallery themes', () => {
    const base = loadSkills();
    const first = getActiveExperience(base);
    const secondPlan = { ...first.plans[0], id: 'second_plan', siteId: 'second_site' };
    const second = { ...first, id: 'second_experience', plans: [secondPlan] };
    const skills: Skills = {
      ...base,
      andeanScapes: {
        ...base.andeanScapes,
        experiences: [first, second],
      },
      dynamicMedia: {
        ownerImage: null,
        planImages: [],
        galleryImages: [
          { experienceId: second.id, siteId: 'second_site', url: 'https://cdn.example.com/second.jpg', caption: '', type: 'shared_fixture' },
          { experienceId: second.id, siteId: 'other_site', url: 'https://cdn.example.com/other.jpg', caption: '', type: 'shared_fixture' },
        ],
        siteTypes: {
          [`${second.id}/second_site`]: ['shared_fixture'],
          [`${second.id}/other_site`]: ['shared_fixture'],
        },
        typeKeywords: {},
      },
    };

    const runtime = runtimeSection(assembleSystemPrompt({
      skills,
      selectedExperienceId: second.id,
      collectedFields: { plan: secondPlan.id },
    }));

    expect(runtime).toContain('TEMAS DE GALERIA DISPONIBLES: shared_fixture');
  });

  it('embeds the C03 no-invented-state, single-date and published-vs-available guardrails', () => {
    const prompt = assembleSystemPrompt({ skills: withLivePricing(loadSkills()), lang: 'es' });
    // Assert the distinctive clause of each rule, not a phrase like "esa fecha"
    // that already occurs several times in the sales skill — that would pass
    // even if the guardrail were deleted.
    expect(prompt).toContain('Están pensando en algún mes en particular');
    expect(prompt).toContain('Hagas referencia a un estado que no existe');
    expect(prompt).toContain('Si no está en RUNTIME, no lo nombre');
    expect(prompt).toContain('Una sola fecha publicada');
    expect(prompt).toContain('salida programada');
    expect(prompt).toContain('cliente puede frenar el cierre');
    expect(prompt).toContain('quieres que iniciemos la reserva');
    expect(prompt).toContain('primera respuesta donde el cliente elige un plan');
    // Regression anchor: no-question endings survive budget trims only via the
    // explicit POST-CTA exception, not via a blanket "no question needed" license.
    expect(prompt).toContain('cierre ya confirmado donde solo falta el equipo');
    expect(prompt).toContain('te falta un dato: preguntá');
  });

  it('orders the skills so entry strategy precedes the first-turn handler', () => {
    const prompt = assembleSystemPrompt({ skills: withLivePricing(loadSkills()), lang: 'es' });
    const at = (needle: string) => {
      const index = prompt.indexOf(needle);
      expect(index).toBeGreaterThan(-1);
      return index;
    };

    // Matched on the H1 headings: the skills cross-reference each other by name in
    // their body text, so a bare substring finds the reference, not the section.
    // cold-info-handler reads the segment contract that entry-strategy establishes,
    // so swapping those two silently degrades every first-contact reply.
    const order = [
      '# SELLER PERSONALITY',
      '# ENTRY STRATEGY',
      '# COLD INFO HANDLER',
      '# WHATSAPP SALES SKILL',
      '# ANDEAN SCAPES — CATALOG PROTOCOL',
      'ESTRATEGIAS DE VENTA (principios internos',
      '## CATALOGO (experiencias activas',
      '## DATOS DEL NEGOCIO (precios',
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('keeps referent identities out of the prompt and tokens substituted', () => {
    const prompt = assembleSystemPrompt({ skills: withLivePricing(loadSkills()), lang: 'es' });

    // Referent attribution is audit-only metadata in the CDN feed; the anonymized
    // packs are the only referent content the model may see.
    for (const name of getReferentDisplayNames()) {
      expect(prompt).not.toContain(name);
    }
    expect(prompt).not.toContain('Hermanas Carvajalino');
    expect(prompt).not.toContain('{{OWNER_NAME}}');
    expect(prompt).not.toContain('{{PARTNER_NAME}}');
  });

  it('renders catalog narrative without inventing prices in catalog block', () => {
    const skills = withLivePricing(loadSkills());
    const exp = getActiveExperience(skills);
    const catalog = renderCatalog(skills);

    expect(catalog).toContain(exp.id);
    expect(catalog).toContain(exp.name);
    expect(catalog).toContain('PLANS:');
    expect(catalog).toContain(exp.plans[0]?.name);
  });

  it('renders dynamic prices in business data and keeps payment phones out', () => {
    const skills = withLivePricing(loadSkills());
    skills.dynamicData = {
      experiences: {},
      media: null,
      payments: {
        currency: 'COP',
        deposit: {
          type: 'percentage',
          value: 15,
          label: 'Anticipo',
          calculationRule: 'x * 0.15',
          remainingBalance: { type: 'percentage', value: 85, label: 'Saldo' },
        },
        methods: [{
          id: 'nequi',
          name: 'Nequi',
          type: 'mobile_transfer',
          enabled: true,
          currency: 'COP',
          requiresPaymentProof: true,
        }],
        confirmation: { automatic: false, requiresTeamValidation: true, message: 'Validar primero.' },
        displayPolicy: {
          showMethodsAfterAvailabilityValidation: true,
          showWhenCustomerAsks: true,
          neverRequestFullPaymentWithoutConfirmation: true,
        },
      },
      referentAttribution: {
        profileId: 'andean-scapes-co',
        version: 1,
        sources: {
          'referent.a': { role: 'cold-open', sourceLabel: 'Private Source A' },
        },
      },
    };

    const business = renderBusinessData(skills);
    const prompt = assembleSystemPrompt({ skills });
    const exp = getActiveExperience(skills);
    const coupleItem = exp.pricing.items.find(i => i.couplePrice != null && i.publiclyShow);
    expect(coupleItem?.couplePrice).toBeTruthy();

    expect(business).toContain('methods_enabled: Nequi');
    expect(business).toContain('deposit: 15%');
    expect(business).toContain(String(coupleItem!.couplePrice!.toLocaleString('es-CO')));
    expect(prompt).not.toContain('3009900001');
    expect(prompt).not.toContain('+573009900001');
    expect(prompt).not.toContain('https://pay.example/secret');
    expect(prompt).not.toContain('Transfiere al');
    expect(prompt).not.toMatch(/\b3\d{9}\b/);
    expect(prompt).not.toContain('Private Source A');
  });

  it('marks pricing unavailable when items empty', () => {
    const skills = withUnavailablePricing(loadSkills());
    const business = renderBusinessData(skills);
    expect(business).toContain('PRICING: NO DISPONIBLE — el equipo confirma');
  });

  it('does not use static payment facts when loaded dynamic data omits payments', () => {
    const skills = loadSkills();
    skills.dynamicData = { experiences: {}, media: null, payments: null };

    const business = renderBusinessData(skills);

    expect(business).toContain('PAYMENTS (global): NO DISPONIBLE');
    expect(business).not.toContain('deposit: 15%');
    expect(business).not.toContain('methods_enabled: Nequi');
  });

  it('includes selected experience and known fields in runtime block', () => {
    const skills = loadSkills();
    const expId = getActiveExperience(skills).id;
    const prompt = assembleSystemPrompt({
      skills,
      selectedExperienceId: expId,
      collectedFields: { personas: 2, plan: 'couple' },
      salesPhase: 'pricing',
      customerContext: { people: 2, transport: 'own_car' },
    });

    expect(prompt).toContain(`EXPERIENCIA ACTIVA: ${expId}`);
    expect(prompt).toContain('LO QUE YA SABEMOS DE ESTE CLIENTE');
    expect(prompt).toContain('personas: 2');
    expect(prompt).toContain('CONTINUACION:');
    expect(prompt).toContain('SALES PHASE ACTUAL: pricing');
    expect(prompt).toContain('People: 2');
    expect(prompt).toContain('Transport mentioned: own_car');
  });

  it('injects an authoritative quote lock when group and plan are known', () => {
    const skills = withLivePricing(loadSkills());
    const planId = getActiveExperience(skills).plans[0].id;
    const prompt = assembleSystemPrompt({
      skills,
      collectedFields: { personas: 5, plan: planId },
    });

    expect(prompt).toContain('QUOTE LOCK:');
    expect(prompt).toContain('Para 5 personas, el plan queda en');
    expect(prompt).toContain('Copia esas personas y ese total');
  });

  // The price gate lives in whatsapp-sales.skill.md: no quote before the plan is
  // chosen. Injecting a total for plans[0] would override it with an
  // "authoritative" figure for a plan the customer never picked.
  it('omits the quote lock when the group is known but the plan is not', () => {
    const skills = withLivePricing(loadSkills());
    expect(getActiveExperience(skills).plans.length).toBeGreaterThan(1);

    const prompt = assembleSystemPrompt({ skills, collectedFields: { personas: 5 } });

    expect(prompt).not.toContain('QUOTE LOCK:');
    expect(prompt).toContain('PRICE GATE ACTIVO:');
    expect(prompt).toContain('No escribas precios ni totales');
  });

  it('injects T3a instruction when date accepted but price not given', () => {
    const skills = withLivePricing(loadSkills());
    const planId = getActiveExperience(skills).plans[0].id;
    const prompt = assembleSystemPrompt({
      skills,
      collectedFields: { personas: 2, plan: planId, date: 'sábado 14 de noviembre' },
      priceGiven: false,
      dateSelectedThisTurn: true,
    });

    expect(prompt).toContain('ESTADO DE TURNO: T3a');
    expect(prompt).toContain('eligió una fecha concreta en este inbound');
    expect(prompt).toContain('QUOTE LOCK:');
    const t3bIdx = prompt.indexOf('ESTADO DE TURNO: T3b');
    const t3aIdx = prompt.indexOf('ESTADO DE TURNO: T3a');
    expect(t3bIdx).toBe(-1);
    expect(t3aIdx).toBeGreaterThan(-1);
  });

  it('does not force T3a from a date persisted on an earlier turn', () => {
    const skills = withLivePricing(loadSkills());
    const planId = getActiveExperience(skills).plans[0].id;
    const prompt = assembleSystemPrompt({
      skills,
      collectedFields: { personas: 2, plan: planId, date: 'sábado 14 de noviembre' },
      priceGiven: false,
      latestCustomerMessage: '¿Qué incluye el plan?',
    });

    expect(prompt).not.toContain('ESTADO DE TURNO: T3a');
    expect(prompt).toContain('QUOTE LOCK:');
  });

  it('keeps T3a authoritative when the date-selection message also asks how to reserve', () => {
    const skills = withLivePricing(loadSkills());
    const planId = getActiveExperience(skills).plans[0].id;
    const prompt = assembleSystemPrompt({
      skills,
      collectedFields: { personas: 2, plan: planId, date: 'sábado 14 de noviembre' },
      priceGiven: false,
      dateSelectedThisTurn: true,
      latestCustomerMessage: 'El 14, ¿cómo reservo?',
    });

    expect(prompt).toContain('ESTADO DE TURNO: T3a');
    expect(prompt).not.toContain('INTENCION DE RESERVA:');
  });

  it('injects T3b instruction when date accepted and price already given', () => {
    const skills = withLivePricing(loadSkills());
    const planId = getActiveExperience(skills).plans[0].id;
    const prompt = assembleSystemPrompt({
      skills,
      collectedFields: { personas: 2, plan: planId, date: 'sábado 14 de noviembre' },
      priceGiven: true,
    });

    expect(prompt).toContain('ESTADO DE TURNO: T3b');
    expect(prompt).toContain('fecha concreta y el precio ya fue entregado');
    expect(prompt).not.toContain('ESTADO DE TURNO: T3a');
  });

  it('injects POST-CTA with the next useful missing field after close CTA acceptance', () => {
    const skills = withLivePricing(loadSkills());
    const planId = getActiveExperience(skills).plans[0].id;
    const prompt = assembleSystemPrompt({
      skills,
      collectedFields: { personas: 2, plan: planId, date: 'sábado 14 de noviembre', transporte: 'own' },
      priceGiven: true,
      closeCtaAcceptedThisTurn: true,
    });

    expect(prompt).toContain('ESTADO DE TURNO: POST-CTA');
    expect(prompt).toContain('DATO OPERATIVO FALTANTE: nombre');
    expect(prompt).not.toContain('ESTADO DE TURNO: T3b');
  });

  it('does not force a question in POST-CTA when operational fields are complete', () => {
    const skills = withLivePricing(loadSkills());
    const planId = getActiveExperience(skills).plans[0].id;
    const prompt = assembleSystemPrompt({
      skills,
      collectedFields: {
        nombre: 'Heinner', personas: 2, plan: planId,
        date: 'sábado 14 de noviembre', transporte: 'own',
      },
      priceGiven: true,
      closeCtaAcceptedThisTurn: true,
    });

    expect(prompt).toContain('DATO OPERATIVO FALTANTE: ninguno');
  });

  it('locks a single-plan experience without needing an explicit plan choice', () => {
    const skills = withLivePricing(loadSkills());
    const exp = getActiveExperience(skills);
    const allPlans = exp.plans;
    exp.plans = [allPlans[0]];

    try {
      const prompt = assembleSystemPrompt({ skills, collectedFields: { personas: 2 } });
      expect(prompt).toContain('QUOTE LOCK:');
    } finally {
      exp.plans = allPlans;
    }
  });

  it('formats the locked total like the catalog prices so the model can copy it verbatim', () => {
    const skills = withLivePricing(loadSkills());
    const planId = getActiveExperience(skills).plans[0].id;
    const prompt = assembleSystemPrompt({
      skills,
      collectedFields: { personas: 5, plan: planId },
    });

    // couple 1.000.000 / 2 * 5, rendered es-CO exactly as PLANS_PRICES renders it.
    // Keep the authorized amount and its copy instruction adjacent for weaker models.
    expect(prompt).toContain('QUOTE LOCK');
    expect(prompt).toContain('$2.500.000');
    expect(prompt).toContain('Para 5 personas, el plan queda en $2.500.000 COP');
    expect(prompt).not.toContain('2,500,000');
  });

  it('grounds safety-critical FAQs in the catalog so the LLM never improvises them', () => {
    const skills = loadSkills();
    const prompt = assembleSystemPrompt({ skills });
    const physicalRecovery = getActiveExperience(skills).commonQuestions
      .find(q => q.intent === 'physical_recovery' && q.lang === 'es')?.answer;
    const leadTime = getActiveExperience(skills).commonQuestions
      .find(q => q.intent === 'reservation_lead_time' && q.lang === 'es')?.answer;

    expect(physicalRecovery).toBeTruthy();
    expect(prompt).toContain('SAFETY_FAQ');
    expect(prompt).toContain(physicalRecovery!);
    if (leadTime) expect(prompt).toContain(leadTime);
  });

  it('emits PLAN ACTIVO state when a plan is known, and omits it otherwise', () => {
    const skills = loadSkills();
    const planId = getActiveExperience(skills).plans[0].id;

    const withPlan = assembleSystemPrompt({ skills, collectedFields: { plan: planId } });
    expect(withPlan).toContain(`PLAN ACTIVO: ${planId}`);

    const withoutPlan = assembleSystemPrompt({ skills, collectedFields: { personas: 2 } });
    expect(withoutPlan).not.toMatch(/^PLAN ACTIVO:/m);
  });

  it('includes personality skill before sales skill in the assembled prompt', () => {
    const skills = loadSkills();
    const prompt = assembleSystemPrompt({ skills });

    expect(prompt).toContain('SELLER PERSONALITY');
    expect(prompt).toContain('VIÑETAS FIJAS');
    expect(prompt).toContain('APERTURA');
    // Personality must appear before sales methodology.
    const persIdx = prompt.indexOf('SELLER PERSONALITY');
    const salesIdx = prompt.indexOf('WHATSAPP SALES SKILL');
    expect(persIdx).toBeGreaterThan(-1);
    expect(salesIdx).toBeGreaterThan(persIdx);
  });

  it('renders referent strategy without exposing referent metadata', () => {
    const prompt = assembleSystemPrompt({ skills: loadSkills() });

    expect(prompt).toContain('ESTRATEGIA PRINCIPAL');
    expect(prompt).toContain('Cuando: cliente comparte necesidad');
    // No display name of ANY loaded pack may reach the prompt.
    for (const name of getReferentDisplayNames()) {
      expect(prompt).not.toContain(name);
    }
  });

  it('orders referents by weight and renders sub-threshold packs as summary only', () => {
    const { profile, referents } = getSalesComposition();
    const block = renderReferentStrategies();
    const sorted = [...profile.referents].sort((a, b) => b.weight - a.weight);

    expect(block.indexOf('ESTRATEGIA PRINCIPAL')).toBeLessThan(block.indexOf('ESTRATEGIA COMPLEMENTARIA'));
    expect(block.split('ESTRATEGIA ').length - 1).toBeLessThanOrEqual(profile.renderRules.maxReferents);

    const lowest = sorted[sorted.length - 1];
    if (lowest.weight < profile.renderRules.fullContentMinWeight) {
      const pack = referents.get(lowest.packId)!;
      expect(block).toContain(pack.summary);
      expect(block).not.toContain(pack.keyPoints[0].do);
    }
  });

  it('excludes zero-weight referents from the rendered block', () => {
    const { referents } = getSalesComposition();
    const pack = referents.get('referent.b')!;
    const block = renderReferentStrategies({
      referents,
      profile: {
        profileId: 'test',
        version: 1,
        referents: [
          { packId: 'referent.b', weight: 50 },
          { packId: 'referent.g', weight: 0 },
        ],
        entryStrategies: {
          cold: [{ packId: 'referent.b', weight: 50 }],
          funnel: [{ packId: 'referent.b', weight: 50 }],
          retargeting: [{ packId: 'referent.b', weight: 50 }],
        },
        renderRules: { fullContentMinWeight: 10, maxReferents: 4 },
        tokenBudget: { systemPromptMaxTokens: 13000 },
      },
    });

    expect(block).toContain(pack.keyPoints[0].do);
    expect(block).not.toContain(referents.get('referent.g')!.summary);
  });

  it('rejects a profile that references a missing referent pack', () => {
    expect(() => assertReferentPacksExist({
      profileReferentIds: ['referent.does-not-exist'],
      available: new Set(['referent.b']),
    })).toThrow(/referent.does-not-exist/);
  });

  it('rejects remote attribution that does not match the local profile and packs', () => {
    const { profile, referents } = getSalesComposition();
    const sources = Object.fromEntries(
      [...referents.keys()].map(packId => [packId, { role: 'test', sourceLabel: 'Private Source' }]),
    );

    expect(() => assertReferentAttributionMatches({ profileId: 'other-profile', version: profile.version, sources }))
      .toThrow(/does not match/);
    delete sources['referent.a'];
    expect(() => assertReferentAttributionMatches({ profileId: profile.profileId, version: profile.version, sources }))
      .toThrow(/missing=\[referent.a\]/);
    expect(() => assertReferentAttributionMatches({
      profileId: profile.profileId,
      version: profile.version + 1,
      sources: Object.fromEntries(
        [...referents.keys()].map(packId => [packId, { role: 'test', sourceLabel: 'Private Source' }]),
      ),
    })).toThrow(/version/);
  });

  it('renders campaign strategy without exposing referent names', () => {
    const prompt = assembleSystemPrompt({
      skills: withLivePricing(loadSkills()),
      lang: 'es',
      entryMarker: { code: 'R01', temperature: 'retargeting' },
      priorContext: 'historial local disponible; plan=2d1n_mining · precio ya entregado',
    });

    expect(prompt).toContain('ENTRADA: retargeting (R01)');
    expect(prompt).toContain('CONTEXTO PREVIO: historial local disponible');
    const retargetPack = getEntrySalesComposition('retargeting').profile.referents[0].packId;
    expect(prompt).toContain('Continúa desde los últimos datos confirmados sin repetir.');
    expect(prompt).toContain('Estructura clara: (1) valida lo dicho, (2) suma un dato factual, (3) cierra con un siguiente paso específico.');
    expect(prompt).toContain('Resume en una línea: grupo + plan + lo que falta (validar disponibilidad y pago).');
    expect(retargetPack).toBe('referent.h');
    expect(prompt).not.toContain('Private Source H');
  });

  it('lists the emojis already used in the thread so the model rotates', () => {
    const skills = loadSkills();
    const prompt = assembleSystemPrompt({ skills, lang: 'es', usedEmojis: ['🙌', '🌿'] });

    expect(runtimeSection(prompt)).toContain(`${USED_EMOJIS_RUNTIME_LABEL}: 🙌 🌿`);
    expect(runtimeSection(prompt)).toContain('no repitas ninguno de estos');
  });

  // The skills tell the model to consult this RUNTIME block by name. Renaming the
  // constant without updating them would point the instruction at nothing.
  it('keeps the emoji-rotation label in sync with the prompt skills that cite it', () => {
    const promptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
    for (const file of ['seller-personality.skill.md', 'whatsapp-sales.skill.md']) {
      expect(readFileSync(join(promptsDir, file), 'utf-8')).toContain('EMOJIS YA USADOS');
    }
    expect(USED_EMOJIS_RUNTIME_LABEL).toContain('EMOJIS YA USADOS');
  });

  // Asserted against the RUNTIME section only: the static personality skill also
  // mentions the phrase (it tells the model where the list comes from), so a
  // whole-prompt negative assertion would be vacuous.
  it('adds no emoji-rotation line when nothing was used yet', () => {
    const skills = loadSkills();
    expect(runtimeSection(assembleSystemPrompt({ skills, lang: 'es', usedEmojis: [] }))).not.toContain('EMOJIS YA USADOS');
    expect(runtimeSection(assembleSystemPrompt({ skills, lang: 'es' }))).not.toContain('EMOJIS YA USADOS');
  });

  // The proactive consent cue is pushed last on purpose so it overrides sales-turn
  // cues; the rotation line must not displace it.
  it('keeps the consent-ask cue after the emoji-rotation line', () => {
    const skills = loadSkills();
    const prompt = assembleSystemPrompt({
      skills, lang: 'es', usedEmojis: ['🙌'], proactiveMode: 'consent_ask',
    });

    expect(prompt.indexOf('EMOJIS YA USADOS')).toBeLessThan(prompt.indexOf('ESTADO DE TURNO: PERMISO-SEGUIMIENTO'));
  });

  it('keeps the consent ask generic instead of offering a sales action', () => {
    const prompt = assembleSystemPrompt({
      skills: loadSkills(), lang: 'es', proactiveMode: 'consent_ask',
    });

    expect(prompt).toContain('pregunta genérica de beneficio');
    expect(prompt).not.toContain('te revise disponibilidad en otro mes');
  });

  it('asks for the post-stop variant only when re-asking after an opt-out', () => {
    const skills = loadSkills();
    const plain = runtimeSection(assembleSystemPrompt({ skills, lang: 'es', proactiveMode: 'consent_ask' }));
    const reask = runtimeSection(assembleSystemPrompt({
      skills, lang: 'es', proactiveMode: 'consent_ask', reaskAfterOptOut: true,
    }));

    expect(plain).not.toContain('POST-PARADA');
    expect(reask).toContain('POST-PARADA');
    // The variant is ADDITIVE: dropping the base section is what let the model
    // omit the mandatory marker.
    expect(reask).toContain('§PERMISO-SEGUIMIENTO');
    expect(reask).toContain('[[FOLLOWUP_CONSENT]]');
  });

  // A reask flag on an ordinary inbound turn must not smuggle a proactive
  // permission cue into a normal sales reply.
  it('ignores reaskAfterOptOut when the turn is not a consent ask', () => {
    const skills = loadSkills();
    const runtime = runtimeSection(assembleSystemPrompt({ skills, lang: 'es', reaskAfterOptOut: true }));

    expect(runtime).not.toContain('POST-PARADA');
    expect(runtime).not.toContain('ESTADO DE TURNO: PERMISO-SEGUIMIENTO');
  });

});

/** Only the per-turn RUNTIME block, so assertions cannot match the static skills. */
function runtimeSection(prompt: string): string {
  const marker = '\nRUNTIME:';
  const idx = prompt.lastIndexOf(marker);
  return idx === -1 ? '' : prompt.slice(idx + marker.length);
}

function withLivePricing(skills: Skills): Skills {
  const exp = skills.andeanScapes.experiences[0];
  const orig = exp.pricing;
  exp.pricing = {
    currency: 'COP',
    lastUpdated: '2026-01-01',
    items: [
      {
        id: 'couple',
        planId: exp.plans[0]?.id ?? 'plan_a',
        label: 'Pareja',
        couplePrice: 1_000_000,
        peopleIncluded: 2,
        publiclyShow: true,
      },
      {
        id: 'solo',
        planId: exp.plans[0]?.id ?? 'plan_a',
        label: 'Individual',
        pricePerPerson: 550_000,
        publiclyShow: true,
      },
    ],
    botRules: ['REMOTE: test rule', ...orig.businessRules],
    businessRules: orig.businessRules,
  };
  exp.availability = {
    ...exp.availability,
    botRule: 'Use published dates only.',
    availableDates: [
      { date: '2099-08-17', status: 'available', slotsApprox: null },
      { date: '2099-08-18', status: 'limited', slotsApprox: 2 },
    ],
  };
  return skills;
}

function withUnavailablePricing(skills: Skills): Skills {
  return {
    ...skills,
    andeanScapes: {
      ...skills.andeanScapes,
      experiences: skills.andeanScapes.experiences.map((experience, index) =>
        index === 0
          ? {
              ...experience,
              pricing: {
                ...experience.pricing,
                items: [],
                botRules: [PRICING_NOT_AVAILABLE],
              },
              availability: {
                ...experience.availability,
                availableDates: [],
                botRule: AVAILABILITY_NOT_AVAILABLE,
              },
            }
          : experience,
      ),
    },
  };
}
