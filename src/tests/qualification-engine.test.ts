import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { extractBookingFields, isCorrectionMessage, contextAwareExtract, detectPlan, resolveLanguage } from '../services/qualification-engine.js';
import { detectExplicitLanguageSwitch } from '../services/language-service.js';

describe('extractBookingFields — people detection', () => {
  beforeAll(() => {
    loadSkills();
  });

  it.each([
    'mi mamá y yo',
    'mi mama y yo',
    'mi madre y yo',
    'mi made y yo',
  ])('detects 2 people from "%s"', (text) => {
    expect(extractBookingFields(text).collected_people).toBe(2);
  });

  it.each([
    'Somos tree personas yo y mis dos amantes',
    'somos tree',
    'tree personas',
    'Somos tres',
    'somos tres personas',
    'somos 3',
  ])('detects 3 people from "%s"', (text) => {
    expect(extractBookingFields(text).collected_people).toBe(3);
  });
});

describe('isCorrectionMessage', () => {
  it.each([
    'Ya te dine que somos tres',
    'ya te dige que somos tres',
    'ya te dije',
    'ya te mencioné',
    'ya lo he dicho',
  ])('detects correction from "%s"', (text) => {
    expect(isCorrectionMessage(text)).toBe(true);
  });

  it.each([
    'Hola como estas',
    'cuanto cuesta',
    'somos 3 personas',
  ])('does not flag "%s" as correction', (text) => {
    expect(isCorrectionMessage(text)).toBe(false);
  });
});

describe('contextAwareExtract — people reply parsing', () => {
  let repos: Repositories;
  let db: Database.Database;
  const PHONE = '573001119999';

  beforeEach(() => {
    loadSkills();
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
  });

  function seedLastQuestion(body: string): void {
    repos.message.addMessage({
      customer_phone: PHONE,
      direction: 'outbound',
      message_type: 'text',
      body,
      created_at: new Date().toISOString(),
    });
  }

  it.each([
    { input: '3', expected: 3 },
    { input: 'Pues podria ser para 3', expected: 3 },
    { input: 'Ya dije Que 3', expected: 3 },
    { input: 'Ya dije Que tres', expected: 3 },
    { input: 'tres personas', expected: 3 },
    { input: 'somos veinte', expected: 20 },
    { input: 'somos 8 personas', expected: 8 },
    { input: 'para 15', expected: 15 },
    { input: 'para el 20 somos 3', expected: 3 },
  ])('captures $expected from "$input" when bot asked people', ({ input, expected }) => {
    seedLastQuestion('Perfecto! ¿Cuantas personas serian?');
    const result = contextAwareExtract(input, repos, PHONE, {});
    expect(result.collected_people).toBe(expected);
  });

  it('does not capture numbers when last question was not the people-ask', () => {
    seedLastQuestion('¿Para que fecha lo tienen pensado?');
    const result = contextAwareExtract('llegamos el 3 de enero', repos, PHONE, {});
    expect(result.collected_people).toBeUndefined();
  });

  it('does not capture numbers when no relevant question was asked', () => {
    const result = contextAwareExtract('somos 5', repos, PHONE, {});
    expect(result.collected_people).toBeUndefined();
  });

  it('ignores numbers outside 1-20 range', () => {
    seedLastQuestion('¿Cuantas personas serian?');
    const result = contextAwareExtract('somos 50 personas', repos, PHONE, {});
    expect(result.collected_people).toBeUndefined();
  });
});

describe('detectPlan — ordinal / duration choice', () => {
  beforeAll(() => {
    loadSkills();
  });

  it.each([
    'Si el primero',
    'el de 2',
    'el de dos',
    'el corto',
    'plan de 2 dias',
  ])('resolves "%s" to 2d1n_mining', (text) => {
    expect(detectPlan(text)).toBe('2d1n_mining');
  });

  it.each([
    'el segundo',
    'el de 3',
    'el de tres',
    'el largo',
    'plan de 3 dias',
  ])('resolves "%s" to 3d2n_rural', (text) => {
    expect(detectPlan(text)).toBe('3d2n_rural');
  });

  it('does not treat "la del primero" as a plan (date-list phrasing)', () => {
    expect(detectPlan('la del primero esta bien')).toBeNull();
  });
});

describe('detectExplicitLanguageSwitch', () => {
  beforeAll(() => {
    loadSkills();
  });

  it('returns en for "speak english"', () => {
    expect(detectExplicitLanguageSwitch('speak english')).toBe('en');
  });

  it('returns en for "reply in english"', () => {
    expect(detectExplicitLanguageSwitch('reply in english')).toBe('en');
  });

  it('returns en for "can you respond in english please"', () => {
    expect(detectExplicitLanguageSwitch('can you respond in english please')).toBe('en');
  });

  it('returns en for "hablame en ingles"', () => {
    expect(detectExplicitLanguageSwitch('hablame en ingles')).toBe('en');
  });

  it('returns es for "habla español"', () => {
    expect(detectExplicitLanguageSwitch('habla español')).toBe('es');
  });

  it('returns es for "responde en español por favor"', () => {
    expect(detectExplicitLanguageSwitch('responde en español por favor')).toBe('es');
  });

  it('returns es for "puedes responder en español"', () => {
    expect(detectExplicitLanguageSwitch('puedes responder en español')).toBe('es');
  });

  it('returns null for "Me regalas el Nequi para reserve" (no explicit switch)', () => {
    expect(detectExplicitLanguageSwitch('Me regalas el Nequi para reserve')).toBeNull();
  });

  it('returns null for plain "Hola"', () => {
    expect(detectExplicitLanguageSwitch('Hola')).toBeNull();
  });

  it('returns null for "cuanto vale el tour"', () => {
    expect(detectExplicitLanguageSwitch('cuanto vale el tour')).toBeNull();
  });
});

describe('resolveLanguage — stability', () => {
  let repos: Repositories;
  let db: Database.Database;
  const PHONE = '573001110001';

  beforeEach(() => {
    loadSkills();
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
  });

  it('keeps stored es despite English marker in message', () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    const lang = resolveLanguage(repos, PHONE, 'Me regalas el Nequi para reserve');
    expect(lang).toBe('es');
  });

  it('keeps stored en despite Spanish word in message', () => {
    repos.conversation.upsert(PHONE, { language: 'en' });
    const lang = resolveLanguage(repos, PHONE, 'Hola como estas');
    expect(lang).toBe('en');
  });

  it('switches to en on explicit request', () => {
    repos.conversation.upsert(PHONE, { language: 'es' });
    const lang = resolveLanguage(repos, PHONE, 'puedes responder en ingles?');
    expect(lang).toBe('en');
  });

  it('switches to es on explicit request', () => {
    repos.conversation.upsert(PHONE, { language: 'en' });
    const lang = resolveLanguage(repos, PHONE, 'responde en español por favor');
    expect(lang).toBe('es');
  });

  it('detects en for new conversation', () => {
    const lang = resolveLanguage(repos, PHONE, 'hello, how much is the tour?');
    expect(lang).toBe('en');
  });

  it('detects es for new conversation', () => {
    const lang = resolveLanguage(repos, PHONE, 'Hola, cuanto vale?');
    expect(lang).toBe('es');
  });

  it('defaults to es for unknown new conversation', () => {
    const lang = resolveLanguage(repos, PHONE, '123');
    expect(lang).toBe('es');
  });
});
