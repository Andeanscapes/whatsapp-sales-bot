export type SupportedLanguage = 'es' | 'en';

const SPANISH_MARKERS = [
  'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'gracias',
  'cual', 'cuales', 'que', 'como', 'donde', 'cuando', 'cuanto', 'cuantos',
  'precio', 'precios', 'plan', 'planes', 'fecha', 'fechas', 'disponible',
  'disponibilidad', 'reservar', 'reserva', 'personas', 'pareja', 'somos',
  'transporte', 'recoger', 'alojamiento', 'hospedaje', 'incluye', 'incluido',
  'informacion', 'info', 'quiero', 'necesito', 'podrian', 'gustaria', 'ayuda',
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

export function detectLanguageOrNull(text: string): SupportedLanguage | null {
  const normalized = normalizeText(text);
  const words = new Set(normalized.split(' ').filter(Boolean));
  const spanishScore = SPANISH_MARKERS.filter(marker => words.has(marker)).length;
  const englishScore = ENGLISH_MARKERS.filter(marker => words.has(marker)).length;

  if (spanishScore > englishScore) return 'es';
  if (englishScore > spanishScore) return 'en';
  return null;
}
