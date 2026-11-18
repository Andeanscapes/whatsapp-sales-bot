import { describe, expect, it } from 'vitest';
import { assembleSystemPrompt } from '../services/skills-prompt-assembly.js';
import { useAllSitesActive } from './helpers/all-sites-catalog.js';

// 2.5.1: a security question gets only the catalog wording (live 2026-11-16, EN: the bot
// invented "military bases" and named the valley). The cue appears only for such questions.
function runtimeFor(latestCustomerMessage: string): string {
  const prompt = assembleSystemPrompt({
    skills: useAllSitesActive(), lang: 'es', collectedFields: {}, latestCustomerMessage,
  });
  return prompt.split('\nRUNTIME:').at(-1) ?? '';
}

describe('security question cue', () => {
  it('adds the catalog-only security wording for a security question', () => {
    const runtime = runtimeFor('¿Es seguro? Escuché de grupos armados en la zona');
    expect(runtime).toContain('SEGURIDAD: si pregunta por seguridad');
    expect(runtime).toContain('región tranquila');
    expect(runtime).toContain('No menciones bases militares');
  });

  it('is not added for an unrelated message', () => {
    expect(runtimeFor('Quiero reservar para dos')).not.toContain('SEGURIDAD:');
  });
});
