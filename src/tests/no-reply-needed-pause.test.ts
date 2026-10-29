import { describe, it, expect } from 'vitest';
import { isNoReplyNeededPause } from '../services/reply-guard.js';

describe('isNoReplyNeededPause', () => {
  it.each([
    'Listo. Gracias. Aún estamos discutiendo.',
    'Lo hablo con mi pareja y le aviso.',
    'Lo voy a consultar con mi esposa',
    'ok gracias',
    'Gracias, todavía lo estamos pensando',
    'te aviso',
    'Listo, le aviso luego',
    'thanks, still thinking',
  ])('treats courtesy/deliberation as needing no answer: "%s"', text => {
    expect(isNoReplyNeededPause(text)).toBe(true);
  });

  it.each([
    'Listo, gracias. En la mina tbm puede entrar?',
    'Hablo con mi pareja, el perro puede ir',
    'lo hablo con mi pareja pero me interesa noviembre',
    'Si, creo mejor con solo 1 entonces. Hablo con mi pareja y le aviso.',
    'Estamos viendo noviembre',
    'Aún estamos discutiendo la fecha',
    'Listo, cómo es el pago',
    'Lo hablo con mi pareja, cuanto es el anticipo',
    'Gracias, ya les transferí el anticipo',
    'Listo, quiero reservar',
    'Es pet friendly',
    'Hola',
    '',
  ])('keeps a turn with something to answer: "%s"', text => {
    expect(isNoReplyNeededPause(text)).toBe(false);
  });
});
