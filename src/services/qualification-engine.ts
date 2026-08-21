import type { Repositories } from '../db/repositories/index.js';
import { normalizeText, detectLanguageOrNull, detectExplicitLanguageSwitch, type SupportedLanguage } from './language-service.js';
import type { FallbackReplies } from './skill-loader.js';
import type { MergedQualification } from './types.js';
import { getPlans, type ActiveExperience } from './product-registry.js';
import { MONTH_NAMES } from './constants.js';
import { env } from '../config/env.js';
import { parseChildAges } from './qualification-format.js';

function isForbiddenCustomerName(name: string): boolean {
  const n = name.toLowerCase().trim();
  return n === env.OWNER_NAME.toLowerCase().trim() || n === env.PARTNER_NAME.toLowerCase().trim();
}

// Expanded from production history (2026-08-02 dump): plural/accented diversions
// ("Precios", "Que fechas") were slipping past the original singular-only list
// and getting stored as the customer's name.
export const NAME_BLACKLIST = /^(?:hola|buenas|hello|hi|hey|ok|si|no|yes|ya|gracias|thanks|quiero|cual|cuál|como|cómo|cuanto|cuánto|donde|dónde|cuando|cuándo|que|qué|precio|precios|fecha|fechas|itinerario|itinerarios|agenda|agendas|actividades|opcion|opción|opciones|informacion|información|what|how|where|when|porque|por qu[eé]|me|te|se|el|la|los|las|es|own|solo|sola|bien|listo|dias|días|tarde|tardes|noche|noches|mañana|persona|person|interesado|interesada|interested|looking)$/i;

const NAME_TOKEN = String.raw`[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+`;
const NAME_PHRASE = String.raw`((?:${NAME_TOKEN})(?:\s+${NAME_TOKEN}){0,4})`;
const NAME_TOKEN_EN = String.raw`[A-Z][a-z]+`;
const NAME_PHRASE_EN = String.raw`((?:${NAME_TOKEN_EN})(?:\s+${NAME_TOKEN_EN}){0,4})`;

export const NAME_PATTERNS: Array<{ pattern: RegExp; ambiguousCopula: boolean }> = [
  { pattern: new RegExp(String.raw`\bsoy ${NAME_PHRASE}`, 'i'), ambiguousCopula: true },
  { pattern: new RegExp(String.raw`\bme llamo ${NAME_PHRASE}`, 'i'), ambiguousCopula: false },
  { pattern: new RegExp(String.raw`\bmi nombre es ${NAME_PHRASE}`, 'i'), ambiguousCopula: false },
  { pattern: new RegExp(String.raw`\bi am ${NAME_PHRASE_EN}`, 'i'), ambiguousCopula: true },
  { pattern: new RegExp(String.raw`\bmy name is ${NAME_PHRASE_EN}`, 'i'), ambiguousCopula: false },
];

function titleCaseName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

const DECLARATION_TAIL = /\s+(?=(?:buscando|viendo|consultando|revisando|actualmente|ahora|por ahora|porque|para|pero|y|con|desde|from|with|quiero|queremos|interesad[oa]s?|necesito|necesitamos)\b)/i;

function cleanNameCandidate(raw: string): string | null {
  if (/^(?:de|desde|en|from|in)\b/i.test(raw.trim())) return null;
  const candidate = raw.split(DECLARATION_TAIL)[0]?.trim();
  return candidate || null;
}

function isValidCustomerName(raw: string): boolean {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 2 || trimmed.length > 40) return false;
  const parts = trimmed.split(' ');
  if (parts.length < 1 || parts.length > 5) return false;
  return parts.every((part, index) => {
    const isInternalParticle = index > 0
      && index < parts.length - 1
      && /^(?:de|del|la|las|los)$/i.test(part);
    return isInternalParticle || (
      !NAME_BLACKLIST.test(part)
      && !isForbiddenCustomerName(part)
      && /^[A-ZÁÉÍÓÚÜÑa-záéíóúüñ]+$/u.test(part)
    );
  });
}

function hasNameCapitalization(raw: string): boolean {
  const parts = raw.trim().split(/\s+/);
  return parts.every((part, index) => {
    const isInternalParticle = index > 0
      && index < parts.length - 1
      && /^(?:de|del|la|las|los)$/i.test(part);
    return isInternalParticle || /^[A-ZÁÉÍÓÚÜÑ]/u.test(part);
  });
}

function isWholeSingleNameDeclaration(text: string, candidate: string): boolean {
  return !candidate.includes(' ')
    && /^\s*(?:hola[,.]?\s+)?(?:soy|i am)\s+[A-ZÁÉÍÓÚÜÑa-záéíóúüñ]+[.!]?\s*$/iu.test(text);
}

/** True when customer compares solo vs couple without settling one size. */
export function isAmbiguousPartyComparison(text: string): boolean {
  const norm = normalizeText(text);
  const soloSide = String.raw`(?:solo|sola|una\s+persona|1\s+persona|individual|just\s+me|alone|solo\s+traveler)`;
  const coupleSide = String.raw`(?:pareja|couple|dos\s+personas|2\s+personas)`;
  const connector = String.raw`(?:\bo\b|\bo\s+quiz[aá]s\b|\bor\b|\bvs\.?\b|\bversus\b)`;
  return new RegExp(String.raw`${soloSide}.{0,40}${connector}.{0,40}${coupleSide}`, 'i').test(norm)
    || new RegExp(String.raw`${coupleSide}.{0,40}${connector}.{0,40}${soloSide}`, 'i').test(norm)
    || /precios?\s+para\s+(?:una\s+)?persona\s+o\s+(?:para\s+)?pareja/i.test(norm)
    || /(?:una\s+)?persona\s+o\s+(?:para\s+)?pareja/i.test(norm)
    || /(?:precio|precios|vale|valor).{0,40}(?:una\s+persona|individual|solo).{0,40}(?:pareja|dos\s+personas)/i.test(norm)
    || /(?:precio|precios|vale|valor).{0,40}(?:pareja|dos\s+personas).{0,40}(?:una\s+persona|individual|solo)/i.test(norm);
}

export const TRANSPORT_OWN_PATTERNS = [
  /\b(?:veh[ií]culo propio|carro propio|mi carro|mi coche|mi auto|mi camioneta|en mi carro|voy en carro|voy con carro|llevo carro|tengo mi carro|moto|moto propia|vamos en (?:carro|moto|auto)|tenemos (?:carro|moto|auto|veh[ií]culo)|transporte propio|transporte si|si tenemos)\b/i,
  /\b(?:propio transporte|transporte propio|coche propio|no necesitamos transporte|nosotros manejamos|manejamos|si propio|yo manejo|manejo|si[,.]?\s*mi\s+(?:carro|auto|coche|camioneta)|s[ií][,.]?\s*(?:mi\s+)?(?:carro|auto|coche|camioneta|propio))\b/i,
  /\b(?:we have (?:our own|a) (?:car|motorcycle|vehicle|transport|truck)|own transport|driving ourselves|yes own|i have (?:my )?own|my (?:own )?car|my car|my vehicle|rental car|we'?ll? drive|coming by car|driving there)\b/i,
  /\b(?:yes[,.]?\s*(?:i have|my|own|driving|car|vehicle)|yeah[,.]?\s*(?:my|own|car))\b/i,
];

export const TRANSPORT_OWN_CONTEXT_PATTERNS = [
  /\b(?:si|s[ií])\b.*\b(?:propio|tengo|tenemos|mi\s+(?:carro|auto|coche|camioneta))\b/i,
  /\b(?:propio|tengo carro|tengo moto|tengo veh[ií]culo|manejando|mi carro|mi auto|mi coche|voy con)\b/i,
  /\b(?:yes|yeah|yep)\b.*\b(?:own|have (?:a |my )?(?:car|transport|vehicle|ride)|my car|i drive)\b/i,
  /\b(?:i (?:have|drive) (?:a |my own )?(?:car|motorcycle|vehicle))\b/i,
  /\b(?:si[,.]?\s*(?:tengo|mi|con)\s*(?:carro|auto|coche|camioneta))\b/i,
];

export const PET_KEYWORDS = /\b(?:perro|perrito|mascota|mascotas|gato|gatos|perra|perros|gatito|pet|dog|cat|dogs|cats|puppy|kitten)\b/i;

/**
 * True when the customer explicitly negates transport/pet/lodging near the
 * matched keyword ("no cuento con transporte propio", "no llevo mascota").
 * Production history (2026-08-02 dump) showed bare keyword matching storing
 * the opposite of what the customer said.
 */
function isNegatedNear(text: string, keywordSource: string): boolean {
  const norm = normalizeText(text);
  return new RegExp(String.raw`\bno\b[^.!?]{0,25}\b(?:${keywordSource})\b`, 'i').test(norm)
    || new RegExp(String.raw`\b(?:${keywordSource})\b[^.!?]{0,10}\bno\b`, 'i').test(norm);
}

function isUncertainNear(text: string, keywordSource: string): boolean {
  const norm = normalizeText(text);
  const uncertainty = String.raw`(?:no se|no estoy segur[oa]|not sure|i don'?t know)`;
  return new RegExp(String.raw`\b${uncertainty}\b[^.!?]{0,35}\b(?:${keywordSource})\b`, 'i').test(norm)
    || new RegExp(String.raw`\b(?:${keywordSource})\b[^.!?]{0,35}\b${uncertainty}\b`, 'i').test(norm);
}

function isNeedQuestion(text: string, keywordSource: string): boolean {
  const norm = normalizeText(text);
  return new RegExp(String.raw`^\s*(?:necesito|necesitamos|puedo|podemos|podria|podriamos|se puede|aceptan|permiten|can i|can we|could i|could we|do i need|do we need)\b[^.!?]{0,35}\b(?:${keywordSource})\b`, 'i').test(norm);
}

/** Negates OWN transport only — must not block bus/from_bogota classification. */
const OWN_TRANSPORT_NEGATION_KEYWORDS =
  'transporte\\s+propio|carro\\s+propio|veh[ií]culo\\s+propio|moto\\s+propia|propio|own(?:\\s+transport|\\s+car)?';
export function isNegatedTransportAnswer(text: string): boolean {
  return isNegatedNear(text, OWN_TRANSPORT_NEGATION_KEYWORDS)
    || /\b(?:en\s+propio\s+no|propio\s+no|no\s+propio)\b/i.test(normalizeText(text));
}

const LODGING_NEGATION_KEYWORDS = 'hotel|hospedaje|alojamiento|lodging|stay|overnight';
function isNegatedLodgingAnswer(text: string): boolean {
  return isNegatedNear(text, LODGING_NEGATION_KEYWORDS);
}

const PET_NEGATION_KEYWORDS = 'mascota|mascotas|perro|perra|perros|gato|gatos|pet|dog|cat';
function isNegatedPetAnswer(text: string): boolean {
  return isNegatedNear(text, PET_NEGATION_KEYWORDS);
}

const COUNT_TOKEN = String.raw`(\d+|un[oa]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|one|two|three|four|five|six|seven|eight|nine|ten)`;
const CHILD_COUNT_WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const ADULT_COUNT_RE = new RegExp(String.raw`\b${COUNT_TOKEN}\s*(?:adulto(?:s)?|adulta(?:s)?|adults?)\b`, 'i');
const CHILD_COUNT_RE = new RegExp(String.raw`\b${COUNT_TOKEN}\s*(?:ninos?|ninas?|child(?:ren)?|kids)\b`, 'i');

function parseCountWord(raw: string): number | null {
  const n = CHILD_COUNT_WORDS[raw.toLowerCase()] ?? parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && n <= 100 ? n : null;
}

/** Self-declared travel origin ("estamos en Medellín", "vivimos en Duitama"). */
const ORIGIN_CITY = String.raw`([A-Za-zÁÉÍÓÚÜÑñ]{2,30}(?:\s+[A-Za-zÁÉÍÓÚÜÑñ]{2,30}){0,4})`;
const ORIGIN_DECLARATIVE_PATTERNS = [
  new RegExp(String.raw`\b(?:estamos ubicados en|estamos en|vivimos en|somos de|salimos de)\s+${ORIGIN_CITY}`, 'i'),
  new RegExp(String.raw`\b(?:we (?:are|live) in|coming from|departing from)\s+${ORIGIN_CITY}`, 'i'),
];

function cleanOriginCandidate(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.split(DECLARATION_TAIL)[0]?.trim().replace(/[.,!?]+$/, '') ?? '';
  if (trimmed.length < 3 || trimmed.length > 30) return null;
  return trimmed
    .split(/\s+/)
    .map((part, index) => index > 0 && /^(?:de|del|la|las|los)$/i.test(part)
      ? part.toLowerCase()
      : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function extractDeclaredOrigin(text: string): string | null {
  for (const pattern of ORIGIN_DECLARATIVE_PATTERNS) {
    const match = text.match(pattern);
    const origin = cleanOriginCandidate(match?.[1]);
    if (origin) return origin;
  }
  return null;
}

/** "niño de 5 años" / "child of 5 years old" — single explicit age mention. */
const CHILD_AGE_INLINE_RE = /\b(?:ni[ñn][oa]|child|kid)\s+(?:de\s+)?(\d{1,2})\s*(?:a[ñn]os|years?\s*old)\b/i;

export function detectPlan(message: string, experience: ActiveExperience): string | null {
  const norm = normalizeText(message);
  const plans = getPlans(experience);
  if (!plans.length) return null;

  // Nights beat bare ordinals: "el de 2 noches" → 3d2n, not 2d1n.
  const durationBoosts = new Map<string, RegExp>([
    ['3d2n_rural', /\b(3\s*d|3\s*dias|3\s*días|tres\s+dias|tres\s+días|2\s*noches|dos\s+noches)\b/],
    ['2d1n_mining', /\b(2\s*d|2\s*dias|2\s*días|dos\s+dias|dos\s+días|1\s*noche|una\s+noche)\b/],
  ]);

  // Negative lookahead prevents "el de 2 noches" from matching 2d1n.
  const ordinalPlanBoosts = new Map<string, RegExp>([
    ['2d1n_mining', /\b(?:el\s+primer[oa]?|el\s+de\s+2(?!\s*noches)|el\s+de\s+dos(?!\s+noches)|el\s+corto|plan\s+de\s+2(?!\s*noches)|plan\s+de\s+dos(?!\s+noches))\b/],
    ['3d2n_rural', /\b(?:el\s+segundo[oa]?|el\s+de\s+3|el\s+de\s+tres|el\s+largo|plan\s+de\s+3|plan\s+de\s+tres)\b/],
  ]);

  let best: { id: string; score: number } | null = null;
  let tied = false;

  for (const plan of plans) {
    let score = plan.keywords.reduce((total, keyword) => {
      return norm.includes(normalizeText(keyword)) ? total + 1 : total;
    }, 0);

    const durationBoost = durationBoosts.get(plan.id);
    if (durationBoost?.test(norm)) score += 15;

    const ordinalBoost = ordinalPlanBoosts.get(plan.id);
    if (ordinalBoost?.test(norm)) score += 12;

    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { id: plan.id, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }

  return best && !tied ? best.id : null;
}

export function isCorrectionMessage(text: string): boolean {
  const norm = normalizeText(text);
  return /ya (te |lo )?(dije|dine|dige|mencione|habia dicho|habia digo|habia mencionado|lo he dicho)/i.test(norm)
    || /ya (lo |te )?dije/i.test(norm)
    || /(i already|already) (told|said|mentioned)/i.test(norm);
}

export function getLastAssistantQuestion(repos: Repositories, phone: string): string | null {
  return repos.message.getLastOutboundTextBody(phone);
}

export function isConfirmedDate(value: unknown): boolean {
  return typeof value === 'string'
    && value !== 'tentative_unknown'
    && !value.startsWith('_');
}

/**
 * Clear "no date yet" signal — safe without prior date-ask context.
 * Patterns mined from production WhatsApp history (2026-07-26 dump).
 */
export function isExplicitDateDeferral(text: string): boolean {
  const norm = normalizeText(text);
  // fecha|fechas|typos (fecja/fech)
  const fecha = String.raw`(?:fechas?|fecja|fech)`;
  // "no tengo/tenemos/hay/dispongo de (una|ninguna|la) fecha[s] [exacta|estimada|...]"
  if (new RegExp(String.raw`\bno (?:tenemos|tengo|hay|dispongo de|disponemos de|se|sabemos) (?:la |una |ninguna )?${fecha}\b`).test(norm)) return true;
  // "todavia/aun no tengo fecha...", "no aun no tengo fecha"
  if (new RegExp(String.raw`\b(?:todavia|aun) no (?:tenemos|tengo|hay|dispongo de|disponemos de|se|sabemos) (?:la |una |ninguna )?${fecha}\b`).test(norm)) return true;
  if (new RegExp(String.raw`\bno (?:todavia|aun) no (?:tenemos|tengo) (?:la |una |ninguna )?${fecha}\b`).test(norm)) return true;
  // bare "sin fecha" / "ninguna fecha" / "no ninguna fecha" / "no sin fecha" / "no hay fecha tentativa"
  if (new RegExp(String.raw`\b(?:sin ${fecha}|ninguna ${fecha}|no ninguna ${fecha}|no sin ${fecha}|no hay (?:ninguna )?${fecha})\b`).test(norm)) return true;
  // "fecha no establecida/definida/fija", "no hay ninguna fecha establecida"
  if (new RegExp(String.raw`\b${fecha} (?:no )?(?:definida|establecida|fija|clara|exacta|estimada|tentativa)\b`).test(norm)
    && /\b(?:no|sin|ninguna|ningun|aun|todavia)\b/.test(norm)) return true;
  // "no tengo fecha en mente / exacta / estimada"
  if (new RegExp(String.raw`\bno (?:tengo|tenemos) (?:la |una |ninguna )?${fecha}(?:\s+(?:en mente|exacta|estimada|tentativa|definida|establecida|fija|clara))?\b`).test(norm)) return true;
  // flexibility / date does not matter
  if (new RegExp(String.raw`\b(?:no importa(?: la)? ${fecha}|da igual(?: la)? ${fecha}|${fecha} flexible|flexible con(?: la)? ${fecha}|diferente ${fecha} no importa)\b`).test(norm)) return true;
  // EN
  if (/\b(?:no date yet|we do not have (?:a )?date yet|i do not know (?:the )?date yet|no specific date|no fixed date|not sure (?:about |of )?(?:the )?date)\b/.test(norm)) return true;
  return false;
}

/** Broad uncertainty / options-branch answer — only meaningful when date_status is asked. */
export function isUncertainDateAnswer(text: string): boolean {
  const norm = normalizeText(text);
  if (isExplicitDateDeferral(norm)) return true;
  // short bare negatives + common typos ("o todavia" dropped N)
  if (/^(?:no|nop|nope|nel|nah|ninguna|ninguno|no aun|no todavia|o todavia|no realmente|aun no|todavia no)$/.test(norm)) return true;
  if (/\b(?:no lo se|no se aun|no se todavia|not sure|no estoy segur|todavia no|aun no|no aun|no todavia|o todavia)\b/.test(norm)) return true;
  if (/^(?:no se|no lo se|not sure)$/.test(norm)) return true;
  if (/^(?:por el momento no|por ahora no|en el momento no|en este momento no)(?:\b|$)/.test(norm)
    && !/\b(?:presupuesto|dinero|plata|pago|costo)\b/.test(norm)) return true;
  if (/^(?:opciones|las disponibles|disponibles|fechas|las fechas)$/.test(norm)) return true;
  if (/\b(?:revisar opciones|revisando opciones|ver(?: las)? opciones|opciones disponibles|fechas?(?: \w+){0,3} disponibles|prefiero ver|quiero revisar|mirando opciones|viendo opciones|explorando opciones|mostrar(?:me)?(?: las)? (?:opciones|fechas)|muestrame(?: las)? (?:opciones|fechas)|me muestras?(?: las)? (?:opciones|fechas)|si muestra(?: las)? (?:opciones|fechas)|cuentame las opciones|q(?:ue)? opciones|opciones tienes)\b/.test(norm)) return true;
  if (/^no\b/.test(norm) && /\bfechas?(?: \w+){0,3} disponibles\b/.test(norm) && !/\b\d{1,2}\b/.test(norm)) return true;
  if (/\b(?:solo(?: quiero)?(?: la)? informacion|solo consultando|solo preguntando|mas adelante|te escribo|luego te (?:aviso|escribo|digo))\b/.test(norm)) return true;
  if (/\b(?:plan a futuro|no tengo afan|no es(?: muy)? cercano)\b/.test(norm)) return true;
  return false;
}

/** True when customer chose the "show options" branch (not just deferred). */
export function isDateOptionsRequest(text: string): boolean {
  const norm = normalizeText(text);
  return /^(?:opciones|las disponibles|disponibles|fechas|las fechas)$/.test(norm)
    || /\b(?:revisar opciones|revisando opciones|ver(?: las)? opciones|opciones disponibles|fechas?(?: \w+){0,3} disponibles|prefiero ver|quiero revisar|mirando opciones|viendo opciones|explorando opciones|mostrar(?:me)?(?: las)? (?:opciones|fechas)|muestrame(?: las)? (?:opciones|fechas)|me muestras?(?: las)? (?:opciones|fechas)|si muestra(?: las)? (?:opciones|fechas)|cuentame las opciones|q(?:ue)? opciones|opciones tienes)\b/.test(norm);
}

export function isDateAskQuestion(question: string | null | undefined): boolean {
  if (!question) return false;
  const norm = normalizeText(question);
  return /\b(?:fecha tentativa|what date|que fecha|alguna fecha|para que fecha|date in mind|fecha en mente|fecha pensada|fecha aproximada|todavia estas explorando|andan explorando|tienen (?:una )?fecha|tienes (?:una )?fecha|cuando (?:quieres|quieren|te gustaria)|when would you)\b/.test(norm);
}

export function isQualificationComplete(q: MergedQualification): boolean {
  return q.nombre != null && q.plan != null && q.personas != null && isConfirmedDate(q.fecha) && q.transporte != null;
}

export function nextQualificationQuestion(q: MergedQualification, fb: FallbackReplies['es']): string {
  if (q.nombre == null) return fb.askName;
  if (q.plan == null) return fb.askPlan.replace('{{name}}', String(q.nombre));
  if (q.personas == null) return fb.askPeople;
  if (q.fecha == null) return fb.askDate;
  if (q.transporte == null) return fb.askTransport;
  return fb.aiFailureQualified;
}

export function extractStandaloneName(text: string): string | null {
  const firstClause = text.trim().split(/[,.;!?]/, 1)[0]?.replace(/\s+/g, ' ').trim();
  const candidate = firstClause ? cleanNameCandidate(firstClause) : null;
  if (!candidate || !/^[A-ZÁÉÍÓÚÜÑ]/u.test(candidate) || !isValidCustomerName(candidate)) return null;
  return titleCaseName(candidate);
}

const ORDINAL_MAP: Record<string, number> = {
  primero: 1, '1': 1, primera: 1, '1ero': 1,
  segundo: 2, segunda: 2, '2': 2, '2do': 2,
  tercero: 3, tercera: 3, '3': 3, '3ro': 3,
  cuarto: 4, cuarta: 4, '4': 4, '4to': 4,
  quinto: 5, quinta: 5, '5': 5, '5to': 5,
};

const RELATIVE_DATE_RE = /\b(?:la del|la|el|la de|la del dia|el dia|(?:fecha|date)\s+(?:numero|number)|numero|number)\s+(?:d[ií]a\s+)?((?:primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|1ero|2do|3ro|4to|5to|[1-5])|(?:the\s+)?(?:first|second|third|fourth|fifth|(?:number|#)\s*[1-5]))\b/i;

function resolveRelativeDate(text: string): string | null {
  const match = text.match(RELATIVE_DATE_RE);
  if (!match) return null;
  const ordinalWord = match[1]?.toLowerCase().replace(/^the\s+/, '').replace(/^number\s*|^#\s*/, '');
  const n = ORDINAL_MAP[ordinalWord];
  if (n == null) return null;
  return `_relative_ordinal_${n}`;
}

export function extractBookingFields(text: string, experience?: ActiveExperience): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  const relDate = resolveRelativeDate(text);
  if (relDate) {
    fields.collected_date = relDate;
    fields._relative_date_token = true;
  }

  const exactDateEs = text.match(/\b(?:s[aá]bado|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes)\s+(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i);
  if (exactDateEs) {
    fields.collected_date = exactDateEs[0].toLowerCase();
  }

  if (!fields.collected_date) {
    const exactDateEn = text.match(/\b(?:saturday|sunday|monday|tuesday|wednesday|thursday|friday)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
    if (exactDateEn) {
      fields.collected_date = exactDateEn[0].toLowerCase();
    }
  }

  if (!fields.collected_date) {
    const dayMonthEs = text.match(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+de\s+\d{4})?\b/i);
    if (dayMonthEs) {
      fields.collected_date = dayMonthEs[0].toLowerCase();
    }
  }

  if (!fields.collected_date) {
    const monthDayEn = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
    if (monthDayEn) {
      fields.collected_date = monthDayEn[0].toLowerCase();
    }
  }

  const monthInText = MONTH_NAMES.find(m => text.toLowerCase().includes(m));
  if (monthInText && !fields.collected_date) {
    fields.collected_date = monthInText;
  }

  const normalized = normalizeText(text);
  const adultsMatch = normalized.match(ADULT_COUNT_RE);
  const childMatch = normalized.match(CHILD_COUNT_RE);
  const adultsNum = adultsMatch ? parseCountWord(adultsMatch[1]) : null;
  const childrenNum = childMatch ? parseCountWord(childMatch[1]) : null;
  const explicitlyNoChildren = /\b(?:sin|no (?:hay|van|vamos con|tenemos|llevamos))\s+(?:ninos?|ninas?|hijos?|children|kids)\b/i.test(normalized);
  const hasAdultCount = adultsNum != null;
  const hasChildCount = childrenNum != null;
  const mixedAdultsAndChildren = hasAdultCount && hasChildCount;
  const peopleMatch = mixedAdultsAndChildren
    ? null
    : text.match(/(\d+)\s*(?:people|person|persons|personas|pax|adulto(?:s)?|adulta(?:s)?|adult|adults)/i);
  if (peopleMatch) fields.collected_people = parseInt(peopleMatch[1], 10);
  if (adultsNum != null) fields.collected_adults = adultsNum;
  if (childrenNum != null) fields.collected_children = childrenNum;
  if (explicitlyNoChildren) {
    fields.collected_children = 0;
    fields.collected_child_ages_json = JSON.stringify([]);
  }

  // Mixed group ("2 adultos y 2 niños"): record the adult/child breakdown and
  // the total headcount for logistics. Production history (2026-08-02 dump)
  // showed these families never got a collected_people total at all — the
  // contextual fallback then grabbed the wrong single digit on a later turn.
  if (mixedAdultsAndChildren) {
    if (adultsNum != null && childrenNum != null) {
      const total = adultsNum + childrenNum;
      if (total > 0) fields.collected_people = total;
    }
  }

  const simpleNumberMatch = text.match(/\b(?:somos|van|vamos|seriamos|serian|somos como|van como)\s+(\d+)\b/i);
  if (simpleNumberMatch && !fields.collected_people && !mixedAdultsAndChildren) {
    fields.collected_people = parseInt(simpleNumberMatch[1], 10);
  }

  const couplePattern = /\b(?:couple|pareja|dos personas|2 personas|dos pilotos|mi esposo y yo|mi esposa y yo|mi novio y yo|mi novia y yo|mi pareja y yo|mi hija y yo|mi hijo y yo|mi (?:mam[aá]|madre|made) y yo|vamos dos|somos dos|somos 2|vamos 2|por ahora dos)\b/i;
  const soloPattern = /\b(?:sola|solo|voy sola|voy solo|ir[ií]a sola|ir[ií]a solo|yo sola|yo solo|una persona|1 persona|just me|only me|me alone|solo traveler)\b/i;
  const ambiguousParty = isAmbiguousPartyComparison(text);
  if (couplePattern.test(text) && !fields.collected_people && !ambiguousParty && !mixedAdultsAndChildren) {
    fields.collected_people = 2;
  }

  if (soloPattern.test(text) && !fields.collected_people && !ambiguousParty && !mixedAdultsAndChildren) {
    fields.collected_people = 1;
  }

  const tresPeople = /\b(?:tres personas|3 personas|tree\s+personas?|somos\s+(?:tres|tree|3)|mis dos hijos|mi esposa y mi hijo|mi esposo y mi hija|somos tres|somos 3)\b/i;
  if (tresPeople.test(text) && !fields.collected_people) {
    fields.collected_people = 3;
  }

  for (const { pattern, ambiguousCopula } of NAME_PATTERNS) {
    const m = text.match(pattern);
    const candidate = m?.[1] ? cleanNameCandidate(m[1]) : null;
    const hasUnambiguousForm = candidate
      && (!ambiguousCopula || hasNameCapitalization(candidate) || isWholeSingleNameDeclaration(text, candidate));
    if (candidate && hasUnambiguousForm && isValidCustomerName(candidate)) {
      fields.collected_name = titleCaseName(candidate);
      break;
    }
  }

  // Own-transport negation must not block bus / from_bogota classification.
  if (!isNegatedTransportAnswer(text)) {
    for (const p of TRANSPORT_OWN_PATTERNS) {
      if (p.test(text)) {
        fields.collected_transport_need = 'own';
        break;
      }
    }
  }

  if (/\b(?:transporte privado|private transport|recog(?:er(?:nos)?|en|ernos)?\s+desde\s+Bogot[aá])\b/i.test(text)) {
    if (!fields.collected_transport_need) {
      fields.collected_transport_need = 'from_bogota';
    }
  }

  if (/\b(?:bus|terminal|salitre|transporte p[uú]blico|public bus|public transport)\b/i.test(text)) {
    fields.collected_transport_need = 'public_bus';
  }

  if (/lodging|hotel|stay|overnight|hospedaje|alojamiento/i.test(text)) {
    if (!isUncertainNear(text, LODGING_NEGATION_KEYWORDS) && !isNeedQuestion(text, LODGING_NEGATION_KEYWORDS)) {
      fields.collected_lodging_need = isNegatedLodgingAnswer(text) ? 'no' : 'yes';
    }
  }

  if (PET_KEYWORDS.test(text)) {
    const affirmativePet = text.split(/[,.!?;]/).some(clause =>
      /\b(?:llevo|llevamos|vamos con|viajo con|viajamos con)\b[^.!?]{0,20}\b(?:mascotas?|perr(?:o|a|os|as)|gatos?|pet|dogs?|cats?)\b/i.test(clause)
      && !isNegatedPetAnswer(clause),
    );
    if (affirmativePet) {
      fields.collected_pet = 'yes';
    } else if (!isUncertainNear(text, PET_NEGATION_KEYWORDS) && !isNeedQuestion(text, PET_NEGATION_KEYWORDS)) {
      fields.collected_pet = !isNegatedPetAnswer(text) ? 'yes' : 'no';
    }
  }

  const childAge = text.match(CHILD_AGE_INLINE_RE);
  if (childAge) {
    const age = Number(childAge[1]);
    if (Number.isInteger(age) && age >= 0 && age <= 17) {
      fields.collected_child_ages_json = JSON.stringify([age]);
    }
  }

  const origin = extractDeclaredOrigin(text);
  if (origin) fields.collected_travel_origin = origin;

  if (experience) {
    const detectedPlan = detectPlan(text, experience);
    if (detectedPlan) fields.collected_plan = detectedPlan;
  }

  return fields;
}

const SPANISH_NUMBER_WORDS: Record<string, number> = {
  uno: 1, una: 1, un: 1,
  dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, dieciséis: 16,
  diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
};

function extractPeopleFromReply(text: string): number | null {
  const norm = text.toLowerCase().trim();

  const toPeople = (raw: string): number | null => {
    const n = SPANISH_NUMBER_WORDS[raw] ?? parseInt(raw, 10);
    return Number.isInteger(n) && n >= 1 && n <= 20 ? n : null;
  };

  const peopleContext = /\b(?:somos|seriamos|ser[ií]amos|serian|ser[ií]an|vamos|iriamos|ir[ií]amos|para)\s+(\d{1,2}|uno|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|dieciséis|diecisiete|dieciocho|diecinueve|veinte)\b/.exec(norm)
    ?? /\b(\d{1,2}|uno|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|dieciséis|diecisiete|dieciocho|diecinueve|veinte)\s+personas\b/.exec(norm);
  if (peopleContext) {
    const n = toPeople(peopleContext[1]);
    if (n != null) return n;
  }

  // Exact standalone digit (existing behaviour preserved).
  const soloNum = /^(\d+)$/.exec(norm);
  if (soloNum) {
    const n = toPeople(soloNum[1]);
    if (n != null) return n;
  }

  // Embedded digit preceded or followed by whitespace/punctuation.
  const embeddedDigit = /\b(\d{1,2})\b/.exec(norm);
  if (embeddedDigit) {
    const n = toPeople(embeddedDigit[1]);
    if (n != null) return n;
  }

  // Spanish number-word (uno..veinte).
  const words = norm.split(/[^a-záéíóúüñ]+/).filter(Boolean);
  for (const w of words) {
    const v = toPeople(w);
    if (v != null) return v;
  }

  return null;
}

export function contextAwareExtract(message: string, repos: Repositories, phone: string, existing: Record<string, unknown>, experience?: ActiveExperience): Record<string, unknown> {
  const fields = { ...existing };
  const lastQuestion = getLastAssistantQuestion(repos, phone);
  // Accent-stripped so a real LLM question ("¿Cómo te llamas?") matches the
  // same ask-detection regex as the unaccented fallback template.
  const normQuestion = lastQuestion ? normalizeText(lastQuestion) : null;
  const norm = message.trim();

  if (lastQuestion && !fields.collected_people) {
    const askedPeople = normQuestion != null && /cu[aá]ntas personas|cu[aá]ntos ser[ií]an|how many people/i.test(normQuestion);
    if (askedPeople) {
      const people = extractPeopleFromReply(norm);
      if (people != null) fields.collected_people = people;
    }
  }

  if (lastQuestion && !fields.collected_name) {
    const askedName = normQuestion != null && /como te llamas|cual es tu nombre|con quien tengo/i.test(normQuestion);
    if (askedName) {
      const standaloneName = extractStandaloneName(norm);
      if (standaloneName && !isForbiddenCustomerName(standaloneName)) fields.collected_name = standaloneName;
    }
  }

  if (!fields.collected_name && isCorrectionMessage(norm)) {
    const correctionName = extractStandaloneName(norm);
    if (correctionName && !isForbiddenCustomerName(correctionName)) fields.collected_name = correctionName;
  }

  if (lastQuestion && !fields.collected_transport_need && !isNegatedTransportAnswer(norm)) {
    const askedTransport = normQuestion != null && /transporte propio|necesitan desde|vas (?:con|en)|por su cuenta|own transport|pickup|bogot[aá]|llegar desde|how (?:are you|will you) (?:getting|coming)/i.test(normQuestion);
    if (askedTransport) {
      const hasOwn = TRANSPORT_OWN_PATTERNS.some(p => p.test(norm)) || TRANSPORT_OWN_CONTEXT_PATTERNS.some(p => p.test(norm));
      if (hasOwn) fields.collected_transport_need = 'own';
    }
  }

  if (lastQuestion && !fields.collected_child_ages_json) {
    const askedAge = normQuestion != null
      && /(?:ni[ñn]os?|hijos?|kids?|children|cu[aá]ntos?\s+a[ñn]os|how old|what age)/i.test(normQuestion);
    if (askedAge) {
      const ageReply = norm.replace(
        /^\s*(?:si|sí)?[, ]*(?:los\s+\d+\s+)?(?:tienen?|son|are)?\s*/i,
        '',
      );
      const isAgeRange = /\bentre\s+\d{1,2}\s+y\s+\d{1,2}\s*(?:a[ñn]os|years?)\b/i.test(norm)
        || /\b\d{1,2}\s*(?:-|a|to)\s*\d{1,2}\s*(?:a[ñn]os|years?)\b/i.test(norm);
      const bareAgeList = !isAgeRange
        && /^\s*\d{1,2}(?:\s*(?:,|y|and)\s*\d{1,2})*\s*(?:a[ñn]os|years?)?\s*$/i.test(ageReply);
      const ageSource = isAgeRange
        ? ''
        : bareAgeList
          ? ageReply
          : [...norm.matchAll(/\b(\d{1,2})\s*(?:a[ñn]os|years?\s*old)\b/gi)]
          .filter(match => !/(?:(?:mas|más|mayor(?:es)?)\s+de|(?:over|under))\s*$/i.test(norm.slice(Math.max(0, match.index - 15), match.index)))
          .map(match => match[1])
          .join(' ');
      const ages = [...ageSource.matchAll(/\b(\d{1,2})\b/g)]
        .map(m => Number(m[1]))
        .filter(age => Number.isInteger(age) && age >= 0 && age <= 17)
        .slice(0, 4);
      if (ages.length > 0) fields.collected_child_ages_json = JSON.stringify(ages);
    }
  }

  if (lastQuestion && !fields.collected_travel_origin) {
    const askedOrigin = normQuestion != null
      && /de d[oó]nde|que ciudad|qu[eé] ciudad|ubicados|a cuantas horas|a cu[aá]ntas horas|distancia desde|where are you (?:coming|traveling) from|which city/i.test(normQuestion);
    if (askedOrigin) {
      const declared = extractDeclaredOrigin(norm);
      const bareReply = /^(?:desde\s+)?([A-Za-zÁÉÍÓÚÜÑñ]{3,30})\s*[.,!]?$/i.exec(norm.trim());
      const candidate = declared ?? cleanOriginCandidate(bareReply?.[1]);
      if (candidate && !NAME_BLACKLIST.test(candidate) && !TRANSPORT_OWN_PATTERNS.some(p => p.test(candidate))) {
        fields.collected_travel_origin = candidate;
      }
    }
  }

  if (existing._relative_date_token && typeof fields.collected_date === 'string' && (fields.collected_date as string).startsWith('_relative_ordinal_') && lastQuestion) {
    const n = parseInt((fields.collected_date as string).replace('_relative_ordinal_', ''), 10);
    if (!isNaN(n) && n > 0) {
      const datePattern = /\b(?:s[aá]bado|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|saturday|sunday|monday|tuesday|wednesday|thursday|friday)\s+\d{1,2}\s+(?:de\s+)?\w+/gi;
      const dates = lastQuestion?.match(datePattern) ?? [];
      if (n <= dates.length) {
        fields.collected_date = dates[n - 1].toLowerCase();
      }
    }
    delete fields._relative_date_token;
  }

  // Date progression is engine/repo-owned via date_status. Here we only extract:
  // - explicit exact/month dates into collected_date
  // - deferral/options intent flags for the engine (no silent tentative_unknown write without status)
  const dateStatus = repos.conversation.getDateStatus(phone);
  const explicitDateDeferral = !fields.collected_date && isExplicitDateDeferral(norm);
  if (explicitDateDeferral) {
    fields._date_deferred = true;
  }
  if (!fields.collected_date && (dateStatus === 'asked' || (lastQuestion && isDateAskQuestion(lastQuestion)))) {
    const monthFound = MONTH_NAMES.find(m => norm.toLowerCase().includes(m));
    if (monthFound && !explicitDateDeferral) fields.collected_date = monthFound;
    if (isUncertainDateAnswer(norm) || isUncertainDateAnswer(message)) {
      fields._date_deferred = true;
      if (isDateOptionsRequest(norm) || isDateOptionsRequest(message)) fields._date_options_requested = true;
    }
  }

  if (lastQuestion && !fields.collected_plan) {
    const askedPlan = /que plan|which plan|cual plan|2 dias|3 dias|2d|3d/i.test(lastQuestion);
    if (askedPlan) {
      const detectedPlan = experience ? detectPlan(norm, experience) : null;
      if (detectedPlan) fields.collected_plan = detectedPlan;
    }
  }

  const explicitPlan = experience ? detectPlan(norm, experience) : null;
  if (explicitPlan) fields.collected_plan = explicitPlan;

  return fields;
}

export function reconstructFromHistory(repos: Repositories, phone: string, current: Record<string, unknown>, experience?: ActiveExperience): Record<string, unknown> {
  const fields = { ...current };
  const allInbound = repos.message.getLastInboundBodies(phone, 20);
  const need = {
    nombre: !fields.nombre,
    personas: !fields.personas,
    fecha: !fields.fecha,
    transporte: !fields.transporte,
    mascota: !fields.mascota,
    adultos: fields.adultos == null,
    ninos: fields.ninos == null,
    edadesNinos: fields.edadesNinos == null,
    origen: !fields.origen,
  };
  let scannedPlan: string | null = null;
  for (const row of allInbound) {
    if (!row.body || (!need.nombre && !need.personas && !need.fecha && !need.transporte && !need.mascota
      && !need.adultos && !need.ninos && !need.edadesNinos && !need.origen && !scannedPlan)) continue;
    const extracted = extractBookingFields(row.body, experience);
    if (need.nombre && extracted.collected_name) { fields.nombre = extracted.collected_name; need.nombre = false; }
    if (need.personas && extracted.collected_people) { fields.personas = extracted.collected_people; need.personas = false; }
    if (need.fecha && extracted.collected_date) { fields.fecha = extracted.collected_date; need.fecha = false; }
    if (need.transporte && extracted.collected_transport_need) { fields.transporte = extracted.collected_transport_need; need.transporte = false; }
    if (need.mascota && extracted.collected_pet) { fields.mascota = extracted.collected_pet; need.mascota = false; }
    if (need.adultos && typeof extracted.collected_adults === 'number') { fields.adultos = extracted.collected_adults; need.adultos = false; }
    if (need.ninos && typeof extracted.collected_children === 'number') { fields.ninos = extracted.collected_children; need.ninos = false; }
    if (need.edadesNinos && typeof extracted.collected_child_ages_json === 'string') {
      const ages = parseChildAges(extracted.collected_child_ages_json);
      if (ages) { fields.edadesNinos = ages; need.edadesNinos = false; }
    }
    if (need.edadesNinos && typeof extracted.collected_children === 'number') {
      need.edadesNinos = false;
    }
    if (need.origen && extracted.collected_travel_origin) { fields.origen = extracted.collected_travel_origin; need.origen = false; }
    if (typeof extracted.collected_plan === 'string' && !scannedPlan) scannedPlan = extracted.collected_plan;
  }
  if (scannedPlan && typeof fields.plan === 'string' && scannedPlan !== fields.plan) {
    fields.plan = scannedPlan;
  }
  if (!fields.plan && scannedPlan && !repos.conversation.getSelectedExperienceId(phone)) {
    fields.plan = scannedPlan;
  }
  return fields;
}

export function buildDbQualification(collected: Record<string, unknown>): MergedQualification {
  const rawStatus = collected.dateStatus;
  const dateStatus = rawStatus === 'unasked' || rawStatus === 'asked' || rawStatus === 'deferred'
    || rawStatus === 'options_offered' || rawStatus === 'selected' || rawStatus === 'window'
    ? rawStatus
    : undefined;
  return {
    nombre: collected.nombre,
    plan: collected.plan,
    personas: collected.personas,
    fecha: collected.fecha,
    dateStatus,
    transporte: collected.transporte,
    mascota: collected.mascota,
  };
}

export function getCollectedFields(repos: Repositories, phone: string): Record<string, unknown> {
  return repos.conversation.getCollectedFields(phone);
}

export function resolveLanguage(repos: Repositories, phone: string, message: string): SupportedLanguage {
  const explicit = detectExplicitLanguageSwitch(message);
  if (explicit) return explicit;

  const existing = repos.conversation.getLanguage(phone);
  if (existing) return existing;

  return detectLanguageOrNull(message) ?? 'es';
}
