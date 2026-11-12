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

function openerRuntime(skills: Skills, entryMarker: (typeof ENTRIES)[number]): string {
  const prompt = assembleSystemPrompt({
    skills, lang: 'es', entryMarker, entryOpeningTurn: true, adOpeningTurn: true, collectedFields: {},
  });
  return prompt.split('\nRUNTIME:').at(-1) ?? '';
}

describe.each([
  ['two destinations on sale', (): Skills => useAllSitesActive()],
  ['one destination on sale', (): Skills => usePausedCoscuez()],
])('first ad turn (%s)', (_label, load) => {
  let skills: Skills;
  beforeEach(() => {
    skills = load();
  });

  it.each(ENTRIES)('$code asks the group and nothing else', entry => {
    const runtime = openerRuntime(skills, entry);
    expect(runtime).toContain('APERTURA DE ANUNCIO: primer mensaje');
    expect(runtime).toContain('solo, en pareja o para un grupo');
    expect(runtime).toContain('UNA SOLA PREGUNTA');
    expect(runtime).toContain('Sin precios, sin $, sin "desde", sin menú de planes');
    expect(runtime).not.toMatch(/QUOTE LOCK|PRECIO PEDIDO SIN PLAN|OPCIONES DE PLAN|SITIO PENDIENTE/);
    // The ad angle (route, moto, kids) reaches the opener in both catalog states.
    expect(runtime).toContain(`SEGMENT_DETECTED: ${entry.code}`);
  });
});
