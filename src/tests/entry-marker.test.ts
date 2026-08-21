import { describe, expect, it } from 'vitest';
import { findEntryMarker, parseEntryMarker } from '../services/entry-marker.js';
import { containsInternalEntryMarker, isReEngagementMessage } from '../services/reply-guard.js';

describe('entry markers', () => {
  it('parses the full marker and maps its temperature', () => {
    expect(parseEntryMarker('R01 - Hola, quiero volver')).toEqual({ code: 'R01', temperature: 'retargeting' });
    expect(parseEntryMarker('H01 quiero información')).toEqual({ code: 'H01', temperature: 'funnel' });
    expect(parseEntryMarker(' r01 - Hola')).toBeNull();
    expect(parseEntryMarker('r01 - Hola')).toBeNull();
    expect(parseEntryMarker('Hola R01')).toBeNull();
    expect(parseEntryMarker('C1 acceso')).toBeNull();
    expect(parseEntryMarker('C001 acceso')).toBeNull();
  });

  it('finds a marker in the first two inbound messages only', () => {
    expect(findEntryMarker('Hola', ['C02 - Hola'])).toEqual({ code: 'C02', temperature: 'cold' });
    expect(findEntryMarker('Hola', ['Hola', '¿Cuánto cuesta?'])).toBeNull();
  });

  it('blocks marker leakage and does not classify a cold marker as re-engagement', () => {
    expect(containsInternalEntryMarker('Veo que vienes de C01')).toBe(true);
    expect(containsInternalEntryMarker('La ruta usa el acceso C4')).toBe(false);
    expect(containsInternalEntryMarker('El motor tiene filtro H1')).toBe(false);
    expect(containsInternalEntryMarker('Tu habitación es H101.')).toBe(false);
    expect(containsInternalEntryMarker('Usa la ruta R01: acceso principal')).toBe(false);
    expect(isReEngagementMessage('C01 - Hola', 'cold')).toBe(false);
    expect(isReEngagementMessage('Hola')).toBe(true);
  });
});
