import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { extractBookingFields, isCorrectionMessage, contextAwareExtract } from '../services/qualification-engine.js';

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
