import type { Repositories } from '../db/repositories/index.js';
import { logger } from '../config/logger.js';
import { normalizeText } from './language-service.js';
import type { FallbackReplies, Skills } from './skill-loader.js';
import type { LeadPain } from '../db/repositories/types.js';
import type { MergedQualification } from './types.js';
import {
  isCorrectionMessage,
  isQualificationComplete,
  nextQualificationQuestion,
  getLastAssistantQuestion,
} from './qualification-engine.js';
import { getActiveExperience, getCommonQuestions } from './product-registry.js';

export { isCorrectionMessage, getLastAssistantQuestion };

function colombiaHour(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hourPart = parts.find(p => p.type === 'hour');
  return hourPart ? parseInt(hourPart.value, 10) : 0;
}

type ColombiaBusinessHoursPeriod = 'business' | 'night' | 'morning';

function colombiaBusinessHoursPeriod(now: Date = new Date()): ColombiaBusinessHoursPeriod {
  const hour = colombiaHour(now);
  if (hour >= 20) return 'night';
  if (hour < 9) return 'morning';
  return 'business';
}

function isAfterColombiaBusinessHours(now: Date = new Date()): boolean {
  return colombiaBusinessHoursPeriod(now) !== 'business';
}

export function afterHoursReply(normal: string, afterHours: string, now: Date = new Date()): string {
  return isAfterColombiaBusinessHours(now) && afterHours ? afterHours : normal;
}

export function colombiaTimeAwareReply(normal: string, night: string, morning: string, now: Date = new Date()): string {
  const period = colombiaBusinessHoursPeriod(now);
  if (period === 'night' && night) return night;
  if (period === 'morning' && morning) return morning;
  return normal;
}

const HANDOFF_PHRASE_REGEX = /(dame unos minuticos[^.]*equipo de reservas[^.]*\.?)|(give me a few minutes[^.]*reservations team[^.]*\.?)/i;
const HANDOFF_PHRASE_GLOBAL_REGEX = /(dame unos minuticos[^.]*equipo de reservas[^.]*\.?)|(give me a few minutes[^.]*reservations team[^.]*\.?)/gi;

export function hasActionableUserQuestion(text: string): boolean {
  const norm = normalizeText(text);
  return /(como se reserva|reserva\b|reservar|itinerario|a que hora|hora debo llegar|hora de llegada|llegar|agenda|cronograma|que incluye|donde deberiamos llegar|como se llega|como llego|se puede hacer en 1 dia|one day|puede ser un solo dia|solo 1 dia|que hay que llevar|que ropa|que llevar|que me pongo|hace frio|clima|cuantas horas|duracion|duracion del tour|en que consiste|como es la experiencia|cuentame del plan|cuentame mas|explicame bien|detallame|quiero saber mas|mas info|mas informacion|que mas incluye|que no incluye|que esta incluido|distancias|cuanto tiempo|kilometros|cuanto dura|cuantas horas son|es lejos|es peligroso|es seguro|ninos|niños|edad minima|cuantos años|pueden ir niños|puede ir un adulto mayor|tercera edad|what to bring|how long|duration|what does it include|tell me more|more info|what else|is it safe|kids|children|minimum age|how far|weather|cold|what to wear|what should i wear|what to pack|how many hours|is it far|how far is it|elderly|senior)/i.test(norm);
}

export function asksItinerary(text: string): boolean {
  const norm = normalizeText(text);
  return /(itinerario|a que hora|hora debo llegar|hora de llegada|como seria|como es el itinerario|no me dijiste|agenda|cronograma|como es el plan|como es el dia|como se desarrolla|como transcurre|como va el dia|en que orden|que hacemos primero|que hacemos despues|que sigue despues|schedule|day plan|how the day goes|what happens first|what'?s next|order of activities|breakdown|step by step|paso a paso|recorrido|como es el recorrido|que hay despues de la mina|que actividades hay)/i.test(norm);
}

export function isGenericConversionReply(reply: string): boolean {
  const norm = normalizeText(reply);
  return /me alegra que estes bien|quieres que revisemos disponibilidad|te gustaria reservar|que te parece|glad you(?:'re|\s+are) comfortable|would you like (?:us|me) to check|shall we (?:check|book)/.test(norm);
}

export function isUserConfusedOrRepeating(text: string): boolean {
  const norm = normalizeText(text);
  return /^\s*\??\s*$/i.test(norm) || /\b(que pasa|what|no entiendo|expl[ií]cate|repite|again|no me dijiste|perdon|perd[oó]n|no te entend[ií]|como as[ií]|que dijiste|qu[eé] dices|como|come again|pardon|i don'?t follow|i don'?t understand|i'?m lost|i'?m confused|no capt[eé]|no pill[eé]|no cog[ií]|me perd[ií]|me confund[ií]|no me quedo claro|no me qued[oó] claro)\b/i.test(norm);
}

export function isTruncatedReply(reply: string): boolean {
  const trimmed = reply.trim();
  return trimmed.endsWith('Desde') || trimmed.endsWith('desde')
    || trimmed.endsWith('para') || trimmed.endsWith('en el')
    || trimmed.endsWith('la') || trimmed.endsWith('un')
    || (trimmed.split(' ').length <= 2 && trimmed.length > 0 && !/[.!?]$/.test(trimmed));
}

export function isSoftCloseMessage(text: string): boolean {
  const norm = normalizeText(text);
  return /\b(no gracias|por ahora no|no me interesa|dejemoslo|dejemoslo ahi|en otro momento|otra oportunidad|muy caro|esta caro|algo caro|me parece caro|se sale del presupuesto|no me alcanza|fuera de presupuesto|costoso|caro|gracias por la info|por el momento no|lo dejamos ahi|no por ahora|lo voy a pensar|mejor no|paso por ahora|lo dejo ahi|no es para mi|no es lo que busco|no me convence|no es lo que esperaba|muy costoso|carisimo|cuesta mucho|es mucho|se me va de presupuesto|no tengo esa plata|no tengo presupuesto|no llego|no me da|luego te contacto|luego te escribo|not now|not interested|too expensive|out of budget|not in my budget|thank you for the info|for now no|not for me|not what i expected|i'?ll pass|i'?ll think about it|too much|over budget|can'?t afford|i'?ll skip|i have to decline|no thanks anyway|thanks anyway|gracias de todos modos|gracias igual|gracias de todas formas|no quiero seguir|no quiero continuar|dejemoslo hasta a[hií]|no sigamos|no quiero m[aá]s|no insistas?|dej[aá]moslo as[ií]|lo dejamos hasta a[hií]|no quiero saber m[aá]s|basta|suficiente|para ya|don'?t want to continue|let'?s stop here|i'?d rather not|stop here please|no more please|quiero pausar|pausemos|pausar|want to pause|i want to pause|let'?s pause|take a pause|hold off|put this on hold|on hold)\b/i.test(norm);
}

export function isNonSalesInquiry(text: string): boolean {
  return /\b(?:vacantes?|empleo|trabajo|hoja\s+de\s+vida|curr[ií]culum|curriculum|ingeniero\s+de\s+minas|job\s+opening|job\s+application|resume|hiring)\b/i.test(text);
}

/**
 * "Show me the lodging" is a photo request without ever saying "foto" — the live
 * `consecutive-gallery-requests` turn 4 ("muéstrame hospedaje y transporte") got no
 * RUNTIME cue and no corrective retry because only the noun list was matched.
 * Safe to widen: every downstream use is additionally gated by theme detection, so
 * a visual verb aimed at something with no gallery type ("muéstrame los precios")
 * resolves to zero themes and changes nothing.
 */
const VISUAL_REQUEST_VERB =
  /\b(?:mu[eé]stra(?:me|nos)?|mu[eé]stre(?:me|nos)?|mu[eé]strenme|ens[eé][ñn]a(?:me|nos)?|ens[eé][ñn]enme|show\s+(?:me|us)|let\s+(?:me|us)\s+see)\b/i;

export function isGalleryRequest(text: string): boolean {
  const norm = normalizeText(text);
  return /\b(foto|fotos|imagen|imagenes|im[aá]genes|photo|photos|picture|pictures)\b/i.test(norm)
    || VISUAL_REQUEST_VERB.test(norm);
}

/** Short follow-up whose photo theme must come from the immediately prior request. */
export function isGalleryContinuationRequest(text: string): boolean {
  const norm = normalizeText(text).trim().replace(/[?!.]+$/g, '').trim();
  return /^(?:(?:disculpa\s+)?(?:tienes|tienen|hay|manda(?:me)?|envia(?:me)?|comparte(?:me)?|me\s+(?:mandas|envias|compartes)|puedes\s+(?:mandar|enviar|compartir)(?:me)?|do\s+you\s+have|can\s+you\s+send(?:\s+me)?|send(?:\s+me)?)\s+)?(?:algunas?\s+|some\s+)?(?:mas|otras?|more|others?)(?:\s+(?:fotos?|imagenes?|photos?|pictures?))?$/i.test(norm);
}

export function isGalleryConfirmation(text: string, lastAssistantQuestion: string | null): boolean {
  if (!lastAssistantQuestion) return false;
  const norm = normalizeText(text);
  if (!/^\s*(s[ií]|si|yes|yeah|yep|claro|dale|ok|listo|aqui|aqu[ií]|por aqui|por aqu[ií])\b/i.test(norm)) return false;
  const questionNorm = normalizeText(lastAssistantQuestion);
  return /\b(foto|fotos|imagen|imagenes|im[aá]genes|photo|photos|picture|pictures)\b/i.test(questionNorm)
    && /\b(env[ií]o|enviar|mando|mandar|paso|pasar|compartir|por aqui|por aqu[ií]|send|share)\b/i.test(questionNorm);
}

export function isAdcodeNoise(text: string): boolean {
  return /^adcode-/i.test(text.trim())
    || /^[A-Za-z0-9+/=]{40,}$/.test(text.trim());
}

export function containsInternalEntryMarker(text: string): boolean {
  return /^\s*[CHR]\d{2}\s*$/i.test(text)
    || /^\s*[CHR]\d{2}\s*[-:]\s*/i.test(text)
    || /\b(?:codigo|código|marcador|campaña|entrada|vienes de)\s*:?[ ]*[CHR]\d{2}\b/i.test(text);
}

export function isReEngagementMessage(text: string, entryTemperature?: 'cold' | 'funnel' | 'retargeting'): boolean {
  const norm = normalizeText(text);
  const raw = text.trim();
  if (entryTemperature === 'cold' && /^[CHR]\d{2}\b/.test(raw)) return false;
  if (/^\s*[?¿]+\s*$/.test(raw)) return true;
  return /\b(despu[eé]s de pensar|lo pens[eé]|volv[ií]|bueno|me interesa|own|cu[aá]l es|cont[aá]me|de nuevo|cambiaste|reconsider|lo habl[eé]|lo consult[eé]|ya decid[ií]|estoy listo|listo|aqu[ií] estoy|estoy de vuelta|retomo|retomamos|seguimos|continuamos|dale|vamos|hag[aá]moslo|s[ií] quiero|me convenc[ií]|mejor dicho|i'?m back|i'?m ready|let'?s go|i decided|i talked about it|i consulted|i'?m in|i want to|let'?s continue|following up|touching base|checking in|after thinking|changed my mind|reconsidered|actually yes|actually i do|you know what|on second thought)\b/i.test(norm)
    || /\b(hola|hello|hi|buenas|hey|saludos|buen dia|buenos dias|buenas tardes|buenas noches|good morning|good afternoon|good evening|cuanto es|cuanto vale|cuanto cuesta|precio|how much|price|cual es el precio|cual es el valor|cual es el costo)\b/i.test(norm);
}

export function isPartnerConsultPause(text: string): boolean {
  const norm = normalizeText(text);
  const review = String.raw`(?:consulto|consultarlo|consultar[eé]|validar|valido|validarlo|revisar|reviso|revisarlo|mirar|miro|mirarlo|hablar|hablo|hablarlo|lo pienso|pensar|pensarlo|pensar[eé]|dejame|dame tiempo|sin afan|chequear|chequeo|lo chequeo|comentar|comento|lo comento|se lo digo|preguntar|pregunto|le pregunto|mostrar|muestro|le muestro|ense[ñn]ar|le ense[ñn]o|le paso|review|check|discuss|talk|think(?: it over)?|ask|show|run it by)`;
  const group = String.raw`(?:pareja|esposa|esposo|novia|novio|familia|hij[oa]s?|niñ[oa]s?|acompanante|acompa[ñn]ante|partner|wife|husband|girlfriend|boyfriend|family|children|kids|ella|el|con ella|con el|mi gente|mis papas|mis viejos|mis padres|ellos|they|with her|with him|my folks|my partner|my parents|my family)`;
  return new RegExp(String.raw`\b${review}\b[\s\S]{0,80}\b${group}\b`, 'i').test(norm)
    || new RegExp(String.raw`\b${group}\b[\s\S]{0,80}\b${review}\b`, 'i').test(norm);
}

/** Customer needs time to coordinate with their group, but has not declined. */
export function isReviewPause(text: string): boolean {
  return isPartnerConsultPause(text)
    || /\b(?:dejame|déjame)\s+(?:revisar|validar|confirmar)\b[\s\S]{0,80}\b(?:semana|grupo|familia|hij[oa]s?|children|kids)\b/i.test(text);
}

export function detectsAvailabilityConfirmRequest(text: string): boolean {
  const norm = normalizeText(text);
  return /(?:por favor\s+)?confirm(?:a|ar|e|emos)?\s+(?:la\s+)?disponibilidad/i.test(norm)
    || /(?:valida|validar|revisa|revisar)\s+(?:la\s+)?disponibilidad/i.test(norm)
    || /please\s+confirm\s+availability/i.test(norm)
    || /confirm\s+availability/i.test(norm);
}

export function detectsOrganizerContactShare(text: string): boolean {
  if (/(?:wa\.me\/|api\.whatsapp\.com\/send|whatsapp\.com\/send)/i.test(text)) return true;
  const hasPhone = /(?:\+?\d[\d\s().-]{7,}\d)/.test(text);
  if (!hasPhone) return false;
  return /\b(?:whatsapp|wa)\b.{0,40}\b(?:organizador|organizer|contacto|contact)\b/i.test(text)
    || /\b(?:organizador|organizer|contacto|contact)\b.{0,40}\b(?:whatsapp|wa)\b/i.test(text);
}

export function detectsWrongServiceNatureOnly(text: string): boolean {
  const norm = normalizeText(text);
  const wantsNature = /\b(?:solo\s+busco|only\s+(?:want|looking)|busco\s+solo|naturaleza|paisaje|nature|landscape|scenery)\b/i.test(norm);
  const rejectsMine = /\b(?:no\s+quiero\s+entrar|no\s+me\s+interesa\s+la\s+mina|sin\s+mina|no\s+mina|not\s+(?:the\s+)?mine|no\s+mining|don't\s+want\s+(?:the\s+)?mine|do\s+not\s+want\s+(?:the\s+)?mine)\b/i.test(norm);
  return wantsNature && rejectsMine;
}

export function detectsReservationIntent(text: string): boolean {
  const norm = normalizeText(text);
  if (isReservationIntentNegated(norm)) return false;
  if (detectsAvailabilityConfirmRequest(text)) return true;
  const patterns = [
    /quiero (reservar|pagar|agendar|separar|apartar)/,
    /me gustaria (reservar|pagar|agendar|separar|apartar)(?: ya)?/,
    /(como|donde) se (reserva|paga|agenda|separa|aparta)/,
    /(como|donde) (reservo|pago|reservar|pagar|transfiero|consigno)/,
    /como (?:hacemos|hacer|se hace|se realizan?) (?:para )?(?:reservar|pagar|separar|agendar|el proceso|la reserva)/,
    /\b(lo confirmo|agendamos|separemos|reservemos|apartemos)\b/,
    /manda (los datos|el link|info para pagar|el numero)/,
    /(envia|enviame) (los datos|el link|info para pagar)/,
    /vamos a reservar/,
    /listo para (reservar|pagar)/,
    /\b(pago por|pagar por|prefiero) (nequi|mercado pago)\b/,
    /\bquedo (reservado|apartado|separado)\b/,
    /i want to (book|reserve|pay)/,
    /how can i (make )?(a )?reservation/,
    /how can i (book|reserve|pay)/,
    /(how|where) (do i|to) (book|reserve|pay)/,
    /\b(let'?s book|book it|let'?s do it)\b/,
    /send (me )?(the )?(payment|booking) (link|info|details)/,
    /me (anoto|apunto|sumo)\b/,
    /nos (anotamos|apuntamos|sumamos|vemos|vamos)\b/,
    /(cuenta|cuenten|contad) conmigo/,
    /(cuenta|cuenten|contad) con nosotros/,
    /\b(fijo|fijate|fijo que si|separamos|separemos|apartame|separame|confirmame|confirmalo)\b/,
    /puedo (pagar|depositar|transferir|consignar)(?: ya| ahora| hoy)?/,
    /(cual es|cual seria) el (siguiente )?paso/,
    /(what is|what'?s) the next step/,
    /(como|donde|a donde|a quien) (pago|deposito|transfiero|consigno)/,
    /(a quien|donde|como) le (pago|deposito|transfiero)/,
    /\b(i'?m in|im in|count me in|sign me up|put me down|book me|reserve me)\b/,
    /(let'?s|let us) (book|reserve|do this|go for it|go ahead)/,
    /\b(go ahead|proceed|confirmed|confirming)\b/,
    /(i would like|i'?d like|i want) to (book|reserve|confirm|proceed|pay)/,
    /(yes|yeah|yep|yup|sure|absolutely|definitely)[\s,]*\b(i want to book|book it|let'?s book|let'?s do it|reserve)\b/,
    /puedo (separar|reservar|agendar) (?:ya|ahora|hoy|el cupo)?/,
    /\b(procedemos|proceder|sigamos|adelante) con la reserva/,
    /\b(how do we|how can we) (proceed|pay|book|reserve)/,
  ];
  return patterns.some(p => p.test(norm));
}

export function isReservationIntentNegated(text: string): boolean {
  const norm = normalizeText(text);
  const patterns = [
    /\b(?:no|ya no|aun no|todavia no)\s+(?:(?:me\s+)?(?:interesa|gustaria)\s+)?(?:(?:quiero|deseo|vamos a)\s+)?(?:reservar|pagar|agendar|separar|apartar|proceder|(?:confirmar|validar|revisar)\s+(?:la\s+)?disponibilidad)\b/i,
    /\bno\s+(?:confirmemos|validemos|revisemos)\s+(?:la\s+)?disponibilidad\b/i,
    /\b(?:no|aun no|todavia no)\s+(?:estamos|estoy)\s+list[oa]s?\s+para\s+(?:reservar|pagar|proceder)\b/i,
    /\bprefiero\s+no\s+(?:reservar|pagar|agendar|separar|apartar|proceder)\b/i,
    /\b(?:i\s+)?(?:do not|don'?t|dont)\s+(?:want to\s+)?(?:book|reserve|pay|proceed|confirm availability)\b/i,
    /\b(?:not ready to|(?:i\s+)?(?:won'?t|will not|am not going to))\s+(?:book|reserve|pay|proceed)\b/i,
  ];
  const negated = patterns
    .map(pattern => pattern.exec(norm))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => b.index - a.index)[0];
  if (!negated) return false;

  const laterText = norm.slice(negated.index + negated[0].length);
  return !/\b(?:quiero|deseo|vamos a)\s+(?:reservar|pagar|agendar|separar|apartar|proceder)\b/i.test(laterText);
}

/**
 * Close-CTA wording (whatsapp-sales T3b + singular validation start). Matched against
 * `normalizeText` output so accents/punctuation cannot drift the gate. Shared by
 * reservation-intent confirmation and close-stage inference.
 */
const CLOSE_CTA_QUESTION_PATTERNS: readonly RegExp[] = [
  /inicie esa validacion|inicie la validacion|quieres que inicie|quieres que la inicie|la inicie ahora/,
  // First-person-plural T3b: "primero valido disponibilidad ... ¿la iniciamos?" / "¿quieres/quieren que iniciemos la reserva?"
  /la iniciamos|(?:iniciamos|iniciemos) la (?:validacion|reserva)|vamos a iniciarla|quier(?:e|es|en) que (?:la )?iniciemos/,
  /shall i start that validation|shall i start it|start it now|want me to start|shall we start it|do we start it/,
  /validacion ahora|validation now/,
];

const SHORT_BOOKING_AFFIRMATION =
  /^\s*(s[ií]p?i?|yes|yeah|yep|yup|ok|okay|okey|listo|dale|dele|bueno|vamos|perfecto|perfect|de una|de acuerdo|claro|clarines|vale|genial|excelente|obvio|hecho|confirmo|confirmado|reservamos|reservemos|apartemos|separo|por supuesto|ya|let'?s do it|let'?s go|let'?s book|sure|for sure|alright|all right|absolutely|definitely|great|awesome|deal|done|of course|why not|i'?m in|count me in|go ahead|sounds good|sounds great|sounds perfect|works for me|fine by me|go for it)\b/i;

/** Soft discovery / interest questions — affirmation is reservation-adjacent, not a close CTA. */
const SOFT_RESERVATION_QUESTION_PATTERNS: readonly RegExp[] = [
  /(?:te gustar[ií]a reservar|quieres reservar|reservamos|agendamos|apartamos)/,
  /(?:would you like to book|shall we book|want to reserve)/,
  /(?:qu[eé] te parece|te encaja|es lo que buscabas|te suena|te interesa)/,
  /(?:what do you think|does that work|interested|sound good)/,
  /(?:quieres que revisemos|validamos disponibilidad|confirmamos)/,
  /(?:revision de reserva|dejarlo para revision|lo dejemos para revision|pasarlo al equipo|paso (?:esto |todo )?al equipo)/,
  /(?:want (?:me|us) to check|shall (?:I|we) check availability)/,
  /(?:listo para|preparado para|ready to)/,
];

export function matchesCloseCtaQuestion(text: string): boolean {
  const norm = normalizeText(text);
  return CLOSE_CTA_QUESTION_PATTERNS.some(p => p.test(norm));
}

/**
 * Short affirmation answering the hard close CTA only ("¿la iniciamos?" / validation
 * start). Soft "¿te suena?" interest questions must not use this path — they stay on
 * the full-qualification / score bridge gates.
 */
export function isExplicitCloseCtaConfirmation(
  message: string,
  lastAssistantQuestion: string | null,
): boolean {
  if (isReservationIntentNegated(message)) return false;
  if (!lastAssistantQuestion) return false;
  if (!SHORT_BOOKING_AFFIRMATION.test(normalizeText(message))) return false;
  return matchesCloseCtaQuestion(lastAssistantQuestion);
}

export function isReservationIntentOrConfirmation(
  message: string,
  lastAssistantQuestion: string | null,
): boolean {
  if (detectsReservationIntent(message)) return true;

  const norm = normalizeText(message);
  if (!SHORT_BOOKING_AFFIRMATION.test(norm)) return false;
  if (!lastAssistantQuestion) return false;

  const questionNorm = normalizeText(lastAssistantQuestion);
  if (matchesCloseCtaQuestion(lastAssistantQuestion)) return true;
  return SOFT_RESERVATION_QUESTION_PATTERNS.some(p => p.test(questionNorm));
}

export function replyMentionsPrice(reply: string): boolean {
  if (!reply) return false;
  const tests = [
    /\$\s?[\d.,]{6,}/,
    /\b\d{3}[.,]\d{3}\b\s*(?:cop|pesos)?/i,
    /\b\d,\d{3},\d{3}\b/,
    /\b(individual|pareja|por persona)\b[^\n]{0,40}\$/i,
    /\bcuesta\s+\$?\s?[\d.,]{4,}/i,
    /\b(precio|price|valor|costo|total|cuestan|valen)\b[^\n]{0,30}\$[\d.,]{3,}/i,
    /\b(precio|price|valor|costo|total)\b[^\n]{0,30}\b\d{3}[.,]\d{3}\b/i,
    /\bCOP\s?\d[\d.,]{3,}/i,
    /\b\d{4,}\s*(?:COP|pesos)\b/i,
    // Catch-all: any COP-formatted amount with thousand separators
    /\d{1,3}(?:[.,]\d{3})+\s*(?:COP|pesos)\b/i,
    /\$\s*\d{1,3}(?:[.,]\d{3})+\b/,
    // Spanish numeric phrases: "550 mil", "1 millón"
    /\b\d{2,3}\s*(?:mil)\b.{0,20}(?:COP|pesos)?/i,
    /\b\d\s*(?:mill[oó]n)\b.{0,20}(?:COP|pesos)?/i,
    /\b(?:cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos)(?:\s+(?:veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)(?:\s+y\s+\w+)?)?\s+mil(?:\s+(?:COP|pesos))?\b/i,
    /\b(?:un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\s+mill[oó]n(?:es)?(?:\s+(?:COP|pesos))?\b/i,
    /\b(?:one|two|three|four|five|six|seven|eight|nine)\s+(?:hundred(?:\s+(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety))?\s+thousand|million)(?:\s+(?:COP|pesos))?\b/i,
  ];
  return tests.some(p => p.test(reply));
}

export function detectProactiveLeadPain(message: string): LeadPain | null {
  const norm = message.toLowerCase().trim();
  if (/\b(muy caro|tan caro|esta caro|algo caro|costoso|fuera de presupuesto|no me alcanza|no me da|expensive|too expensive|over budget|can'?t afford)\b/i.test(norm)) return 'price';
  if (/\b(no tengo fecha|no se que fecha|todavia no se cuando|problema con la fecha|schedule conflict|no date yet|not sure when)\b/i.test(norm)) return 'date_time';
  if (/\b(es seguro|es peligroso|me da miedo|claustrofobia|safety concern|is it safe|is it dangerous|afraid|scared)\b/i.test(norm)) return 'security';
  if (/\b(no tengo carro|como llego|dificil llegar|necesito transporte|transport problem|no car|how do i get there)\b/i.test(norm)) return 'logistics_4x4';
  if (/\b(no entiendo|no me queda claro|como funciona exactamente|i don'?t understand|not clear|how does it work)\b/i.test(norm)) return 'experience_clarity';
  if (/\b(lo consulto|lo hablo|lo pienso|tengo que consultar|consultarlo con|discuss it with|check with my|talk to my)\b/i.test(norm)) return 'partner_group';
  return null;
}

export function containsHandoffPhrase(reply: string): boolean {
  return HANDOFF_PHRASE_REGEX.test(reply);
}

const CLOSING_DELAY_PATTERNS = [
  /\bma[ñn]ana\s+te\s+(genero|env[ií]o|mando|paso)/i,
  /\bluego\s+te\s+(?:lo\s+)?(?:env[ií]o|mando|paso)/i,
  /\bluego\s+te\s+confirmo\s+(?:disponibilidad|la\s+disponibilidad|el\s+cupo|la\s+fecha|la\s+reserva|el\s+precio)\b/i,
  /\bd[eé]jame\s+saber\s+si\s+te\s+gustar[ií]a/i,
  /\blet\s+me\s+know\s+if\s+you(?:'d|\s+would)\s+like\b/i,
  /\bI(?:'ll|\s+will)\s+(generate|send|get\s+back)\s+(?:it|to\s+you|the\s+link)\s+(?:tomorrow|later)\b/i,
  /\bcuando\s+quieras\s+(?:seguimos|reservamos|me\s+(?:dices|avisas|escribes))\b/i,
];

export function containsClosingDelay(reply: string): boolean {
  return CLOSING_DELAY_PATTERNS.some(p => p.test(reply));
}

export function stripHandoffPhrases(reply: string): string {
  return reply.replace(HANDOFF_PHRASE_GLOBAL_REGEX, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function isPaymentMethodsQuestion(text: string): boolean {
  const norm = normalizeText(text);
  return (
    /\b(metodos? de pago|medios? de pago|formas? de pago|como se paga|como pago|como puedo pagar|con que pago|nequi|mercado pago|anticipo|deposito|abono|pagar para separar|por partes)\b/i.test(norm)
    || /\b(payment methods?|how (can|do) i pay|how to pay|deposit|down payment|nequi|mercado pago|installments?|in parts)\b/i.test(norm)
  );
}

/** Colombian mobile (3xx xxx xxxx) — owner/payment phones must never reach customers. */
const COL_MOBILE = /\b3\d{2}[\s.-]?\d{3}[\s.-]?\d{4}\b/;
/** Known pay / short-link hosts (with or without scheme). */
const PAYMENT_URL = /\b(?:https?:\/\/)?(?:mpago\.la|mercadopago\.com(?:\.\w+)?|link\.mercadopago|wa\.me\/\d|bit\.ly\/|payu\.|paypal\.com)\S*/i;
/**
 * Offer to hand payment data over in chat. Payment context is REQUIRED: a plain
 * "te paso la info del plan" / "te mando los datos del hospedaje" is legitimate
 * sales copy and must still be delivered.
 */
const OFFER_PAYMENT_DATA = /\bte\s+(?:env[ií]o|mando|paso|doy)\s+(?:(?:los?|las?|el|mi)\s+)?(?:datos|n[uú]meros?|link|enlace|informaci[oó]n|info)\b[\s\S]{0,30}\b(?:de\s+pago|pago|nequi|mercado\s*pago|transferencia|cuenta|bancari)/i;

/**
 * Payment-detail leakage — phones, pay links, transfer instructions, or offers to
 * send payment data in-chat. Release of those is a runtime concern, not the model's.
 */
export function containsPaymentDetailLeak(reply: string): boolean {
  return /\[[^\]]*(inserte|insert|numero|número|payment|pago)[^\]]*\]/i.test(reply)
    || COL_MOBILE.test(reply)
    || PAYMENT_URL.test(reply)
    || /\b(nequi|mercado pago)\b[\s\S]{0,80}\b\d{7,}\b/i.test(reply)
    || /\b(nequi|mercado pago)\b[\s\S]{0,120}\b(https?:\/\/|wa\.me|bit\.ly)\b/i.test(reply)
    || /\b(transfiere|transfer|envia al|send to)\b[\s\S]{0,80}\b(nequi|mercado pago|\d{7,})\b/i.test(reply)
    || /\bn[uú]mero\b[\s\S]{0,40}\b\d{7,}\b/i.test(reply)
    || OFFER_PAYMENT_DATA.test(reply);
}

/**
 * Strong false-booking claims that must not reach the customer (ops/safety).
 * Intentionally excludes soft availability phrasing the skills ask for
 * ("te confirmo disponibilidad", "¿validamos disponibilidad?").
 */
export function containsFalseReservationClaim(reply: string): boolean {
  const norm = normalizeText(reply);
  return /\b(puedo separarte|queda reservado|te separo|separamos el cupo)\b[\s\S]{0,100}\b(?:\d{1,2}\s+de\s+\w+|\d{4}-\d{2}-\d{2}|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|cupo|fecha)\b/i.test(reply)
    || /\b(ya esta confirmado|ya tienes cupo|te confirmo el cupo|tienes cupo|reservado para ti|tu reserva esta|tu reserva qued[oó])\b/i.test(reply)
    || /\b(fecha confirmada|disponibilidad confirmada)\b[\s\S]{0,60}\b\d{1,2}\s+de\s+\w+/i.test(reply)
    || /\b(ya quedo|quedaste|estas|ya estas)\s+(reservado|apartado|separado|confirmado|agendado)\b/i.test(reply)
    || /\b(listo,? ya|ya,? listo)\s*(?:esta|qued[oó]|confirmado|reservado|agendado|separado)\b/i.test(reply)
    || /\btu reserva quedo confirmad[ao]\b/i.test(norm);
}

/** Broader unsafe-reservation phrasing (includes soft FP on "te confirmo disponibilidad"). */
export function containsUnsafeReservationClaim(reply: string): boolean {
  return containsPaymentDetailLeak(reply)
    || containsFalseReservationClaim(reply)
    || /\bconfirmo\s+(?:la\s+)?(?:fecha|disponibilidad|cupo)\b(?![\s\S]{0,30}\b(?:limitad[ao]|dentro\s+de\s+las|poc[ao]|escas[ao]|sujet[ao]|[ea]st[aá]))/i.test(reply)
    || /\bconfirmo la fecha\b[\s\S]{0,60}\b\d{1,2}\s+de\s+\w+/i.test(reply)
    || /(?:listo|perfecto|dale|bueno),?\s*\w+[.,]\s*me\s+(?:encanta|gusta)\s+el\s+plan\b[^.!?]{0,200}\bconfirmo\b/i.test(reply);
}

export function containsPromptLeakOrPolicyViolation(reply: string): boolean {
  const norm = normalizeText(reply);

  const leakPatterns = [
    /\bSALES CONTEXT\b/i,
    /\bBUSINESS CONTEXT\b/i,
    /\bFASE [0-5]\b/i,
    /\bPHASE [0-5]\b/i,
    /\bsystem prompt\b/i,
    /\binstrucciones del sistema\b/i,
    /\bLO QUE YA SABEMOS\b/i,
    /\bSALES[- ]SCORING\b/i,
    /\bSALES PHASE ACTUAL\b/i,
    /\bFORMATO DE RESPUESTA\b/i,
    /\bDATOS SENSIBLES\b/i,
    /\bREAL[- ]PERSON PACING\b/i,
    /\bCONVERSACION NATURAL\b/i,
    // Referent-strategy block markers. Matched against the NORMALIZED reply
    // (punctuation stripped), so these are the rendered header/label forms.
    // Referent display names are deliberately NOT matched here: they never enter
    // the prompt (enforced by `npm run validate:prompt`), and substring-matching
    // common person names would suppress legitimate replies to a customer who
    // happens to share one.
    /\bestrategias de venta principios internos\b/i,
    /\bESTRATEGIA (?:PRINCIPAL|COMPLEMENTARIA)\b/i,
    /\bkeyPoints?\b/i,
  ];
  if (leakPatterns.some(p => p.test(norm))) return true;

  if (/\bdescuento\b/i.test(norm)
    && !/\b(no hay|no tenemos|no ofrecemos|sin descuento|ningun descuento)\b/i.test(norm)) {
    return true;
  }

  if (/\bgratis\b/i.test(norm)
    && !/\b(no es|no son|no incluye|gratuito|gratuita)\b/i.test(norm)) {
    return true;
  }

  return false;
}

function isInternalDateToken(raw: string): boolean {
  return raw === 'tentative_unknown' || raw.startsWith('_relative_ordinal_');
}

function humanizeDate(raw: string, lang: 'es' | 'en', fb: FallbackReplies['es']): string | null {
  if (isInternalDateToken(raw)) {
    return fb.internalDatePending;
  }
  return lang === 'es' ? `para ${raw}` : `for ${raw}`;
}

/** Locale-aware people count with correct singular/plural ("1 persona" / "2 people"). */
export function peopleLabel(n: number, lang: 'es' | 'en'): string {
  if (lang === 'es') return n === 1 ? '1 persona' : `${n} personas`;
  return n === 1 ? '1 person' : `${n} people`;
}

export function qualificationSummary(q: MergedQualification, lang: 'es' | 'en', fb: FallbackReplies['es']): string {
  const parts: string[] = [];
  if (q.personas != null) {
    parts.push(peopleLabel(Number(q.personas), lang));
  }
  if (q.fecha != null) {
    const human = humanizeDate(String(q.fecha), lang, fb);
    if (human) parts.push(human);
  }
  if (q.transporte === 'public_bus') parts.push(lang === 'es' ? 'con bus por su cuenta' : 'with public bus on their own');
  else if (q.transporte === 'from_bogota') parts.push(lang === 'es' ? 'con transporte desde Bogota' : 'with transport from Bogota');
  else if (q.transporte != null) parts.push(lang === 'es' ? 'con transporte propio' : 'with own transport');
  if (q.mascota === 'yes') parts.push(lang === 'es' ? 'con mascota' : 'with pet');
  return parts.length > 0 ? parts.join(', ') : (lang === 'es' ? 'tus datos' : 'your details');
}

export function safeReservationHandoff(q: MergedQualification, fb: FallbackReplies['es'], lang: 'es' | 'en', now: Date = new Date()): string {
  const period = colombiaBusinessHoursPeriod(now);
  if (period !== 'business') {
    const template = period === 'night'
      ? fb.safeReservationHandoffAfterHours
      : fb.safeReservationHandoffMorningHours;
    return template
      .replace('{{name}}', String(q.nombre ?? ''))
      .replace('{{summary}}', qualificationSummary(q, lang, fb));
  }
  const variants = [fb.safeReservationHandoff, fb.safeReservationHandoffAlt1, fb.safeReservationHandoffAlt2];
  const template = variants[Math.floor(now.getTime() / 1000) % variants.length];
  return template
    .replace('{{name}}', String(q.nombre ?? ''))
    .replace('{{summary}}', qualificationSummary(q, lang, fb));
}

function experienceSummary(skills: Skills): string {
  return getActiveExperience(skills).shortDescription ?? '';
}

function itinerarySummary(skills: Skills, lang: 'es' | 'en'): string {
  const questions = getCommonQuestions(getActiveExperience(skills));
  const activities = questions.find(q => q.lang === lang && q.intent === 'activities')?.answer;
  const arrival = questions.find(q => q.lang === lang && q.intent === 'arrival')?.answer;
  return [activities, arrival].filter(Boolean).join(' ');
}

export function itineraryReply(q: MergedQualification, fb: FallbackReplies['es'], skills: Skills, lang: 'es' | 'en'): string {
  return fb.itineraryReply
    .replace('{{name}}', String(q.nombre ?? ''))
    .replace('{{itinerarySummary}}', itinerarySummary(skills, lang))
    .trim();
}

export function buildFallbackReply(
  q: MergedQualification,
  lastMessage: string,
  lang: 'es' | 'en',
  repos: Repositories,
  phone: string,
  skills: Skills,
): string {
  const fb = skills.fallbackReplies[lang];

  if (isCorrectionMessage(lastMessage)) {
    const name = String(q.nombre ?? '');
    if (!isQualificationComplete(q)) {
      const nextQ = nextQualificationQuestion(q, fb);
      return fb.disculpaYaDicho.replace('{{name}}', name).replace('{{continuation}}', nextQ.replace(/^[^,]+, /, '').toLowerCase());
    }
    const priceRow = repos.conversation.getPriceGivenAt(phone);
    if (priceRow) {
      return fb.disculpaYaDicho.replace('{{name}}', name).replace('{{continuation}}', fb.confirmReservationPrompt);
    }
    return fb.disculpaYaDicho.replace('{{name}}', name).replace('{{continuation}}', fb.repairPricePresented.replace('{{name}}', name).toLowerCase());
  }

  if (!isQualificationComplete(q)) {
    if (hasActionableUserQuestion(lastMessage)) {
      if (asksItinerary(lastMessage)) return itineraryReply(q, fb, skills, lang);
      return fb.answerQuestionBeforeQualification;
    }
    return nextQualificationQuestion(q, fb);
  }

  const priceGiven = repos.conversation.getPriceGivenAt(phone);
  if (!priceGiven) {
    const name = String(q.nombre ?? '');
    repos.conversation.setPriceGiven(phone);
    const items = getActiveExperience(skills).pricing.items;
    const coupleItem = items.find((i) => i.id === 'couple');
    if (coupleItem?.couplePrice == null) return fb.aiFailureQualified;
    const couplePriceFormatted = coupleItem.couplePrice.toLocaleString('en-US');
    return fb.repairPriceNotPresented
      .replace('{{name}}', name)
      .replace('{{couplePrice}}', couplePriceFormatted)
      .replace('{{experienceSummary}}', experienceSummary(skills));
  }

  const name = String(q.nombre ?? '');
  return fb.objectionResolvedContinue.replace('{{name}}', name);
}

const emojiSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function countEmojis(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (const segment of emojiSegmenter.segment(text)) {
    if (/\p{Extended_Pictographic}/u.test(segment.segment)) count += 1;
  }
  return count;
}

/**
 * Distinct emoji graphemes in `text`, in first-appearance order.
 *
 * Grapheme-based like `countEmojis`, so a ZWJ sequence (family) or a VS16 glyph
 * stays one entry instead of decomposing into its parts. Used to tell the model
 * which glyphs a thread already spent, so it stops defaulting to the same one.
 */
export function extractEmojis(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const segment of emojiSegmenter.segment(text)) {
    if (/\p{Extended_Pictographic}/u.test(segment.segment)) seen.add(segment.segment);
  }
  return [...seen];
}

/**
 * Drop payment-move clauses when no holdable date exists. Keeps plan/price summary
 * on partner-pause turns instead of hard-failing the whole reply into a holding line.
 */
export function stripPaymentMoveWithoutDate(reply: string): string {
  if (!reply.trim()) return reply;
  const clause = /[^.!?\n]*(?:\banticipo\b|\bdep[oó]sito\b|\babono\b|\bnequi\b|\bmercado\s*pago\b|\bdeposit\b|\bdown\s+payment\b)[^.!?\n]*[.!?]?/gi;
  const stripped = reply
    .replace(clause, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
  return stripped.length >= 12 ? stripped : reply;
}

/** Remove pictographic emoji graphemes. Used only on payment/close turns. */
export function stripEmojis(text: string): string {
  if (!text || countEmojis(text) === 0) return text;
  let out = '';
  for (const segment of emojiSegmenter.segment(text)) {
    if (/\p{Extended_Pictographic}/u.test(segment.segment)) continue;
    out += segment.segment;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
}

/**
 * Price/payment/close turns must stay emoji-free. Prompt alone is flaky; this is a
 * post-LLM strip guard (same class as handoff/leak strips), not sales-copy rewrite.
 */
export function stripEmojisOnPaymentClose(
  reply: string,
  opts: { movesToPayment?: boolean; mentionsPrice?: boolean },
): string {
  if (countEmojis(reply) === 0) return reply;
  if (!opts.movesToPayment && !opts.mentionsPrice) return reply;
  return stripEmojis(reply);
}

/** Log-only when strip is not applied. Covers price overuse outside payment CTA. */
export function logEmojiStyle(
  reply: string,
  ctx: { phone: string; salesPhase?: string; mentionsPrice?: boolean; movesToPayment?: boolean },
): number {
  const count = countEmojis(reply);
  if (count === 0) return 0;
  const inBannedContext = Boolean(ctx.mentionsPrice || ctx.movesToPayment);
  if (count > 1 || inBannedContext) {
    logger.info(
      {
        phone: ctx.phone,
        emojiCount: count,
        salesPhase: ctx.salesPhase,
        mentionsPrice: ctx.mentionsPrice,
        movesToPayment: ctx.movesToPayment,
      },
      '[BOT] emoji style diagnostic',
    );
  }
  return count;
}

/** Log-only readability diagnostic. Never edits reply. */
export function logReplyStyle(
  reply: string,
  ctx: { phone: string; salesPhase?: string },
): void {
  const chars = reply.length;
  const blocks = reply.split(/\n\s*\n/).length;
  
  // Find longest sentence (by word count)
  const sentences = reply.split(/[.!?]+/).filter(s => s.trim().length > 0);
  let longestSentenceWords = 0;
  for (const sent of sentences) {
    const words = sent.trim().split(/\s+/).length;
    if (words > longestSentenceWords) longestSentenceWords = words;
  }
  
  // Count bold markers
  const boldCount = (reply.match(/\*[^*]+\*/g) ?? []).length;
  
  // Check for ack opener
  const ackTokens = ['perfecto', 'buena elección', 'listo', 'sin problema', 'entendido', 'claro'];
  const startsWithAck = ackTokens.some(t => reply.toLowerCase().startsWith(t));
  
  // Check for mixed register (tú + ustedes in same message)
  const hasTu = /\bte\b|\bvos\b|\bvos\b|\btu\s/.test(reply.toLowerCase());
  const hasUstedes = /\bustedes\b|\blos\b|\blas\b|\bsu\s/.test(reply.toLowerCase());
  const mixedRegister = hasTu && hasUstedes;
  
  const shouldLog = 
    longestSentenceWords > 15 || 
    boldCount > 1 || 
    startsWithAck ||
    mixedRegister ||
    blocks > 2;
    
  if (shouldLog) {
    logger.info(
      {
        phone: ctx.phone,
        salesPhase: ctx.salesPhase,
        chars,
        blocks,
        longestSentenceWords,
        boldCount,
        startsWithAck,
        mixedRegister,
      },
      '[BOT] reply style diagnostic',
    );
  }
}

/**
 * The model announced photos it never marked, so the customer is promised media
 * that will never arrive. Plural address (les/le/se) + sending verb also triggers;
 * "Ahí van las/unas" covers "Ahí van las de la mina" (observed live). "te comparto
 * la ruta" stays unmatched — that is a legitimate factual reply.
 *
 * The object pronoun may also sit BEFORE the verb ("te las mando de nuevo", live
 * `consecutive-gallery-requests` turn 3): the noun is elided because the customer
 * just named it, so nothing after the verb identifies photos. That form promised a
 * resend and shipped zero images without tripping any guard. A bare repeat adverb
 * qualifies only in that proclitic shape, and the caller still gates the alert on a
 * resolved gallery theme, so "te lo mando de nuevo" about a non-photo stays quiet.
 */
const PHOTO_PROMISE =
  /\b(?:(?:te|le|les)\s+(?:los|las)\s+(?:comparto|mando|env[ií]o|paso|dejo)\s+(?:de\s+nuevo|otra\s+vez|nuevamente|again)|(?:(?:te|le|les|se\s+(?:lo|la|los|las))\s+(?:comparto|mando|env[ií]o|paso|dejo)|(?:ac[áa]|aqu[íi]|ah[íi])\s+(?:te\s+|le\s+|les\s+)?van|mir[áa]\s+est[ao]s|here\s+are|sending\s+you)\s+(?:[^.?!]{0,50}?\b(?:fotos?|im[áa]gen(?:es)?|photos?|pics?)\b|(?:más|otras?)(?=\s+(?:para\s+que|por\s+aqu[íi]|ahora)\b|[.!?]|$)|(?:más|otras?)\s+(?:de\s+)?(?:la|del|los|las)\b|(?:(?:también|tambien|ya|ahora)\s+)?(?:las|los|la|el)\s+(?:del?|de\s+(?:la|los|las|el))\b|(?:(?:también|tambien|ya|ahora)\s+)?(?:unas|unos|algunas|algunos|varias|varios|a\s+few|some)\b))/i;

export function hasUnmarkedPhotoPromise(replyText: string): boolean {
  return PHOTO_PROMISE.test(replyText) && !/\[\[\s*FOTOS\b/i.test(replyText);
}

/**
 * Log-only diagnostics for a photo turn. Never edits, gates, or retries the reply:
 * the model owns the copy, so visibility is the only available defence.
 *
 * - Photos shipping → the reply must carry exactly one question, no URLs and no
 *   per-image narration (`whatsapp-sales.skill.md` §GALERIA).
 * - No photos shipping → the reply must not promise any.
 */
export function diagnosticMediaReply(
  replyText: string,
  requestedMediaCount: number,
  phone: string,
): void {
  if (requestedMediaCount <= 0) {
    if (hasUnmarkedPhotoPromise(replyText)) {
      logger.warn(
        { phone, replyLen: replyText.length },
        '[MEDIA_REQUEST] reply promises photos but emitted no media marker',
      );
    }
    return;
  }

  const questionCount = (replyText.match(/\?/g) ?? []).length;
  const hasUrls = /https?:\/\//.test(replyText);
  const hasImageList = /Foto\s+\d+:|Imagen\s+\d+:|Picture\s+\d+:/i.test(replyText);

  if (questionCount !== 1 || hasUrls || hasImageList) {
    logger.warn(
      {
        phone,
        questionCount,
        hasUrls,
        hasImageList,
        replyLen: replyText.length,
      },
      '[MEDIA_REQUEST] reply format diagnostic',
    );
  }
}
