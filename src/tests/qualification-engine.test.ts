import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { extractBookingFields, isAmbiguousPartyComparison, isCorrectionMessage, contextAwareExtract, detectPlan, isExplicitDateDeferral, isUncertainDateAnswer, isDateAskQuestion, isQualificationComplete, resolveLanguage } from '../services/qualification-engine.js';
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

  it.each([
    'Es para la familia 4 adultos',
    'Seríamos 4 adultas',
    'We are 4 adults',
  ])('detects four adults from "%s"', (text) => {
    expect(extractBookingFields(text).collected_people).toBe(4);
  });

  it.each([
    'Somos 4 adultos y 2 niños',
    'Somos 2 niños y 4 adultos',
    'We are 4 adults and 2 children',
    'We are 2 children and 4 adults',
    'Somos 4 adultos y un niño',
    'Somos 4 adultos y dos niñas',
    'We are 4 adults and one child',
  ])('does not guess a total for mixed adult and child counts from "%s"', (text) => {
    expect(extractBookingFields(text).collected_people).toBeUndefined();
  });

  it.each([
    'solo o pareja',
    'una persona o pareja',
    'solo o quizás pareja',
    'Me das los precios para una persona o para pareja?',
  ])('does not settle an ambiguous party comparison from "%s"', (text) => {
    expect(isAmbiguousPartyComparison(text)).toBe(true);
    expect(extractBookingFields(text).collected_people).toBeUndefined();
  });

  it.each([
    'solo me interesa la experiencia en pareja',
    'solo quiero info para pareja',
  ])('does not treat non-comparison solo+pareja as ambiguous: "%s"', (text) => {
    expect(isAmbiguousPartyComparison(text)).toBe(false);
  });
});

describe('isQualificationComplete', () => {
  it('does not treat a deferred date as confirmed', () => {
    expect(isQualificationComplete({
      nombre: 'Laura', plan: '2d1n_mining', personas: 2, fecha: 'tentative_unknown', transporte: 'own', mascota: null,
    })).toBe(false);
  });
});

describe('isExplicitDateDeferral', () => {
  it.each([
    'Ya te dije que no se la fecha',
    'Todavia no tenemos fecha',
    'We do not have a date yet',
    // production history 2026-07-26
    'No tengo fecha',
    'No tengo una fecha',
    'No hay fecha tentativa',
    'No sin fecha',
    'No ninguna fecha',
    'No tengo fecja',
    'Pero no tengo fecha exacta',
    'No tengo fecha en mente',
    'Aún no tengo fechas, quisiera que me contaras un poco cómo es la experiencia',
    'no aún no tengo fecha',
    'Ideal un festivo pero aun no dispongo de fecha',
    'Suena increíble, en este momento no tengo una fecha estimada, pero tampoco planeo que sea muy cercano',
    'Sería para el mes de agosto por lo cual no hay ninguna fecha establecida',
    'Diferente fecha no importa fecha tentativa dime qué fechas tienes disponibles',
    'Aún no tengo fecha tentativa, que tan probable es encontrar las esmeraldas?',
  ])('detects "%s"', (text) => {
    expect(isExplicitDateDeferral(text)).toBe(true);
  });

  it.each([
    'todavía no',
    'no',
    'cuanto cuesta',
    'Por el momento no tengo el presupuesto',
    '31 julio',
    'Para octubre el 15',
    'Opciones disponibles, la verdad no tengo afán ya que es un plan a futuro',
  ])('does not false-positive on "%s"', (text) => {
    expect(isExplicitDateDeferral(text)).toBe(false);
  });
});

describe('isUncertainDateAnswer', () => {
  it.each([
    'no lo se',
    'todavía no',
    'not sure',
    'Ya te dije que no se la fecha',
    'no',
    'No.',
    'No,',
    'ninguna',
    'aun no',
    'No aún',
    'No todavia',
    'no todavía',
    'O todavia',
    'No realmente',
    'Prefiero ver las opciones disponibles',
    'Quiero revisar opciones',
    'Revisando opciones',
    'Opciones',
    'Q opciones tienes',
    'Si muestra las opciones por favor',
    'No , como te comentaba quisiera saber que fechas tienen disponibles',
    'Me muestras fechas por favor',
    'Solo quiero la información',
    'por el momento no',
    'Opciones disponibles, la verdad no tengo afán ya que es un plan a futuro',
  ])('detects "%s"', (text) => {
    expect(isUncertainDateAnswer(text)).toBe(true);
  });

  it('strict deferral does not fire on bare uncertainty without date context', () => {
    expect(isExplicitDateDeferral('todavía no')).toBe(false);
    expect(isExplicitDateDeferral('no')).toBe(false);
  });

  it('does not treat budget soft-no as date uncertainty', () => {
    expect(isUncertainDateAnswer('Por el momento no tengo el presupuesto')).toBe(false);
  });
});

describe('isDateAskQuestion', () => {
  it.each([
    '¿Tienes alguna fecha tentativa o todavía estás explorando opciones?',
    'Genial. ¿Para que fecha lo tienen pensado?',
    'Do you have a date in mind?',
    '¿Tienen alguna fecha en mente o quieren revisar opciones disponibles?',
    '¿Tienen fecha tentativa o prefieren que les muestre las opciones?',
  ])('detects date ask in "%s"', (text) => {
    expect(isDateAskQuestion(text)).toBe(true);
  });

  it('does not flag non-date questions', () => {
    expect(isDateAskQuestion('¿Cuantas personas serian?')).toBe(false);
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

  it('captures an explicit date deferral without relying on the previous question', () => {
    const result = contextAwareExtract('Ya te dije que no se la fecha', repos, PHONE, {});
    expect(result._date_deferred).toBe(true);
  });

  it('captures bare no as date deferral only after a date ask', () => {
    seedLastQuestion('¿Tienes alguna fecha tentativa o todavía estás explorando opciones?');
    repos.conversation.setDateAsked(PHONE);
    const result = contextAwareExtract('no', repos, PHONE, {});
    expect(result._date_deferred).toBe(true);
  });

  it('captures O todavia typo as deferral when date was asked', () => {
    seedLastQuestion('¿Tienen alguna fecha tentativa en mente o prefieren que les muestre las opciones disponibles?');
    repos.conversation.setDateAsked(PHONE);
    const result = contextAwareExtract('O todavia', repos, PHONE, {});
    expect(result._date_deferred).toBe(true);
  });

  it('does not treat rejection of an options offer as another date deferral', () => {
    seedLastQuestion('¿Quieres que te muestre las fechas disponibles?');
    const result = contextAwareExtract('no', repos, PHONE, {});
    expect(result._date_deferred).toBeUndefined();
  });

  it('lets explicit date uncertainty override a month mention', () => {
    const result = contextAwareExtract(
      'Sería para el mes de agosto por lo cual no hay ninguna fecha establecida',
      repos,
      PHONE,
      {},
    );
    expect(result._date_deferred).toBe(true);
    expect(result.collected_date).toBeUndefined();
  });

  it('keeps a concrete date when the customer also says the date is flexible', () => {
    const message = 'Tengo fecha flexible, podría ser el 20 de agosto';
    const result = contextAwareExtract(message, repos, PHONE, extractBookingFields(message));

    expect(result.collected_date).toMatch(/20 de agosto/i);
    expect(result._date_deferred).toBeUndefined();
  });

  it('preserves an explicit year in a concrete date', () => {
    const result = extractBookingFields('Podría ser el 14 de noviembre de 2027');
    expect(result.collected_date).toBe('14 de noviembre de 2027');
  });

  it('does not treat bare no as date when last question was people', () => {
    seedLastQuestion('Perfecto! ¿Cuantas personas serian?');
    const result = contextAwareExtract('no', repos, PHONE, {});
    expect(result._date_deferred).toBeUndefined();
    expect(result.collected_date).toBeUndefined();
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
