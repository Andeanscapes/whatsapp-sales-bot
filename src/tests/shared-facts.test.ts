import { afterEach, describe, expect, it } from 'vitest';
import { dynamicDataSchema } from '../services/dynamic-data-schema.js';
import { assembleSystemPrompt } from '../services/skills-prompt-assembly.js';
import { allSitesActivePayload, useAllSitesActive } from './helpers/all-sites-catalog.js';

// Catalog `sharedFacts` replaces the 2.5.1 wording hardcoded in the prompt cues (invariant 1).
// Without the field the prompt is unchanged; with it, every cue reads the catalog value.
const FACTS = {
  tripLength: 'escapada de dos días con noche en la montaña',
  arrival: 'llega por su cuenta al punto de encuentro del catálogo',
  dayOption: 'el plan de un día es una alternativa aparte',
  highlights: 'mina real, guías locales, noche en la montaña',
  siteOnlyTerms: ['finca', 'posada'],
  quoteValue: 'noche, comidas, mina guiada',
  safetyAnswer: 'el equipo revisa condiciones antes de salir',
};

type Payload = { experiences: Record<string, Record<string, unknown>> };

function withSharedFacts(facts: unknown): unknown {
  const payload = allSitesActivePayload() as Payload;
  for (const experience of Object.values(payload.experiences)) experience.sharedFacts = facts;
  return payload;
}

function runtime(input: Partial<Parameters<typeof assembleSystemPrompt>[0]>, payload?: unknown): string {
  const skills = useAllSitesActive(payload);
  return assembleSystemPrompt({ skills, lang: 'es', collectedFields: {}, ...input }).split('\nRUNTIME:').at(-1) ?? '';
}

const opener = { entryMarker: { code: 'C01', temperature: 'cold' as const }, entryOpeningTurn: true, adOpeningTurn: true };
const safety = { latestCustomerMessage: '¿Es seguro? Escuché de grupos armados' };
const quote = { collectedFields: { site: 'chivor', personas: 2 }, pendingPriceQuestion: true, entryMarker: { code: 'C01', temperature: 'cold' as const } };

describe('catalog sharedFacts', () => {
  afterEach(() => {
    useAllSitesActive();
  });

  it('without the field, the cues keep the 2.5.1 production wording', () => {
    const open = runtime(opener);
    expect(open).toContain('es un fin de semana (sábado a domingo) con noche allá');
    expect(open).toContain('llega al pueblo por su cuenta y desde ahí lo lleva el equipo');
    expect(open).toContain('El destino (Chivor o Coscuez) se pregunta después');
    expect(open).toContain('no nombres Chivor, Coscuez, hacienda ni hotel');
    expect(runtime(safety)).toContain('responde solo con esto: región tranquila;');
    expect(runtime(quote)).toContain('en palabras de cliente: noche allá, comidas, mina con guía, 4x4 del último tramo');
  });

  it('with the field, every cue reads the catalog and none keeps the fallback', () => {
    const payload = withSharedFacts(FACTS);
    const open = runtime(opener, payload);
    expect(open).toContain(`es un ${FACTS.tripLength}`);
    expect(open).toContain(`solo si no preguntó por transporte, ${FACTS.arrival};`);
    expect(open).toContain(`el plan es de ${FACTS.tripLength}; ${FACTS.dayOption}.`);
    expect(open).toContain(`comparten los destinos (${FACTS.highlights})`);
    expect(open).toContain('no nombres Chivor, Coscuez, finca ni posada');
    expect(runtime(safety, payload)).toContain(`responde solo con esto: ${FACTS.safetyAnswer}.`);
    expect(runtime(quote, payload)).toContain(`en palabras de cliente: ${FACTS.quoteValue})`);

    const all = [open, runtime(safety, payload), runtime(quote, payload)].join('\n');
    expect(all).not.toMatch(/sábado a domingo|llega al pueblo por su cuenta|región tranquila|4x4 del último tramo|hacienda ni hotel/);
  });

  it('a partial field overrides only what it sets', () => {
    const open = runtime(opener, withSharedFacts({ tripLength: FACTS.tripLength }));
    expect(open).toContain(`es un ${FACTS.tripLength}`);
    expect(open).toContain('llega al pueblo por su cuenta y desde ahí lo lleva el equipo');
  });

  // Coscuez CORE lists no 4x4; its quote used to promise "4x4 del último tramo" (a Chivor fact).
  it('the quote value line names the 4x4 only where every quoted plan lists one', () => {
    const coscuez = { ...quote, collectedFields: { site: 'coscuez', personas: 2 } };
    expect(runtime(quote)).toContain('mina con guía, 4x4 del último tramo)');
    expect(runtime(coscuez)).toContain('mina con guía, transporte local desde el pueblo)');
    expect(runtime(coscuez)).not.toContain('4x4 del último tramo');
  });

  it('a site quoteValue in the catalog wins over the shared one', () => {
    const payload = withSharedFacts(FACTS) as { experiences: Record<string, { sites: Record<string, Record<string, unknown>> }> };
    for (const experience of Object.values(payload.experiences)) experience.sites.coscuez.quoteValue = 'hotel rural, comidas, mina guiada';
    expect(runtime({ ...quote, collectedFields: { site: 'coscuez', personas: 2 } }, payload)).toContain('en palabras de cliente: hotel rural, comidas, mina guiada)');
    expect(runtime(quote, payload)).toContain(`en palabras de cliente: ${FACTS.quoteValue})`);
  });

  // An organic lead never saw an ad video: only ad leads get that reason.
  it('the destination-not-chosen line mentions the video only to ad leads', () => {
    expect(runtime(opener)).toContain('porque el video pudo ser de cualquiera de los dos');
    const organic = runtime({ entryOpeningTurn: true });
    expect(organic).toContain('DESTINO SIN ELEGIR');
    expect(organic).toContain('porque aún no eligió destino');
    expect(organic).not.toContain('video');
  });

  it('the schema is strict: unknown keys and empty values are rejected', () => {
    expect(dynamicDataSchema.safeParse(withSharedFacts(FACTS)).success).toBe(true);
    expect(dynamicDataSchema.safeParse(withSharedFacts({ tripLenght: 'x' })).success).toBe(false);
    expect(dynamicDataSchema.safeParse(withSharedFacts({ tripLength: '' })).success).toBe(false);
    expect(dynamicDataSchema.safeParse(withSharedFacts({ siteOnlyTerms: [] })).success).toBe(false);
  });
});
