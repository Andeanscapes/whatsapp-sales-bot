import { describe, expect, it } from 'vitest';
import { isPlanBrochureRequest } from '../services/reply-guard.js';

describe('isPlanBrochureRequest', () => {
  it.each([
    'tienes brochure',
    'BROCHURE',
    'tienes brochur',
    'tienes brosure de la mas completa ?',
    'dame broshure',
    'quiero brouchure',
    'envia bruschure',
    'mandame los brochures',
    'Dame El FOLLETO',
    'dame foleto',
    'envía foyeto',
    'quiero foletos',
    'la ficha del plan',
    'tienes brochure 📄',
  ])('matches %s', text => {
    expect(isPlanBrochureRequest(text)).toBe(true);
  });

  it.each([
    'reciben tarjeta?',
    'se puede pagar con tarjeta de credito',
    'quiero la carta',
    'gracias bro',
    'bre',
    'una brasa',
    'quiero brocheta',
    'cual es la fecha',
    'quiero el PRIME',
    'cuanto vale',
  ])('does not match %s', text => {
    expect(isPlanBrochureRequest(text)).toBe(false);
  });
});
