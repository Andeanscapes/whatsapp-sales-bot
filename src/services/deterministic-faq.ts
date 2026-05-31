import type { Skills } from './skill-loader.js';
import { detectLanguage, normalizeText } from './language-service.js';
import { MONTH_NAMES } from './constants.js';

export interface FaqResult {
  answer: string;
  intent: string;
  confidence: number;
}

export function findIntent(text: string, skills: Skills, lang?: string): FaqResult | null {
  const normalized = normalizeText(text);
  const detectedLang = lang || detectLanguage(normalized);

  for (const exp of skills.andeanScapes.experiences) {
    const questions = exp.commonQuestions.filter(q => !q.lang || q.lang === detectedLang);
    for (const q of questions) {
      const qWords = normalizeText(q.question).split(/\s+/).filter(Boolean);
      const inputWords = normalized.split(/\s+/).filter(Boolean);
      const matchingWords = qWords.filter(w => inputWords.includes(w));
      const confidence = qWords.length > 0 ? matchingWords.length / qWords.length : 0;

      if (confidence >= 0.75) {
        return { answer: q.answer, intent: q.intent, confidence };
      }
    }

    const priceKeywords = ['how much', 'price', 'cost', 'cuánto', 'cuanto', 'valor', 'precio', 'pay', 'pagar', 'cuesta', 'cuestan', 'vale', 'valen', 'costo'];
    if (priceKeywords.some(k => normalized.includes(k))) {
      const shownItems = exp.pricing.items.filter(i => i.publiclyShow === true);
      const lines: string[] = [];
      for (const item of shownItems) {
        if (item.couplePrice) {
          lines.push(`${item.label}: ${(item.couplePrice as number).toLocaleString('es-CO')} ${exp.pricing.currency} total`);
        } else if (item.pricePerPerson) {
          lines.push(`${item.label}: ${(item.pricePerPerson as number).toLocaleString('es-CO')} ${exp.pricing.currency}`);
        }
      }
      const answer = lines.length > 0
        ? (detectedLang === 'es'
          ? `Precios de referencia:\n${lines.join('\n')}\nPara un presupuesto final, cuéntanos tu fecha preferida y el tamaño del grupo.`
          : `Reference prices:\n${lines.join('\n')}\nFor a final quote, tell us your preferred date and group size.`)
        : (detectedLang === 'es'
          ? 'Consulta los precios actualizados con el equipo de reservas — te darán toda la información precisa.'
          : 'Check current prices with the booking team — they will give you accurate information.');
      return { answer, intent: 'pricing', confidence: 0.85 };
    }

    const availKeywords = ['available', 'availability', 'date', 'fecha', 'disponible', 'dates', 'calendar',
      'disponibilidad', 'agenda', 'cupo'];
    if (availKeywords.some(k => normalized.includes(k)) || MONTH_NAMES.some(m => normalized.includes(m))) {
      const dates = exp.availability.availableDates.filter(d => d.status === 'available' || d.status === 'limited');
      const answer = dates.length > 0
        ? (detectedLang === 'es'
          ? `Fechas disponibles actualmente: ${dates.map(d => d.date).join(', ')}.\nTen en cuenta que el equipo debe confirmar la disponibilidad final antes de la reserva. ¿Qué fecha te interesa?`
          : `Currently listed available dates: ${dates.map(d => d.date).join(', ')}.\nPlease note the team must confirm final availability before reservation. What date are you interested in?`)
        : (detectedLang === 'es'
          ? 'El equipo de reservas puede confirmar la disponibilidad para la fecha que te interesa. Escríbenos tu fecha preferida.'
          : 'The booking team can confirm availability for your preferred date. Write us your preferred date.');
      return { answer, intent: 'availability', confidence: 0.85 };
    }
  }

  return null;
}
