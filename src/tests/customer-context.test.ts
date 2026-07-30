import { describe, expect, it } from 'vitest';
import { extractCustomerContext } from '../services/customer-context.js';

describe('extractCustomerContext', () => {
  it('retains explicit family, motorcycle, and month context', () => {
    expect(extractCustomerContext('Somos padre e hijo, viajamos en moto y pensamos ir en octubre.')).toMatchObject({
      date: 'octubre',
      transport: 'own_motorcycle',
      groupRelationship: 'padre e hijo',
    });
  });

  it('marks an unspecified transport request as ambiguous', () => {
    expect(extractCustomerContext('Necesitamos transporte para llegar a Chivor.')).toMatchObject({
      transport: 'ambiguous',
    });
  });

  it('captures explicitly stated child ages', () => {
    expect(extractCustomerContext('Vamos con un niño de 5 años.')).toMatchObject({ childAges: [5] });
  });
});
