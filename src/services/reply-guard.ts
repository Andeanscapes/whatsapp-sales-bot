import type { Repositories } from '../db/repositories/index.js';
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
  return /\b(no gracias|por ahora no|no me interesa|dejemoslo|dejemoslo ahi|en otro momento|otra oportunidad|muy caro|esta caro|algo caro|me parece caro|se sale del presupuesto|no me alcanza|fuera de presupuesto|costoso|caro|gracias por la info|por el momento no|lo dejamos ahi|no por ahora|lo voy a pensar|mejor no|paso por ahora|lo dejo ahi|no es para mi|no es lo que busco|no me convence|no es lo que esperaba|muy costoso|carisimo|cuesta mucho|es mucho|se me va de presupuesto|no tengo esa plata|no tengo presupuesto|no llego|no me da|luego te contacto|luego te escribo|not now|not interested|too expensive|out of budget|not in my budget|thank you for the info|for now no|not for me|not what i expected|i'?ll pass|i'?ll think about it|too much|over budget|can'?t afford|i'?ll skip|i have to decline|no thanks anyway|thanks anyway|gracias de todos modos|gracias igual|gracias de todas formas)\b/i.test(norm);
}

export function isGalleryRequest(text: string): boolean {
  const norm = normalizeText(text);
  return /\b(foto|fotos|imagen|imagenes|im[aá]genes|photo|photos|picture|pictures)\b/i.test(norm)
    && /\b(experiencia|mina|minera|minero|hacienda|recorrido|chivor|experience|mine|farm)\b/i.test(norm);
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

export function isReEngagementMessage(text: string): boolean {
  const norm = normalizeText(text);
  const raw = text.trim();
  if (/^\s*[?¿]+\s*$/.test(raw)) return true;
  return /\b(despu[eé]s de pensar|lo pens[eé]|volv[ií]|bueno|me interesa|own|cu[aá]l es|cont[aá]me|de nuevo|cambiaste|reconsider|lo habl[eé]|lo consult[eé]|ya decid[ií]|estoy listo|listo|aqu[ií] estoy|estoy de vuelta|retomo|retomamos|seguimos|continuamos|dale|vamos|hag[aá]moslo|s[ií] quiero|me convenc[ií]|mejor dicho|i'?m back|i'?m ready|let'?s go|i decided|i talked about it|i consulted|i'?m in|i want to|let'?s continue|following up|touching base|checking in|after thinking|changed my mind|reconsidered|actually yes|actually i do|you know what|on second thought)\b/i.test(norm)
    || /\b(hola|hello|hi|buenas|hey|saludos|buen dia|buenos dias|buenas tardes|buenas noches|good morning|good afternoon|good evening|cuanto es|cuanto vale|cuanto cuesta|precio|how much|price|cual es el precio|cual es el valor|cual es el costo)\b/i.test(norm);
}

export function isPartnerConsultPause(text: string): boolean {
  const norm = normalizeText(text);
  return /\b(?:consulto|consultarlo|consultar[eé]|validar|valido|validarlo|revisar|reviso|revisarlo|mirar|miro|mirarlo|hablar|hablo|hablarlo|lo pienso|pensar|pensarlo|pensar[eé]|dejame|dame tiempo|sin afan|chequear|chequeo|lo chequeo|comentar|comento|lo comento|consultar|lo consulto|se lo digo|preguntar|pregunto|le pregunto|mostrar|muestro|le muestro|ense[ñn]ar|le ense[ñn]o|le paso)\b[\s\S]{0,80}\b(?:pareja|esposa|esposo|novia|novio|familia|acompanante|acompa[ñn]ante|partner|wife|husband|girlfriend|boyfriend|family|ella|el|con ella|con el|mi gente|mis papas|mis viejos|mis padres|ellos|ellos|with her|with him|my folks|my partner|my parents|my family)\b/i.test(norm)
    || /\b(?:pareja|esposa|esposo|novia|novio|familia|acompanante|acompa[ñn]ante|partner|wife|husband|girlfriend|boyfriend|family|ella|el|con ella|con el|mi gente|mis papas|mis viejos|mis padres|ellos|they|with her|with him|my folks|my partner|my parents|my family)\b[\s\S]{0,80}\b(?:consulto|consultarlo|consultar[eé]|validar|valido|validarlo|revisar|reviso|revisarlo|mirar|miro|mirarlo|hablar|hablo|hablarlo|lo pienso|pensar|pensarlo|pensar[eé]|chequear|chequeo|lo chequeo|comentar|comento|lo comento|consultar|lo consulto|se lo digo|preguntar|pregunto|le pregunto|mostrar|muestro|le muestro|ense[ñn]ar|le ense[ñn]o)\b/i.test(norm);
}

export function detectsReservationIntent(text: string): boolean {
  const norm = normalizeText(text);
  const patterns = [
    /quiero (reservar|pagar|agendar|separar|apartar)/,
    /me gustaria (reservar|pagar|agendar|separar|apartar)(?: ya)?/,
    /(como|donde) se (reserva|paga|agenda|separa|aparta)/,
    /(como|donde) (reservo|pago|reservar|pagar|transfiero|consigno)/,
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

export function isReservationIntentOrConfirmation(
  message: string,
  lastAssistantQuestion: string | null,
): boolean {
  if (detectsReservationIntent(message)) return true;

  const norm = normalizeText(message);
  const shortAffirmation = /^\s*(s[ií]p?i?|yes|yeah|yep|yup|ok|okay|okey|listo|dale|dele|bueno|vamos|perfecto|perfect|de una|de acuerdo|claro|clarines|vale|genial|excelente|obvio|hecho|confirmo|confirmado|reservamos|reservemos|apartemos|separo|por supuesto|ya|let'?s do it|let'?s go|let'?s book|sure|for sure|alright|all right|absolutely|definitely|great|awesome|deal|done|of course|why not|i'?m in|count me in|go ahead|sounds good|sounds great|sounds perfect|works for me|fine by me|go for it)\b/i;
  if (!shortAffirmation.test(norm)) return false;
  if (!lastAssistantQuestion) return false;

  const questionNorm = normalizeText(lastAssistantQuestion);
  const reservationQuestionPatterns = [
    /(?:te gustar[ií]a reservar|quieres reservar|reservamos|agendamos|apartamos)/,
    /(?:would you like to book|shall we book|want to reserve)/,
    /(?:qu[eé] te parece|te encaja|es lo que buscabas|te suena|te interesa)/,
    /(?:what do you think|does that work|interested|sound good)/,
    /(?:quieres que revisemos|validamos disponibilidad|confirmamos)/,
    /(?:revision de reserva|dejarlo para revision|lo dejemos para revision|pasarlo al equipo|paso (?:esto |todo )?al equipo)/,
    /(?:want (?:me|us) to check|shall (?:I|we) check availability)/,
    /(?:listo para|preparado para|ready to)/,
    /(?:inicie esa validacion|inicie la validacion|quieres que inicie|quieres que la inicie)/,
    /(?:shall i start that validation|shall i start it|start it now|want me to start)/,
    /(?:separamos con anticipo|reserva se separa|booking is held with)/,
  ];
  return reservationQuestionPatterns.some(p => p.test(questionNorm));
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
  ];
  return tests.some(p => p.test(reply));
}

export function stripSelfIntro(reply: string, qualFieldCount: number): string {
  if (qualFieldCount < 2) return reply;
  const sanitized = reply.replace(/\b(?:Hola!?\s*)?(?:Soy\s+\w+,?\s*)?(?:co[- ]?(?:founder|fundador)[^.!?]*\.?\s*)/gi, '');
  return sanitized.trim() || reply;
}

export function detectProactiveLeadPain(message: string): LeadPain | null {
  const norm = message.toLowerCase().trim();
  if (/\b(muy caro|esta caro|algo caro|costoso|fuera de presupuesto|no me alcanza|no me da|expensive|too expensive|over budget|can'?t afford)\b/i.test(norm)) return 'price';
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

export function stripHandoffPhrases(reply: string): string {
  return reply.replace(HANDOFF_PHRASE_GLOBAL_REGEX, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function isPaymentMethodsQuestion(text: string): boolean {
  const norm = normalizeText(text);
  return (
    /\b(metodos? de pago|medios? de pago|formas? de pago|como se paga|como pago|con que pago|nequi|mercado pago|anticipo|deposito|abono)\b/i.test(norm)
    || /\b(payment methods?|how (can|do) i pay|how to pay|deposit|down payment|nequi|mercado pago)\b/i.test(norm)
  );
}

export function containsUnsafeReservationClaim(reply: string): boolean {
  const norm = normalizeText(reply);
  return /\[[^\]]*(inserte|insert|numero|número|payment|pago)[^\]]*\]/i.test(reply)
    || /\b(nequi|mercado pago)\b[\s\S]{0,80}\b\d{7,}\b/i.test(reply)
    || /\b(nequi|mercado pago)\b[\s\S]{0,120}\b(https?:\/\/|wa\.me|bit\.ly)\b/i.test(reply)
    || /\b(transfiere|transfer|envia al|send to|numero|n[uú]mero)\b[\s\S]{0,80}\b(nequi|mercado pago|\d{7,})\b/i.test(reply)
    || /\b(puedo separarte|queda reservado|te separo|separamos el cupo)\b[\s\S]{0,100}\b(?:\d{1,2}\s+de\s+\w+|\d{4}-\d{2}-\d{2}|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|cupo|fecha)\b/i.test(reply)
    || /\b(ya esta confirmado|ya tienes cupo|te confirmo el cupo|tienes cupo|separado|reservado para ti|tu reserva esta|tu reserva qued[oó])\b/i.test(reply)
    || /\b(fecha confirmada|confirmo la fecha|disponibilidad confirmada)\b[\s\S]{0,60}\b\d{1,2}\s+de\s+\w+/i.test(reply)
    || /\b(ya quedo|quedaste|estas|ya estas)\s+(reservado|apartado|separado|confirmado|agendado)\b/i.test(reply)
    || /\b(listo,? ya|ya,? listo)\s*(?:esta|qued[oó]|confirmado|reservado|agendado|separado)\b/i.test(reply)
    || /\bconfirmo\s+(?:la\s+)?(?:fecha|disponibilidad|cupo)\b(?![\s\S]{0,30}\b(?:limitad[ao]|dentro\s+de\s+las|poc[ao]|escas[ao]|sujet[ao]|[ea]st[aá]))/i.test(reply)
    || /\bte\s+(?:env[ií]o|mando|paso|doy)\s+(?:los\s+)?(?:datos|n[uú]meros?|link|info|informaci[oó]n)\b/i.test(reply)
    || /(?:listo|perfecto|dale|bueno),?\s*\w+[.,]\s*me\s+(?:encanta|gusta)\s+el\s+plan\b[^.!?]{0,200}\bconfirmo\b/i.test(reply)
    || /\btu reserva quedo confirmad[ao]\b/i.test(norm);
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
  else if (q.transporte != null) parts.push(lang === 'es' ? 'con transporte propio' : 'with your own transport');
  if (q.mascota != null) parts.push(lang === 'es' ? 'con mascota' : 'with pet');
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
