import { beforeEach, describe, expect, it } from 'vitest';
import { assembleSystemPrompt } from '../services/skills-prompt-assembly.js';
import type { Skills } from '../services/skill-loader.js';
import { useAllSitesActive, usePausedCoscuez } from './helpers/all-sites-catalog.js';

// The 2.4.0 opener (owner export 2026-11-12: 76% replied vs 35% in 2.3.0) must survive every
// change: no price, no "desde", no plan menu, one group question. The live scenarios check the
// model's reply; this pins the cue that produces it, for one and two destinations on sale.
const ENTRIES = [
  { code: 'C01', temperature: 'cold' as const },
  { code: 'C02', temperature: 'cold' as const },
  { code: 'C03', temperature: 'cold' as const },
  { code: 'R01', temperature: 'retargeting' as const },
];

// 2.5.1 (owner 2026-11-16): only vehicle codes (car/bike) arrive with the site set by the engine
// (resolveSiteContext); C01/R01 run on videos from both regions and keep the destination open.
const VEHICLE_CODES = new Set(['C02', 'C03']);

function openerRuntime(skills: Skills, entryMarker: (typeof ENTRIES)[number], twoSites: boolean): string {
  const site = twoSites && VEHICLE_CODES.has(entryMarker.code) ? { site: 'chivor' } : {};
  const prompt = assembleSystemPrompt({
    skills, lang: 'es', entryMarker, entryOpeningTurn: true, adOpeningTurn: true, collectedFields: site,
  });
  return prompt.split('\nRUNTIME:').at(-1) ?? '';
}

describe.each([
  ['two destinations on sale', (): Skills => useAllSitesActive(), true],
  ['one destination on sale', (): Skills => usePausedCoscuez(), false],
])('first ad turn (%s)', (_label, load, twoSites) => {
  let skills: Skills;
  beforeEach(() => {
    skills = load();
  });

  it.each(ENTRIES)('$code asks the group and nothing else', entry => {
    const runtime = openerRuntime(skills, entry, twoSites);
    expect(runtime).toContain('APERTURA DE ANUNCIO: primer mensaje');
    expect(runtime).toContain('solo, en pareja o para un grupo');
    expect(runtime).toContain('UNA SOLA PREGUNTA');
    expect(runtime).toContain('Sin precios, sin $, sin "desde", sin "valor exacto", sin "te cuento el precio", sin menú de planes');
    expect(runtime).toContain('claridad del plan');
    expect(runtime).not.toMatch(/llegan en tu siguiente mensaje|el valor exacto llega/);
    expect(runtime).not.toMatch(/QUOTE LOCK|PRECIO PEDIDO SIN PLAN|OPCIONES DE PLAN|SITIO PENDIENTE/);
    // The vehicle angle reaches the opener whenever the site is known; a shared code with two
    // destinations open gets no site's segment (no hacienda/hotel for a video of either region).
    if (twoSites && !VEHICLE_CODES.has(entry.code)) {
      expect(runtime).not.toContain('SEGMENT_DETECTED');
      expect(runtime).toContain('DESTINO SIN ELEGIR');
    } else {
      expect(runtime).toContain(`SEGMENT_DETECTED: ${entry.code}`);
    }
  });
});
