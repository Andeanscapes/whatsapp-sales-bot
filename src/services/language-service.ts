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
  'stop', 'unsubscribe',
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
  const normalized = normalizeText(text);
  const words = new Set(normalized.split(' ').filter(Boolean));
  const spanishScore = SPANISH_MARKERS.filter(marker => words.has(marker)).length;
  const englishScore = ENGLISH_MARKERS.filter(marker => words.has(marker)).length;

  if (spanishScore > englishScore) return 'es';
  if (englishScore > spanishScore) return 'en';
  return 'es';
}
