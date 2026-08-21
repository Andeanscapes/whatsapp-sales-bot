import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadSkills } from '../services/skill-loader.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { extractBookingFields, isAmbiguousPartyComparison, isCorrectionMessage, contextAwareExtract, detectPlan, isExplicitDateDeferral, isUncertainDateAnswer, isDateAskQuestion, isQualificationComplete, resolveLanguage, getLastAssistantQuestion, reconstructFromHistory } from '../services/qualification-engine.js';
import { detectExplicitLanguageSwitch } from '../services/language-service.js';
import { getActiveExperience } from '../services/product-registry.js';

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
    { text: 'Somos 4 adultos y 2 niños', adults: 4, children: 2, total: 6 },
    { text: 'Somos 2 niños y 4 adultos', adults: 4, children: 2, total: 6 },
    { text: 'We are 4 adults and 2 children', adults: 4, children: 2, total: 6 },
    { text: 'We are 2 children and 4 adults', adults: 4, children: 2, total: 6 },
    { text: 'Somos 4 adultos y un niño', adults: 4, children: 1, total: 5 },
    { text: 'Somos 4 adultos y dos niñas', adults: 4, children: 2, total: 6 },
    { text: 'We are 4 adults and one child', adults: 4, children: 1, total: 5 },
  ])('derives adult/child breakdown and total headcount from "$text"', ({ text, adults, children, total }) => {
    const fields = extractBookingFields(text);
    expect(fields.collected_adults).toBe(adults);
    expect(fields.collected_children).toBe(children);
    expect(fields.collected_people).toBe(total);
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

describe('extractBookingFields — name blacklist regressions (2026-08-02 history)', () => {
  it.each([
    'Precios',
    'Que fechas',
    'Cuánto vale',
    'Opciones',
  ])('does not store "%s" as a name', (text) => {
    expect(extractBookingFields(text).collected_name).toBeUndefined();
  });

  it('does not store an origin declaration as a name', () => {
    expect(extractBookingFields('Soy de Bogotá').collected_name).toBeUndefined();
    expect(extractBookingFields('I am from London').collected_name).toBeUndefined();
    expect(extractBookingFields('I am in Bogota').collected_name).toBeUndefined();
  });

  it.each([
    'I am interested in the tour',
    'I am planning a trip',
    'I am ready to book',
    'Soy una persona interesada',
    'Soy turista buscando fechas',
    'Soy viajero interesado',
  ])('does not store ordinary prose from "%s" as a name', (text) => {
    expect(extractBookingFields(text).collected_name).toBeUndefined();
  });

  it.each([
    ['soy carlos', 'Carlos'],
    ['i am john', 'John'],
  ])('stores lowercase one-word declaration "%s"', (text, expected) => {
    expect(extractBookingFields(text).collected_name).toBe(expected);
  });
});

describe('extractBookingFields — transport/pet/lodging polarity', () => {
  it('does not classify an explicit negation as own transport', () => {
    expect(extractBookingFields('No cuento con transporte propio').collected_transport_need).toBeUndefined();
  });

  it('does not classify "en propio no" as own transport', () => {
    expect(extractBookingFields('En propio no').collected_transport_need).toBeUndefined();
  });

  it('still captures public bus when own transport is negated', () => {
    expect(extractBookingFields('No tengo carro, voy en bus').collected_transport_need).toBe('public_bus');
  });

  it('still captures from_bogota when own vehicle is negated', () => {
    expect(extractBookingFields('no cuento con vehiculo, me recogen desde Bogota').collected_transport_need).toBe('from_bogota');
  });

  it('records a negated pet mention as "no"', () => {
    expect(extractBookingFields('No llevo mascota').collected_pet).toBe('no');
  });

  it('still records an affirmative pet mention as "yes"', () => {
    expect(extractBookingFields('Vamos con mi perro').collected_pet).toBe('yes');
  });

  it('records a negated lodging mention as "no"', () => {
    expect(extractBookingFields('No necesito hotel').collected_lodging_need).toBe('no');
  });

  it('does not persist uncertain pet or lodging answers', () => {
    expect(extractBookingFields('No sé si necesito hotel').collected_lodging_need).toBeUndefined();
    expect(extractBookingFields('No sé si puedo llevar mascota').collected_pet).toBeUndefined();
    expect(extractBookingFields('Hotel, no sé todavía').collected_lodging_need).toBeUndefined();
    expect(extractBookingFields('Mascota, no estoy segura').collected_pet).toBeUndefined();
  });

  it('does not persist pet or lodging questions as affirmative facts', () => {
    expect(extractBookingFields('¿Necesito hotel?').collected_lodging_need).toBeUndefined();
    expect(extractBookingFields('¿Puedo llevar mascota?').collected_pet).toBeUndefined();
  });

  it('lets an affirmative pet mention override a different negated animal', () => {
    expect(extractBookingFields('No tengo perro, llevo gato').collected_pet).toBe('yes');
    expect(extractBookingFields('No sé, pero llevamos un gato').collected_pet).toBe('yes');
  });
});

describe('extractBookingFields — travel origin and child age', () => {
  it('captures a self-declared origin city', () => {
    expect(extractBookingFields('Pero yo estamos ubicados en Medellín').collected_travel_origin).toBe('Medellín');
  });

  it.each([
    { text: 'Estamos en Medellín', origin: 'Medellín' },
    { text: 'Vivimos en Duitama', origin: 'Duitama' },
    { text: 'Somos de Marinilla', origin: 'Marinilla' },
  ])('captures capitalized origin from "$text"', ({ text, origin }) => {
    expect(extractBookingFields(text).collected_travel_origin).toBe(origin);
  });

  it('does not include conversational context after the origin', () => {
    expect(extractBookingFields('Estamos en Medellín buscando fechas').collected_travel_origin).toBe('Medellín');
    expect(extractBookingFields('Estamos en Bogotá con mi familia').collected_travel_origin).toBe('Bogotá');
    expect(extractBookingFields('Estamos en Bogotá actualmente').collected_travel_origin).toBe('Bogotá');
    expect(extractBookingFields('Estamos en Bogotá por ahora').collected_travel_origin).toBe('Bogotá');
  });

  it.each([
    'Santa Rosa de Viterbo',
    'San José del Guaviare',
  ])('preserves short particles in multi-word origin "%s"', origin => {
    expect(extractBookingFields(`Estamos en ${origin}`).collected_travel_origin).toBe(origin);
  });

  it('captures an inline child age mention', () => {
    const fields = extractBookingFields('Vamos con un niño de 9 años');
    expect(JSON.parse(String(fields.collected_child_ages_json))).toEqual([9]);
  });
});

describe('extractBookingFields — multi-word names and word adult counts', () => {
  it('captures multi-word declarative names', () => {
    expect(extractBookingFields('Me llamo Juan Carlos').collected_name).toBe('Juan Carlos');
  });

  it('does not include conversational context after the name', () => {
    expect(extractBookingFields('Me llamo Juan Carlos y quiero fechas').collected_name).toBe('Juan Carlos');
    expect(extractBookingFields('Me llamo Juan Carlos desde Medellin').collected_name).toBe('Juan Carlos');
  });

  it('preserves particles in a long declarative name', () => {
    expect(extractBookingFields('Me llamo Ana María de la Cruz').collected_name).toBe('Ana María De La Cruz');
  });

  it('derives mixed group totals from word adult counts', () => {
    const fields = extractBookingFields('cuatro adultos y 2 niños');
    expect(fields.collected_adults).toBe(4);
    expect(fields.collected_children).toBe(2);
    expect(fields.collected_people).toBe(6);
  });

  it('derives mixed group totals above twenty for large-group escalation', () => {
    const fields = extractBookingFields('25 adultos y 2 niños');
    expect(fields.collected_adults).toBe(25);
    expect(fields.collected_children).toBe(2);
    expect(fields.collected_people).toBe(27);
  });

  it('keeps totals above one hundred for large-group escalation', () => {
    expect(extractBookingFields('99 adultos y 2 niños').collected_people).toBe(101);
  });
});

describe('reconstructFromHistory — extended qualification fields', () => {
  it('recovers group breakdown, child ages, and origin from existing inbound history', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112233';
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'inbound',
      message_type: 'text',
      body: 'Somos 2 adultos y 2 niños, uno es un niño de 9 años. Estamos en Medellín',
      created_at: new Date().toISOString(),
    });

    try {
      expect(reconstructFromHistory(repos, phone, {})).toMatchObject({
        personas: 4,
        adultos: 2,
        ninos: 2,
        edadesNinos: [9],
        origen: 'Medellín',
      });
    } finally {
      db.close();
    }
  });

  it('uses the newest explicit no-children revision instead of stale child data', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112234';
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'inbound',
      message_type: 'text',
      body: 'Somos 2 adultos y 2 niños, un niño de 9 años',
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'inbound',
      message_type: 'text',
      body: 'Cambio: ahora somos 2 adultos, sin niños',
      created_at: new Date().toISOString(),
    });

    try {
      expect(reconstructFromHistory(repos, phone, {})).toMatchObject({
        personas: 2,
        adultos: 2,
        ninos: 0,
        edadesNinos: [],
      });
    } finally {
      db.close();
    }
  });

  it('does not backfill child ages across a newer child-count revision', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112235';
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'inbound',
      message_type: 'text',
      body: 'Somos 2 adultos y 2 niños, un niño de 9 años',
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    repos.message.addMessage({
      customer_phone: phone,
      direction: 'inbound',
      message_type: 'text',
      body: 'Ahora somos 2 adultos y 1 niño, no sé la edad',
      created_at: new Date().toISOString(),
    });

    try {
      const reconstructed = reconstructFromHistory(repos, phone, {});
      expect(reconstructed.ninos).toBe(1);
      expect(reconstructed.edadesNinos).toBeUndefined();
    } finally {
      db.close();
    }
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

  it('captures a name after an accented LLM question ("¿Cómo te llamas?")', () => {
    seedLastQuestion('¿Cómo te llamas?');
    const result = contextAwareExtract('Carlos', repos, PHONE, {});
    expect(result.collected_name).toBe('Carlos');
  });

  it('skips an image caption to find the real last question', () => {
    seedLastQuestion('Antes de seguir, ¿como te llamas?');
    repos.message.addMessage({
      customer_phone: PHONE, direction: 'outbound', message_type: 'image',
      body: 'Heinner y Alexandra - Andean Scapes', created_at: new Date().toISOString(),
    });
    expect(getLastAssistantQuestion(repos, PHONE)).toBe('Antes de seguir, ¿como te llamas?');
    const result = contextAwareExtract('Carlos', repos, PHONE, {});
    expect(result.collected_name).toBe('Carlos');
  });

  it('does not capture own transport from an explicit negation', () => {
    seedLastQuestion('¿Tienen transporte propio o lo necesitan desde Bogota?');
    const result = contextAwareExtract('No cuento con transporte propio', repos, PHONE, {});
    expect(result.collected_transport_need).toBeUndefined();
  });

  it('captures child ages from a bare numeric reply after an age question', () => {
    seedLastQuestion('¿Los niños tienen más de 5 años?');
    const result = contextAwareExtract('Si tienen 9 y 11', repos, PHONE, {});
    expect(JSON.parse(String(result.collected_child_ages_json))).toEqual([9, 11]);
  });

  it('does not treat child count or minimum threshold as exact ages', () => {
    seedLastQuestion('¿Los niños tienen más de 5 años?');
    const result = contextAwareExtract('Sí, los 2 tienen más de 5', repos, PHONE, {});
    expect(result.collected_child_ages_json).toBeUndefined();
  });

  it('does not convert an age range into an exact child age', () => {
    seedLastQuestion('¿Qué edades tienen los niños?');
    const result = contextAwareExtract('Entre 8 y 12 años', repos, PHONE, {});
    expect(result.collected_child_ages_json).toBeUndefined();
  });

  it('keeps a two-child age list with a trailing unit', () => {
    seedLastQuestion('¿Qué edades tienen los niños?');
    const result = contextAwareExtract('9 y 11 años', repos, PHONE, {});
    expect(JSON.parse(String(result.collected_child_ages_json))).toEqual([9, 11]);
  });

  it('does not capture child ages after a non-child question', () => {
    seedLastQuestion('¿Cuantas personas serian?');
    const result = contextAwareExtract('Somos 9', repos, PHONE, {});
    expect(result.collected_child_ages_json).toBeUndefined();
  });

  it('captures multi-word standalone name after a name ask', () => {
    seedLastQuestion('¿Cómo te llamas?');
    const result = contextAwareExtract('Ana Maria', repos, PHONE, {});
    expect(result.collected_name).toBe('Ana Maria');
  });

  it('captures the name before additional prose after a name ask', () => {
    seedLastQuestion('¿Cómo te llamas?');
    const result = contextAwareExtract('Carlos, quiero reservar', repos, PHONE, {});
    expect(result.collected_name).toBe('Carlos');
  });

  it('does not store lowercase prose as a name', () => {
    seedLastQuestion('¿Cómo te llamas?');
    expect(contextAwareExtract('estoy interesado', repos, PHONE, {}).collected_name).toBeUndefined();
  });

  it('captures travel origin from a bare city reply after a distance question', () => {
    seedLastQuestion('¿A cuántas horas quedas de Bogotá?');
    const result = contextAwareExtract('Desde Marinilla', repos, PHONE, {});
    expect(result.collected_travel_origin).toBe('Marinilla');
  });
});

describe('detectPlan — ordinal / duration choice', () => {
  const experience = getActiveExperience(loadSkills());

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
    expect(detectPlan(text, experience)).toBe('2d1n_mining');
  });

  it.each([
    'el segundo',
    'el de 3',
    'el de tres',
    'el largo',
    'plan de 3 dias',
  ])('resolves "%s" to 3d2n_rural', (text) => {
    expect(detectPlan(text, experience)).toBe('3d2n_rural');
  });

  it.each([
    'el de 2 noches',
    'el de dos noches',
    '2 noches',
    'dos noches',
  ])('nights beat ordinals: "%s" → 3d2n_rural', (text) => {
    expect(detectPlan(text, experience)).toBe('3d2n_rural');
  });

  it('does not treat "la del primero" as a plan (date-list phrasing)', () => {
    expect(detectPlan('la del primero esta bien', experience)).toBeNull();
  });

  it('uses only the request-scoped experience plans', () => {
    const scoped = {
      ...experience,
      plans: [{
        ...experience.plans[0],
        id: 'lagoon_day',
        keywords: ['laguna azul'],
      }],
    };

    expect(detectPlan('quiero laguna azul', scoped)).toBe('lagoon_day');
    expect(detectPlan('quiero la mina', scoped)).toBeNull();
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
