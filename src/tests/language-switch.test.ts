import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { detectMessageLanguage } from '../services/language-service.js';
import { resolveLanguage, resolveTurnLanguage } from '../services/qualification-engine.js';
import { assembleSystemPrompt } from '../services/skills-prompt-assembly.js';
import { loadSkills } from '../services/skill-loader.js';

const PHONE = '573001110777';

describe('detectMessageLanguage', () => {
  it.each([
    ['Entre el basic y el core', 'es', true],
    ['Que costo tiene cada una?', 'es', true],
    ['Estamos planeando, queremos probar algo diferente', 'es', true],
    ['Hello! Can I get more info on this?', 'en', true],
    ["Hi! I'd like the PRIME emerald mine trip (2D/1N) in Chivor. Dates?", 'en', true],
    ['Bonjour, combien coûte le voyage pour deux personnes ?', 'fr', true],
    ['Obrigado, quanto custa para dois?', 'pt', true],
    ['Ciao, quanto costa per due persone?', 'it', true],
    ['Hallo, wie viel kostet das für zwei Personen?', 'de', true],
    ['En pareja!', 'es', false],
    ['Hi', 'en', false],
  ])('"%s" -> %s (strong=%s)', (text, lang, strong) => {
    expect(detectMessageLanguage(text)).toEqual({ lang, strong });
  });

  it.each(['ok', 'sí', '2', '🙌', 'Core', 'Prime', 'mañana', 'https://vt.tiktok.com/EXAMPLE123/'])('bare answer "%s" carries no language', text => {
    expect(detectMessageLanguage(text)).toBeNull();
  });

  // Spanish words that other languages share must never read as another language.
  it.each([
    'les cuento, vamos tres',
    'venimos del sur, vamos tres',
    'Sur de Bogotá, tres adultos',
    'somos tres',
    'Siete personas, come bien?',
  ])('"%s" is never strong in another language', text => {
    const detected = detectMessageLanguage(text);
    expect(detected === null || detected.lang === 'es').toBe(true);
  });
});

describe('resolveTurnLanguage — mid-chat switch', () => {
  let repos: Repositories;
  let clock = 0;

  /** Runs one customer turn the way the engine does, then records both sides of it. */
  function turn(text: string) {
    const result = resolveTurnLanguage(repos, PHONE, text);
    repos.conversation.upsert(PHONE, { language: result.language, reply_language: result.replyLanguage });
    const at = (): string => new Date(Date.UTC(2026, 10, 6, 0, 0, clock++)).toISOString();
    repos.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: text, created_at: at() });
    repos.message.addMessage({ customer_phone: PHONE, direction: 'outbound', message_type: 'text', body: 'bot reply', created_at: at() });
    return result;
  }

  beforeEach(() => {
    loadSkills();
    const db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    clock = 0;
  });

  // Export 2026-11-09, export case A: bot answered every turn in English after
  // the customer had switched to Spanish.
  it('follows the export conversation: English, then Spanish from "Entre el basic y el core"', () => {
    expect(turn('Hello! Can I get more info on this?')).toMatchObject({ replyLanguage: 'en', switched: false });
    expect(turn('En pareja!')).toMatchObject({ replyLanguage: 'en', switched: false });
    expect(turn('Entre el basic y el core')).toMatchObject({ replyLanguage: 'es', switched: true, language: 'es' });
    expect(turn('Estamos planeando, queremos probar algo diferente')).toMatchObject({ replyLanguage: 'es', switched: false });
    expect(turn('Que costo tiene cada una?')).toMatchObject({ replyLanguage: 'es', switched: false });
  });

  it('switches back to English on a clear English message', () => {
    turn('Hola, quiero info del tour');
    expect(turn('Hi, what is included in CORE? Can I book for two?')).toMatchObject({ replyLanguage: 'en', switched: true });
  });

  it('a single stray word does not flip the chat, but two in a row do', () => {
    turn('Hola, quiero info');
    expect(turn('Hi')).toMatchObject({ replyLanguage: 'es', switched: false });
    expect(turn('thanks')).toMatchObject({ replyLanguage: 'en', switched: true });
  });

  it.each(['ok', 'sí', '2', '🙌', 'Core'])('bare answer "%s" keeps the stored language', text => {
    turn('Hello! Can I get more info on this?');
    expect(turn(text)).toMatchObject({ replyLanguage: 'en', switched: false });
  });

  it('an explicit request switches at once', () => {
    turn('Hola, quiero info del tour');
    expect(turn('please reply in English')).toMatchObject({ replyLanguage: 'en', switched: true });
  });

  it('a new English ad opener from a stored Spanish lead switches (P410 case)', () => {
    turn('Hola, quiero info del tour');
    expect(turn("P410 Hi! I'd like the PRIME emerald mine trip (2D/1N) in Chivor. Dates?"))
      .toMatchObject({ replyLanguage: 'en', switched: true });
  });

  it('French is detected, replies in French, and copy falls back to English', () => {
    expect(turn('Bonjour, combien coûte le voyage pour deux personnes ?'))
      .toMatchObject({ replyLanguage: 'fr', language: 'en', switched: false });
    expect(turn('merci')).toMatchObject({ replyLanguage: 'fr', switched: false });
    expect(turn('Entre el basic y el core')).toMatchObject({ replyLanguage: 'es', language: 'es', switched: true });
  });

  it('a Spanish lead whose first message is a TikTok link stays in Spanish', () => {
    expect(turn('https://vt.tiktok.com/EXAMPLE123/')).toMatchObject({ replyLanguage: 'es' });
    expect(turn('Hola, me puedes dar más información')).toMatchObject({ replyLanguage: 'es', switched: false });
  });

  it.each(['les cuento, vamos tres', 'venimos del sur, vamos tres', 'somos tres'])('a stored es chat stays es on "%s"', text => {
    turn('Hola, quiero info del tour');
    expect(turn(text)).toMatchObject({ replyLanguage: 'es', switched: false });
  });

  it('a repeated single word counts as two in a row', () => {
    turn('Hola, quiero info');
    expect(turn('Hi')).toMatchObject({ replyLanguage: 'es' });
    expect(turn('Hi')).toMatchObject({ replyLanguage: 'en', switched: true });
  });

  it('a Spanish chat quoting one English phrase does not switch', () => {
    turn('Hola, quiero info del tour');
    expect(turn('Hola, el CORE is available?')).toMatchObject({ replyLanguage: 'es', switched: false });
  });

  it('a French lead keeps English fixed copy (language) while replying in French', () => {
    const french = turn('Bonjour, combien coûte le voyage pour deux personnes ?');
    expect(french).toMatchObject({ replyLanguage: 'fr', language: 'en' });
    expect(resolveLanguage(repos, PHONE, 'stop')).toBe('en');
  });

  it('keeps the stored reply language for a turn with no language evidence', () => {
    turn('Bonjour, combien coûte le voyage pour deux personnes ?');
    expect(turn('2')).toMatchObject({ replyLanguage: 'fr', switched: false });
  });
});

describe('assembleSystemPrompt — reply language cues', () => {
  it('names the reply language and the switch when the customer changed language', () => {
    const skills = loadSkills();
    const prompt = assembleSystemPrompt({
      skills, lang: 'en', replyLanguage: 'fr', languageSwitchedThisTurn: true,
    });
    expect(prompt).toContain('Language: fr. Reply in français on every turn');
    expect(prompt).toContain('IDIOMA CAMBIADO: el cliente pasó a escribir en français');
  });

  it('gives no switch cue on an ordinary turn', () => {
    const prompt = assembleSystemPrompt({ skills: loadSkills(), lang: 'es' });
    expect(prompt).toContain('Language: es. Reply in español on every turn');
    expect(prompt).not.toContain('IDIOMA CAMBIADO');
  });
});
