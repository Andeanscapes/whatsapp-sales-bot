export type SupportedLanguage = 'es' | 'en';

const SPANISH_MARKERS = [
  'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'gracias',
  'cual', 'cuales', 'que', 'como', 'donde', 'cuando', 'cuanto', 'cuantos',
  'precio', 'precios', 'plan', 'planes', 'fecha', 'fechas', 'disponible',
  'disponibilidad', 'reservar', 'reserva', 'personas', 'pareja', 'somos',
  'transporte', 'recoger', 'alojamiento', 'hospedaje', 'incluye', 'incluido',
  'informacion', 'quiero', 'necesito', 'podrian', 'gustaria', 'ayuda',
  'trata', 'tour', 'esmeraldas', 'minera', 'mineria', 'bogota', 'chivor',
];

const ENGLISH_MARKERS = [
  'hi', 'hello', 'hey', 'thanks', 'thank', 'what', 'where', 'when', 'how',
  'much', 'price', 'cost', 'plans', 'available', 'availability', 'date',
  'book', 'reserve', 'people', 'couple', 'transport', 'pickup', 'lodging',
  'hotel', 'included', 'information', 'about', 'help', 'tour', 'emerald',
  'just', 'planning', 'visit', 'colombia', 'december', 'january', 'february',
  'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'private', 'stop', 'unsubscribe',
  'can', 'have', 'would', 'want', 'interested',
];

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectLanguage(text: string): SupportedLanguage {
  return detectLanguageOrNull(text) ?? 'es';
}

// Shared fragments (matched against accent-stripped, lowercased text) so the ES
// and EN switch patterns stay in sync and avoid triple-duplicated alternations.
const SWITCH_VERB = 'habla|hablame|responde|responda|contestame|contesta|conteste|puedes\\s+(?:responder|contestar|hablar)|puede\\s+(?:responder|contestar|hablar)|responder|respondeme';
const SWITCH_COURTESY = 'por\\s+favor|pls|please';

// "habla (en) espanol", "en espanol por favor", "espanol por favor".
const EXPLICIT_SWITCH_ES = new RegExp(
  `\\b(?:${SWITCH_VERB})\\s+(?:en\\s+)?espanol\\b|\\ben\\s+espanol\\s+(?:${SWITCH_COURTESY})\\b|\\bespanol\\s+(?:${SWITCH_COURTESY})\\b`,
  'i',
);

// "speak (in) english", "can you reply in english", "english please", plus the
// Spanish-verb + ingles forms ("hablame en ingles").
const EXPLICIT_SWITCH_EN = new RegExp(
  `\\b(?:speak|reply|respond|answer|talk)\\s+(?:in\\s+)?english\\b|\\b(?:can\\s+you|please|could\\s+you)\\s+(?:speak|reply|respond|answer)\\s+(?:in\\s+)?english\\b|\\bin\\s+english\\s+(?:please|pls)\\b|\\benglish\\s+(?:please|pls)\\b|\\b(?:${SWITCH_VERB})\\s+(?:en\\s+)?ingles\\b|\\ben\\s+ingles\\s+(?:${SWITCH_COURTESY})\\b|\\bingles\\s+(?:${SWITCH_COURTESY})\\b`,
  'i',
);

export function detectExplicitLanguageSwitch(text: string): SupportedLanguage | null {
  const norm = normalizeText(text);
  if (EXPLICIT_SWITCH_EN.test(norm)) return 'en';
  if (EXPLICIT_SWITCH_ES.test(norm)) return 'es';
  return null;
}

function languageScores(text: string): { es: number; en: number } {
  const words = new Set(normalizeText(text).split(' ').filter(Boolean));
  return {
    es: SPANISH_MARKERS.filter(marker => words.has(marker)).length,
    en: ENGLISH_MARKERS.filter(marker => words.has(marker)).length,
  };
}

export function detectLanguageOrNull(text: string): SupportedLanguage | null {
  const { es, en } = languageScores(text);
  if (es > en) return 'es';
  if (en > es) return 'en';
  return null;
}

/** Any leading ad code ("C01", "M03", "P410"), not only the catalog C/H/R markers. */
const AD_CODE_OPENER = /^\s*[A-Z]{1,2}\d{2,3}\b/;

/**
 * Language of a prefilled ad opener ("P410 Hi! I'd like the PRIME trip…"), or null.
 * Ad texts are written in one language, so 2+ markers of one language that outnumber
 * the other are a stronger signal than a language stored from an earlier conversation.
 * Place names ("Chivor") count as Spanish markers, hence no wider margin.
 */
export function detectAdOpenerLanguage(text: string): SupportedLanguage | null {
  if (!AD_CODE_OPENER.test(text)) return null;
  const { es, en } = languageScores(text);
  if (en >= 2 && en > es) return 'en';
  if (es >= 2 && es > en) return 'es';
  return null;
}

/**
 * Per-language function and everyday words, used to recognise a language change
 * mid-chat. Words that are also common Spanish ("tres", "les", "sur", "come", "siete",
 * "das", "ola") are left out of the other lists, so a Spanish lead is never read as
 * French or Italian. Plan and product names are left out on purpose: "core" or
 * "prime" is not evidence of a language.
 */
const LANGUAGE_WORDS: Readonly<Record<string, readonly string[]>> = {
  es: [
    'hola', 'buenos', 'buenas', 'gracias', 'como', 'cuanto', 'cuanta', 'costo', 'cuesta',
    'entre', 'el', 'los', 'las', 'del', 'cada', 'tiene', 'tengo', 'tenemos', 'estamos',
    'queremos', 'quiero', 'puedo', 'pueden', 'podemos', 'pareja', 'somos', 'personas',
    'pero', 'porque', 'tambien', 'aqui', 'cuando', 'donde', 'cual', 'cuales', 'precio',
    'fecha', 'fechas', 'reservar', 'incluye', 'esta', 'este', 'hacer', 'minas', 'mina',
    'noche', 'dias', 'favor', 'saber', 'informacion', 'ayuda', 'necesito', 'gustaria',
  ],
  en: [
    'hi', 'hello', 'hey', 'thanks', 'thank', 'what', 'where', 'when', 'how', 'much',
    'price', 'cost', 'costs', 'available', 'availability', 'date', 'dates', 'book',
    'reserve', 'people', 'couple', 'transport', 'pickup', 'lodging', 'hotel', 'included',
    'information', 'about', 'help', 'emerald', 'just', 'planning', 'visit', 'december',
    'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september',
    'october', 'november', 'private', 'can', 'have', 'would', 'want', 'interested', 'the',
    'and', 'of', 'is', 'are', 'we', 'you', 'our', 'for', 'with', 'from', 'this', 'that',
    'them', 'which', 'like', 'prefer', 'sure', 'not', 'please', 'two', 'trip',
  ],
  fr: [
    'bonjour', 'bonsoir', 'salut', 'merci', 'je', 'nous', 'vous', 'est', 'des',
    'avec', 'pour', 'combien', 'quel', 'quelle', 'voudrions', 'voudrais', 'sommes', 'prix',
    'pas', 'oui', 'aussi', 'mais', 'personnes', 'voyage', 'cout', 'coute',
    'deux', 'trois', 'elle', 'faire', 'veux', 'voulons', 'pouvez', 'peut', 'cette',
  ],
  pt: [
    'obrigado', 'obrigada', 'voce', 'voces', 'custa', 'preco', 'pessoas', 'casal',
    'gostaria', 'nao', 'sim', 'muito', 'tambem', 'pode', 'sao', 'bom', 'boa',
    'tudo', 'bem', 'tem', 'mais', 'ainda', 'passeio', 'viagem', 'dois', 'duas',
    'onde', 'qual', 'quais', 'oi', 'pra',
  ],
  de: [
    'hallo', 'guten', 'danke', 'bitte', 'ich', 'wir', 'sie', 'ist', 'sind', 'und', 'nicht',
    'oder', 'mit', 'fur', 'wie', 'viel', 'kostet', 'kosten', 'preis', 'personen', 'paar',
    'mochten', 'gibt', 'auch', 'sehr', 'gut', 'zu', 'dass', 'haben', 'konnen',
    'wann', 'wo', 'dieser', 'eine',
  ],
  it: [
    'ciao', 'grazie', 'buongiorno', 'buonasera', 'per', 'sono', 'siamo', 'prezzo',
    'persone', 'coppia', 'vorrei', 'vorremmo', 'questo', 'questa', 'anche', 'molto', 'bene',
    'dove', 'quando', 'puoi', 'possiamo', 'della', 'delle', 'degli', 'nel', 'nella', 'che',
    'sei', 'voglio', 'quanti', 'quante', 'informazioni',
  ],
};

/** Display names for the prompt's `Language:` line. Unknown codes fall back to the code. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  es: 'español', en: 'English', fr: 'français', pt: 'português', de: 'Deutsch', it: 'italiano',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

export interface MessageLanguage {
  lang: string;
  /** Two or more language words, clearly more than any other language. A single word is weak. */
  strong: boolean;
}

/** es and en switch on two words; a rarer language needs three (Spanish shares short words with them). */
const STRONG_HITS: Readonly<Record<string, number>> = { es: 2, en: 2 };
const STRONG_HITS_OTHER = 3;

/**
 * Language of one message, or null when it carries no language evidence ("ok", "sí",
 * "2", emoji, a plan name). Bare answers therefore never count as a switch.
 */
export function detectMessageLanguage(text: string): MessageLanguage | null {
  // URLs carry "com", "www" and slugs, not the customer's language (live: a TikTok link
  // read as Portuguese).
  const withoutUrls = text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
  const words = new Set(normalizeText(withoutUrls).split(' ').filter(Boolean));
  const ranked = Object.entries(LANGUAGE_WORDS)
    .map(([lang, list]) => ({ lang, hits: list.filter(word => words.has(word)).length }))
    .sort((a, b) => b.hits - a.hits);
  const best = ranked[0];
  if (!best || best.hits === 0) return null;
  const runnerUp = ranked[1]?.hits ?? 0;
  return { lang: best.lang, strong: best.hits >= (STRONG_HITS[best.lang] ?? STRONG_HITS_OTHER) && best.hits > runnerUp };
}
