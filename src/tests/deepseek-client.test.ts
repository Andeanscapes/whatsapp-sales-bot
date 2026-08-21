import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../services/deepseek-client.js';
import { loadSkills, type Skills } from '../services/skill-loader.js';
import { AVAILABILITY_NOT_AVAILABLE, PRICING_NOT_AVAILABLE } from '../services/dynamic-data-service.js';
import { getActiveExperience } from '../services/product-registry.js';
import { containsClosingDelay } from '../services/reply-guard.js';


describe('buildSystemPrompt (skills assembly)', () => {
  it('uses skills assembly markers', () => {
    const skills = loadSkills();
    const prompt = buildSystemPrompt({ skills, lang: 'es' });

    expect(prompt).toContain('WHATSAPP SALES SKILL');
    expect(prompt).toContain('## CATALOGO');
    expect(prompt).toContain('## DATOS DEL NEGOCIO');
    expect(prompt).not.toContain('Customer-first selling:');
  });

  it('marks pricing unavailable when items empty', () => {
    const skills = withUnavailablePricingAndAvailability(loadSkills());
    const prompt = buildSystemPrompt({ skills });
    expect(prompt).toContain('PRICING: NO DISPONIBLE — el equipo confirma');
    expect(prompt).not.toContain('Price with context:');
  });

  it('exposes only future available or limited dates to the LLM', () => {
    const skills = loadSkills();
    const exp = getActiveExperience(skills);
    const dates: Array<{ date: string; status: 'available' | 'limited' | 'unavailable' | 'soldout'; slotsApprox: number | null }> = [
      { date: '2099-08-16', status: 'soldout', slotsApprox: 0 },
      { date: '2099-08-17', status: 'available', slotsApprox: null },
      { date: '2099-08-18', status: 'limited', slotsApprox: 2 },
      { date: '2099-08-19', status: 'unavailable', slotsApprox: null },
    ];
    exp.availability = { ...exp.availability, botRule: 'Use published dates only.', availableDates: dates };
    // Site renderer reads dynamicData.sites — keep both in sync for the test.
    const dynExp = skills.dynamicData?.experiences[exp.id];
    if (dynExp) {
      dynExp.availability = { ...dynExp.availability, botRule: 'Use published dates only.', availableDates: dates };
      for (const site of Object.values(dynExp.sites)) {
        site.availability = { ...site.availability, botRule: 'Use published dates only.', availableDates: dates };
      }
    }
    const prompt = buildSystemPrompt({ skills, lang: 'es' });
    expect(prompt).toContain('2099-08-17');
    expect(prompt).toContain('2099-08-18');
    expect(prompt).not.toContain('2099-08-16');
    expect(prompt).not.toContain('2099-08-19');
  });

  it('merges pricing rules when available', () => {
    const skills = loadSkills();
    const exp = skills.andeanScapes.experiences[0];
    exp.pricing = {
      currency: 'COP',
      lastUpdated: '2026-01-01',
      items: [
        { id: 'couple', planId: '2d1n_mining', label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true },
      ],
      botRules: ['REMOTE: 15% deposito via Nequi o Mercado Pago'],
      businessRules: [],
    };
    const dynExp = skills.dynamicData?.experiences[exp.id];
    if (dynExp) {
      dynExp.pricing = {
        ...dynExp.pricing,
        items: [{
          id: 'couple', kind: 'plan', siteId: 'chivor', planId: '2d1n_mining',
          label: 'Pareja', couplePrice: 1000000, peopleIncluded: 2, publiclyShow: true,
        }],
        botRules: ['REMOTE: 15% deposito via Nequi o Mercado Pago'],
      };
      for (const site of Object.values(dynExp.sites)) {
        site.rules = ['REMOTE: 15% deposito via Nequi o Mercado Pago'];
      }
    }
    const prompt = buildSystemPrompt({ skills });
    expect(prompt).toContain('REMOTE: 15% deposito');
    expect(prompt).toContain('1.000.000');
  });

  it('keeps payment credentials out of the LLM prompt', () => {
    const skills = loadSkills();
    skills.dynamicData = {
      experiences: {},
      media: null,
      payments: {
        currency: 'COP',
        deposit: {
          type: 'percentage', value: 15, label: 'Anticipo', calculationRule: 'x * 0.15',
          remainingBalance: { type: 'percentage', value: 85, label: 'Saldo' },
        },
        methods: [{
          id: 'nequi', name: 'Nequi', type: 'mobile_transfer', enabled: true,
          currency: 'COP', requiresPaymentProof: true,
        }],
        confirmation: { automatic: false, requiresTeamValidation: true, message: 'Validar primero.' },
        displayPolicy: {
          showMethodsAfterAvailabilityValidation: true,
          showWhenCustomerAsks: true,
          neverRequestFullPaymentWithoutConfirmation: true,
        },
      },
    };

    const prompt = buildSystemPrompt({ skills });

    expect(prompt).toMatch(/15%/);
    expect(prompt).toContain('Nequi');
    expect(prompt).not.toContain('3000000000');
    expect(prompt).not.toContain('Transfiere al');
  });

  it('includes explicit family and transport context without inventing facts', () => {
    const prompt = buildSystemPrompt({
      skills: loadSkills(),
      lang: 'es',
      customerContext: {
        date: 'octubre',
        transport: 'own_motorcycle',
        childAges: [5],
        groupRelationship: 'padre e hijo',
      },
    });

    expect(prompt).toContain('Date mentioned: octubre');
    expect(prompt).toContain('Transport mentioned: own_motorcycle');
    expect(prompt).toContain('Child ages mentioned: 5');
    expect(prompt).toContain('Group relationship: padre e hijo');
  });

  it('grounds public bus guidance from catalog route narrative', () => {
    const prompt = buildSystemPrompt({ skills: loadSkills(), lang: 'es' });
    expect(prompt).toContain('Terminal Salitre');
    expect(prompt).toMatch(/bus|Flota|Salitre/i);
  });
});

function withUnavailablePricingAndAvailability(skills: Skills): Skills {
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
          : experience
      ),
    },
  };
}

describe('containsClosingDelay', () => {
  it('detects "mañana te envío" postponement', () => {
    expect(containsClosingDelay('Perfecto, mañana te envío los datos de pago.')).toBe(true);
  });

  it('detects "déjame saber si te gustaría" stall', () => {
    expect(containsClosingDelay('Déjame saber si te gustaría dejar tu reserva en firme.')).toBe(true);
  });

  it('detects "luego te confirmo" delay', () => {
    expect(containsClosingDelay('Luego te confirmo disponibilidad para esa fecha.')).toBe(true);
  });

  it('detects "let me know if you would like" English', () => {
    expect(containsClosingDelay('Let me know if you would like to book this date.')).toBe(true);
  });

  it('detects "I will send the link tomorrow"', () => {
    expect(containsClosingDelay('Great, I will send the link tomorrow morning.')).toBe(true);
  });

  it('detects "cuando quieras seguimos" indefinite deferral', () => {
    expect(containsClosingDelay('Cuando quieras seguimos con la reserva.')).toBe(true);
  });

  it('normal closing message passes (no delay)', () => {
    expect(containsClosingDelay('¿Quieres que valide disponibilidad para el 15 de agosto?')).toBe(false);
  });

  it('value-only description passes (no delay)', () => {
    expect(containsClosingDelay('Incluye alojamiento, comidas, guía local y experiencia en la mina.')).toBe(false);
  });

  it('booking intent passes (no delay)', () => {
    expect(containsClosingDelay('Perfecto, inicia la reserva con el 15% de anticipo.')).toBe(false);
  });

  it('legitimate operational confirm passes (no delay)', () => {
    expect(containsClosingDelay('Te escribo y luego te confirmo el resultado de la validación.')).toBe(false);
  });
});
