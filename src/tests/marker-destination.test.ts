import { describe, expect, it } from 'vitest';
import { assembleSystemPrompt } from '../services/skills-prompt-assembly.js';
import { resolveExperience } from '../services/product-registry.js';
import { resolveSiteContext } from '../services/qualification-engine.js';
import { useAllSitesActive } from './helpers/all-sites-catalog.js';

// 2.5.1 (owner 2026-11-16): only a vehicle ad (car/4x4 or motorbike: codes the catalog tags with the
// "car"/"bike" media types) implies a destination. Other codes (C01, R01, kids) run on videos from
// both regions, so the lead chooses. A site the lead names always wins.
describe('entry marker and destination (two sites on sale)', () => {
  const skills = useAllSitesActive();
  const exp = resolveExperience(skills);

  it.each(['C02 ¡Hola! carro', 'C03 moto', 'H02 hola', 'H03 hola', 'R02 hola', 'R03 hola'])(
    'vehicle code "%s" resolves to chivor',
    message => {
      expect(resolveSiteContext(exp, null, [message])).toBe('chivor');
    },
  );

  it.each(['C01 ¡Hola!', 'R01 Tanto por una mina', 'H01 hola', 'C04 niños', 'hola, vi un video de las minas'])(
    'shared or missing code "%s" leaves the destination open',
    message => {
      expect(resolveSiteContext(exp, null, [message])).toBeUndefined();
    },
  );

  it('a named site beats a vehicle code', () => {
    expect(resolveSiteContext(exp, null, ['C02 ¡Hola!', 'mejor en Coscuez'])).toBe('coscuez');
  });

  it('a stored plan keeps its own site', () => {
    const coscuezPlan = exp.plans.find(plan => plan.siteId === 'coscuez')?.id;
    expect(coscuezPlan).toBeDefined();
    expect(resolveSiteContext(exp, coscuezPlan, ['C02 ¡Hola!'])).toBe('coscuez');
  });

  it('a vehicle lead with the site set gets no destination question on the opening turn', () => {
    const runtime = assembleSystemPrompt({
      skills, lang: 'es', entryMarker: { code: 'C02', temperature: 'cold' },
      entryOpeningTurn: true, adOpeningTurn: true, collectedFields: { site: 'chivor' },
    }).split('\nRUNTIME:').at(-1) ?? '';
    expect(runtime).not.toContain('SITIO PENDIENTE');
    expect(runtime).not.toContain('DESTINO SIN ELEGIR');
    expect(runtime).toContain('claridad del plan');
  });

  it('a C01 lead gets a neutral opener with no site segment', () => {
    const runtime = assembleSystemPrompt({
      skills, lang: 'es', entryMarker: { code: 'C01', temperature: 'cold' },
      entryOpeningTurn: true, adOpeningTurn: true, collectedFields: {},
    }).split('\nRUNTIME:').at(-1) ?? '';
    expect(runtime).toContain('DESTINO SIN ELEGIR');
    expect(runtime).not.toContain('SEGMENT_DETECTED');
  });
});
