import type Database from 'better-sqlite3';
import { getSkills, type FallbackReplies } from './skill-loader.js';
import { scoreMessage } from './lead-scoring.js';
import { isOptedOut, setOptOut } from './opt-out-service.js';
import { addMessage, getRecentMessages, upsertConversation } from './conversation-store.js';
import { checkTimeWindow } from './time-window-policy.js';
import { canSendImage } from './media-service.js';
import { checkBudget } from './budget-guard.js';
import { detectLanguageOrNull, normalizeText, type SupportedLanguage } from './language-service.js';
import {
  buildSystemPrompt,
  callDeepSeek,
  recordAiUsage,
} from './deepseek-client.js';

export interface ProcessMessageInput {
  db: Database.Database;
  customerPhone: string;
  message: string;
  messageId?: string;
}

export interface ProcessMessageOutput {
  reply: string;
  shouldSendReply: boolean;
  leadScore: number;
  usedAi: boolean;
  shouldAlertOwner: boolean;
  shouldSendImage: boolean;
}

const OPT_OUT_KEYWORDS_ES = ['detener', 'cancelar mensajes', 'no me escriban'];
const OPT_OUT_KEYWORDS_EN = ['stop', 'unsubscribe', 'no more messages'];
const ALL_OPT_OUT_KEYWORDS = [...OPT_OUT_KEYWORDS_ES, ...OPT_OUT_KEYWORDS_EN];

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

const NAME_PATTERNS = [
  /soy ([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+)/i,
  /me llamo ([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+)/i,
  /mi nombre es ([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+)/i,
  /i am ([A-Z][a-z]+)/i,
  /my name is ([A-Z][a-z]+)/i,
];

const NAME_BLACKLIST = /^(?:hola|buenas|hello|hi|hey|ok|si|no|yes|ya|gracias|thanks|quiero|cual|como|cuanto|donde|cuando|que|qué|cual|cuál|precio|itinerario|agenda|actividades|what|how|where|when|porque|por qu[eé]|me|te|se|el|la|los|las|es|own|solo|sola|bien|listo)$/i;

const TRANSPORT_OWN_PATTERNS = [
  /\b(?:veh[ií]culo propio|carro propio|moto|moto propia|vamos en (?:carro|moto|auto)|tenemos (?:carro|moto|auto|veh[ií]culo)|transporte propio|transporte si|si tenemos)\b/i,
  /\b(?:propio transporte|transporte propio|coche propio|no necesitamos transporte|nosotros manejamos|manejamos|si propio|yo manejo|manejo)\b/i,
  /\b(?:we have (?:our own|a) (?:car|motorcycle|vehicle|transport|truck)|own transport|driving ourselves|yes own|i have (?:my )?own)\b/i,
];

const TRANSPORT_OWN_CONTEXT_PATTERNS = [
  /\b(?:si|s[ií])\b.*\b(?:propio|tengo|tenemos|transporte)\b/i,
  /\b(?:propio|tengo carro|tengo moto|tengo veh[ií]culo|en carro|en moto|manejando)\b/i,
  /\b(?:yes|yeah|yep)\b.*\b(?:own|have (?:a |my )?(?:car|transport|vehicle|ride))\b/i,
  /\b(?:i (?:have|drive) (?:a |my own )?(?:car|motorcycle|vehicle))\b/i,
];

const PET_KEYWORDS = /\b(?:perro|perrito|mascota|mascotas|gato|gatos|perra|perros|gatito|pet|dog|cat|dogs|cats|puppy|kitten)\b/i;

function extractBookingFields(text: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  const monthInText = MONTH_NAMES.find(m => text.toLowerCase().includes(m));
  if (monthInText) fields.collected_date = monthInText;

  const peopleMatch = text.match(/(\d+)\s*(?:people|person|persons|personas|pax)/i);
  if (peopleMatch) fields.collected_people = parseInt(peopleMatch[1], 10);

  const simpleNumberMatch = text.match(/\b(?:somos|van|vamos|seriamos|serian|somos como|van como)\s+(\d+)\b/i);
  if (simpleNumberMatch && !fields.collected_people) {
    fields.collected_people = parseInt(simpleNumberMatch[1], 10);
  }

  const couplePattern = /\b(?:couple|pareja|dos personas|2 personas|mi esposo y yo|mi esposa y yo|mi novio y yo|mi novia y yo|mi pareja y yo|mi hija y yo|mi hijo y yo|vamos dos|somos dos|somos 2|vamos 2)\b/i;
  if (couplePattern.test(text) && !fields.collected_people) {
    fields.collected_people = 2;
  }

  if (/\b(?:sola|solo|voy sola|voy solo|ir[ií]a sola|ir[ií]a solo|yo sola|yo solo|una persona|1 persona|just me|only me|me alone|solo traveler)\b/i.test(text) && !fields.collected_people) {
    fields.collected_people = 1;
  }

  const tresPeople = /\b(?:tres personas|3 personas|mis dos hijos|mi esposa y mi hijo|mi esposo y mi hija|somos tres|somos 3)\b/i;
  if (tresPeople.test(text) && !fields.collected_people) {
    fields.collected_people = 3;
  }

  for (const p of NAME_PATTERNS) {
    const m = text.match(p);
    if (m && m[1].length >= 2 && m[1].length <= 20) {
      const name = m[1];
      if (!NAME_BLACKLIST.test(name)) {
        fields.collected_name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
        break;
      }
    }
  }

  for (const p of TRANSPORT_OWN_PATTERNS) {
    if (p.test(text)) {
      fields.collected_transport_need = 'own';
      break;
    }
  }

  if (/transport|pickup|transporte|recoger|Bogotá|Bogota/i.test(text)) {
    if (!fields.collected_transport_need) {
      fields.collected_transport_need = 'yes';
    }
  }

  if (/\b(?:bus|terminal|salitre|transporte p[uú]blico|public bus|public transport)\b/i.test(text)) {
    fields.collected_transport_need = 'public_bus';
  }

  if (/lodging|hotel|stay|overnight|hospedaje|alojamiento/i.test(text)) {
    fields.collected_lodging_need = 'yes';
  }

  if (PET_KEYWORDS.test(text)) {
    fields.collected_pet = 'yes';
  }

  return fields;
}

interface MergedQualification {
  nombre?: unknown;
  personas?: unknown;
  fecha?: unknown;
  transporte?: unknown;
  mascota?: unknown;
}

function isQualificationComplete(q: MergedQualification): boolean {
  return q.nombre != null && q.personas != null && q.fecha != null && q.transporte != null;
}

function nextQualificationQuestion(q: MergedQualification, fb: FallbackReplies['es']): string {
  if (q.nombre == null) return fb.askName;
  if (q.personas == null) return fb.askPeople;
  if (q.fecha == null) return fb.askDate;
  return fb.askTransport;
}

function isCorrectionMessage(text: string): boolean {
  const norm = normalizeText(text);
  return /ya (te |lo )?(dije|mencione|habia dicho|habia digo|habia mencionado|lo he dicho)/i.test(norm)
    || /ya (lo |te )?dije/i.test(norm)
    || /(i already|already) (told|said|mentioned)/i.test(norm);
}

function extractStandaloneName(text: string): string | null {
  const cleaned = text.trim().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const first = cleaned.split(' ')[0];
  if (!first || first.length < 2 || first.length > 20 || NAME_BLACKLIST.test(first)) return null;
  if (!/^[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+$/u.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function hasActionableUserQuestion(text: string): boolean {
  const norm = normalizeText(text);
  return /(como se reserva|reserva|reservar|itinerario|a que hora|hora debo llegar|hora de llegada|llegar|agenda|cronograma|que incluye|donde deberiamos llegar|como se llega|como llego|se puede hacer en 1 dia|one day|puede ser un solo dia|solo 1 dia)/i.test(norm);
}

function asksItinerary(text: string): boolean {
  const norm = normalizeText(text);
  return /(itinerario|a que hora|hora debo llegar|hora de llegada|como seria|como es el itinerario|no me dijiste|agenda|cronograma)/i.test(norm);
}

function isGenericConversionReply(reply: string): boolean {
  const norm = normalizeText(reply);
  return /me alegra que estes bien|quieres que revisemos disponibilidad|te gustaria reservar|que te parece|glad you(?:'re|\s+are) comfortable|would you like (?:us|me) to check|shall we (?:check|book)/.test(norm);
}

function isUserConfusedOrRepeating(text: string): boolean {
  const norm = normalizeText(text);
  return /^\s*\??\s*$/i.test(norm) || /\b(que pasa|what|no entiendo|expl[ií]cate|repite|again|no me dijiste)\b/i.test(norm);
}

export function isTruncatedReply(reply: string): boolean {
  const trimmed = reply.trim();
  return trimmed.endsWith('Desde') || trimmed.endsWith('desde')
    || trimmed.endsWith('para') || trimmed.endsWith('en el')
    || trimmed.endsWith('la') || trimmed.endsWith('un')
    || (trimmed.split(' ').length <= 2 && trimmed.length > 0 && !/[.!?]$/.test(trimmed));
}

function isSoftCloseMessage(text: string): boolean {
  const norm = normalizeText(text);
  return /\b(no gracias|por ahora no|no me interesa|dejemoslo|en otro momento|not now|not interested|maybe later)\b/i.test(norm);
}

function isAdcodeNoise(text: string): boolean {
  return /^adcode-/i.test(text.trim())
    || /^[A-Za-z0-9+/=]{40,}$/.test(text.trim());
}

function isReEngagementMessage(text: string): boolean {
  const norm = normalizeText(text);
  return /\b(despu[eé]s de pensar|lo pens[eé]|volv[ií]|bueno|me interesa|own|cu[aá]l es|cont[aá]me|de nuevo|cambiaste|reconsider)\b/i.test(norm);
}

function getLastAssistantQuestion(db: Database.Database, phone: string): string | null {
  const row = db.prepare(
    "SELECT body FROM messages WHERE customer_phone = ? AND direction = 'outbound' ORDER BY id DESC LIMIT 1"
  ).get(phone) as { body: string | null } | undefined;
  return row?.body ?? null;
}

function contextAwareExtract(message: string, db: Database.Database, phone: string, existing: Record<string, unknown>): Record<string, unknown> {
  const fields = { ...existing };
  const lastQuestion = getLastAssistantQuestion(db, phone);
  const norm = message.trim();

  if (lastQuestion && !fields.collected_people) {
    const askedPeople = /cu[aá]ntas personas|cu[aá]ntos ser[ií]an|how many people/i.test(lastQuestion);
    if (askedPeople) {
      const soloNum = /^(\d+)$/.exec(norm);
      if (soloNum) {
        fields.collected_people = parseInt(soloNum[1], 10);
      }
    }
  }

  if (lastQuestion && !fields.collected_name) {
    const askedName = /como te llamas|cual es tu nombre|con quien tengo/i.test(lastQuestion);
    if (askedName) {
      const standaloneName = extractStandaloneName(norm);
      if (standaloneName) fields.collected_name = standaloneName;
    }
  }

  if (!fields.collected_name && isCorrectionMessage(norm)) {
    const correctionName = extractStandaloneName(norm);
    if (correctionName) fields.collected_name = correctionName;
  }

  if (lastQuestion && !fields.collected_transport_need) {
    const askedTransport = /transporte propio|necesitan desde|vas (?:con|en)|own transport|pickup|Bogot[aá]|llegar desde|how (?:are you|will you) (?:getting|coming)/i.test(lastQuestion);
    if (askedTransport) {
      const hasOwn = TRANSPORT_OWN_PATTERNS.some(p => p.test(norm)) || TRANSPORT_OWN_CONTEXT_PATTERNS.some(p => p.test(norm));
      if (hasOwn) fields.collected_transport_need = 'own';
    }
  }

  if (!fields.collected_date && lastQuestion) {
    const askedDate = /fecha tentativa|what date|qu[eé] fecha/i.test(lastQuestion);
    if (askedDate) {
      const monthFound = MONTH_NAMES.find(m => norm.toLowerCase().includes(m));
      if (monthFound) fields.collected_date = monthFound;
      if (/no (lo )?s[eé]|not sure|no estoy segur|todav[ií]a no/i.test(norm)) {
        fields.collected_date = 'tentative_unknown';
      }
    }
  }

  return fields;
}

function reconstructFromHistory(db: Database.Database, phone: string, current: Record<string, unknown>): Record<string, unknown> {
  const fields = { ...current };
  const allInbound = db.prepare(
    "SELECT body FROM messages WHERE customer_phone = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT 20"
  ).all(phone) as { body: string | null }[];
  const need = {
    nombre: !fields.nombre,
    personas: !fields.personas,
    fecha: !fields.fecha,
    transporte: !fields.transporte,
    mascota: !fields.mascota,
  };
  for (const row of allInbound) {
    if (!row.body || (!need.nombre && !need.personas && !need.fecha && !need.transporte && !need.mascota)) continue;
    const extracted = extractBookingFields(row.body);
    if (need.nombre && extracted.collected_name) { fields.nombre = extracted.collected_name; need.nombre = false; }
    if (need.personas && extracted.collected_people) { fields.personas = extracted.collected_people; need.personas = false; }
    if (need.fecha && extracted.collected_date) { fields.fecha = extracted.collected_date; need.fecha = false; }
    if (need.transporte && extracted.collected_transport_need) { fields.transporte = extracted.collected_transport_need; need.transporte = false; }
    if (need.mascota && extracted.collected_pet) { fields.mascota = extracted.collected_pet; need.mascota = false; }
  }
  return fields;
}

function buildDbQualification(collected: Record<string, unknown>): MergedQualification {
  return {
    nombre: collected.nombre,
    personas: collected.personas,
    fecha: collected.fecha,
    transporte: collected.transporte,
    mascota: collected.mascota,
  };
}

export function detectsReservationIntent(text: string): boolean {
  const norm = normalizeText(text);
  const patterns = [
    /quiero (reservar|pagar|agendar|separar|apartar)/,
    /(como|donde) (reservo|pago|reservar|pagar|transfiero|consigno)/,
    /\b(lo confirmo|agendamos|separemos|reservemos|apartemos)\b/,
    /manda (los datos|el link|info para pagar|el numero)/,
    /(envia|enviame) (los datos|el link|info para pagar)/,
    /vamos a reservar/,
    /listo para (reservar|pagar)/,
    /\b(nequi|mercado pago|deposito|depositar|depositar por|15%)\b/,
    /\b(pago por|pagar por|prefiero) (nequi|mercado pago)\b/,
    /^\s*(si esa|sí esa|esa|esa fecha|confirmo|de una)\s*[.!?]*\s*$/,
    /\bquedo (reservado|apartado|separado)\b/,
    /i want to (book|reserve|pay)/,
    /how can i (make )?(a )?reservation/,
    /how can i (book|reserve|pay)/,
    /(how|where) (do i|to) (book|reserve|pay)/,
    /\b(let'?s book|book it|let'?s do it)\b/,
    /send (me )?(the )?(payment|booking) (link|info|details)/,
    /\b(nequi|mercado pago|deposit|payment method|pay by)\b/,
  ];
  return patterns.some(p => p.test(norm));
}

export function isReservationIntentOrConfirmation(
  message: string,
  lastAssistantQuestion: string | null,
): boolean {
  if (detectsReservationIntent(message)) return true;

  const norm = normalizeText(message);
  const shortAffirmation = /^\s*(si|s[ií]|yes|ok|listo|dale|bueno|vamos|perfecto|de una|de acuerdo|claro|let'?s do it|sure|alright)\s*[.!?]*\s*$/i;
  if (!shortAffirmation.test(norm)) return false;
  if (!lastAssistantQuestion) return false;

  const questionNorm = normalizeText(lastAssistantQuestion);
  const reservationQuestionPatterns = [
    /(?:te gustar[ií]a reservar|quieres reservar|reservamos|agendamos|apartamos)/,
    /(?:would you like to book|shall we book|want to reserve)/,
    /(?:qu[eé] te parece|te encaja|es lo que buscabas|te suena|te interesa)/,
    /(?:what do you think|does that work|interested|sound good)/,
    /(?:quieres que revisemos|validamos disponibilidad|confirmamos)/,
    /(?:want (?:me|us) to check|shall (?:I|we) check availability)/,
    /(?:listo para|preparado para|ready to)/,
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
  ];
  return tests.some(p => p.test(reply));
}

const HANDOFF_PHRASE_REGEX = /(dame unos minuticos[^.]*equipo de reservas[^.]*\.?)|(give me a few minutes[^.]*reservations team[^.]*\.?)/i;
const HANDOFF_PHRASE_GLOBAL_REGEX = /(dame unos minuticos[^.]*equipo de reservas[^.]*\.?)|(give me a few minutes[^.]*reservations team[^.]*\.?)/gi;

export function containsHandoffPhrase(reply: string): boolean {
  return HANDOFF_PHRASE_REGEX.test(reply);
}

export function stripHandoffPhrases(reply: string): string {
  return reply.replace(HANDOFF_PHRASE_GLOBAL_REGEX, '').replace(/\n{3,}/g, '\n\n').trim();
}

function containsUnsafeReservationClaim(reply: string): boolean {
  return /\[[^\]]*(inserte|insert|numero|número|payment|pago)[^\]]*\]/i.test(reply)
    || /\b(nequi|mercado pago)\b[\s\S]{0,80}\b\d{7,}\b/i.test(reply)
    || /\b(dep[oó]sito|deposit|pago|payment)\b[\s\S]{0,80}\b(nequi|mercado pago)\b/i.test(reply)
    || /\b(fecha disponible|available date|cupo disponible|tenemos cupo|tenemos listado|puedo separarte|queda reservado|te separo|separamos el cupo)\b[\s\S]{0,100}\b(?:\d{1,2}\s+de\s+\w+|\d{4}-\d{2}-\d{2}|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|cupo|fecha)\b/i.test(reply);
}

function qualificationSummary(q: MergedQualification, lang: 'es' | 'en'): string {
  const parts: string[] = [];
  if (q.personas != null) parts.push(lang === 'es' ? `${q.personas} personas` : `${q.personas} people`);
  if (q.fecha != null) parts.push(String(q.fecha));
  if (q.transporte === 'public_bus') parts.push(lang === 'es' ? 'bus por cuenta del cliente' : 'public bus paid by customer');
  else if (q.transporte != null) parts.push(lang === 'es' ? 'transporte propio' : 'own transport');
  if (q.mascota != null) parts.push(lang === 'es' ? 'mascota' : 'pet');
  return parts.length > 0 ? parts.join(', ') : (lang === 'es' ? 'tus datos principales' : 'your main details');
}

function safeReservationHandoff(q: MergedQualification, fb: FallbackReplies['es'], lang: 'es' | 'en'): string {
  const variants = [fb.safeReservationHandoff, fb.safeReservationHandoffAlt1, fb.safeReservationHandoffAlt2];
  const template = variants[Math.floor(Date.now() / 1000) % variants.length];
  return template
    .replace('{{name}}', String(q.nombre ?? ''))
    .replace('{{summary}}', qualificationSummary(q, lang));
}

function itineraryReply(q: MergedQualification, fb: FallbackReplies['es']): string {
  return fb.itineraryReply.replace('{{name}}', String(q.nombre ?? '')).trim();
}

function buildFallbackReply(
  q: MergedQualification,
  lastMessage: string,
  skills: ReturnType<typeof getSkills>,
  lang: 'es' | 'en',
  db: Database.Database,
  phone: string,
): string {
  const fb = skills.fallbackReplies[lang];

  if (isCorrectionMessage(lastMessage)) {
    const name = String(q.nombre ?? '');
    if (!isQualificationComplete(q)) {
      const nextQ = nextQualificationQuestion(q, fb);
      return fb.disculpaYaDicho.replace('{{name}}', name).replace('{{continuation}}', nextQ.replace(/^[^,]+, /, '').toLowerCase());
    }
    const priceRow = db.prepare(
      'SELECT price_given_at FROM conversations WHERE customer_phone = ?'
    ).get(phone) as { price_given_at: string | null } | undefined;
    if (priceRow?.price_given_at) {
      return fb.disculpaYaDicho.replace('{{name}}', name).replace('{{continuation}}', fb.confirmReservationPrompt);
    }
    return fb.disculpaYaDicho.replace('{{name}}', name).replace('{{continuation}}', fb.repairPricePresented.replace('{{name}}', name).toLowerCase());
  }

  if (!isQualificationComplete(q)) {
    if (hasActionableUserQuestion(lastMessage)) {
      if (asksItinerary(lastMessage)) return itineraryReply(q, fb);
      return fb.answerQuestionBeforeQualification;
    }
    return nextQualificationQuestion(q, fb);
  }

  const priceRow2 = db.prepare(
    'SELECT price_given_at FROM conversations WHERE customer_phone = ?'
  ).get(phone) as { price_given_at: string | null } | undefined;
  if (!priceRow2?.price_given_at) {
    const name = String(q.nombre ?? '');
    upsertConversation(db, phone, { price_given_at: new Date().toISOString() });
    return fb.repairPriceNotPresented.replace('{{name}}', name);
  }

  const name = String(q.nombre ?? '');
  return fb.objectionResolvedContinue.replace('{{name}}', name);
}

function getCollectedFields(db: Database.Database, phone: string): Record<string, unknown> {
  const row = db.prepare(
    'SELECT collected_name, collected_date, collected_people, collected_transport_need, collected_lodging_need, collected_pet, language FROM conversations WHERE customer_phone = ?'
  ).get(phone) as Record<string, unknown> | undefined;
  if (!row) return {};
  const fields: Record<string, unknown> = {};
  if (row.collected_name) fields.nombre = row.collected_name;
  if (row.collected_date) fields.fecha = row.collected_date;
  if (row.collected_people) fields.personas = row.collected_people;
  if (row.collected_transport_need) fields.transporte = row.collected_transport_need;
  if (row.collected_lodging_need) fields.hospedaje = row.collected_lodging_need;
  if (row.collected_pet) fields.mascota = row.collected_pet;
  if (row.language) fields.idioma = row.language;
  return fields;
}

function resolveLanguage(db: Database.Database, phone: string, message: string): SupportedLanguage {
  const detected = detectLanguageOrNull(message);
  if (detected) return detected;
  const row = db.prepare('SELECT language FROM conversations WHERE customer_phone = ?').get(phone) as { language: SupportedLanguage | null } | undefined;
  return row?.language ?? 'es';
}

export async function processMessage(input: ProcessMessageInput): Promise<ProcessMessageOutput> {
  const { db, customerPhone, message, messageId } = input;
  const skills = getSkills();

  const handedOffRow = db.prepare(
    'SELECT handed_off_at FROM conversations WHERE customer_phone = ?'
  ).get(customerPhone) as { handed_off_at: string | null } | undefined;

  if (handedOffRow?.handed_off_at) {
    const fb = skills.fallbackReplies[resolveLanguage(db, customerPhone, message)];
    const idx = Math.floor(Date.now() / 1000) % 2;
    return {
      reply: idx === 0 ? fb.handedOffVariant0 : fb.handedOffVariant1,
      shouldSendReply: true,
      leadScore: 0,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
    };
  }

  const normalized = normalizeText(message);
  const lang = resolveLanguage(db, customerPhone, message);

  if (isAdcodeNoise(message)) {
    return {
      reply: '',
      shouldSendReply: false,
      leadScore: 0,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
    };
  }

  if (isOptedOut(db, customerPhone)) {
    return {
      reply: '',
      shouldSendReply: false,
      leadScore: 0,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
    };
  }

  const optOutKeywords = lang === 'es' ? OPT_OUT_KEYWORDS_ES : OPT_OUT_KEYWORDS_EN;
  if (optOutKeywords.some(k => normalized.includes(k)) || ALL_OPT_OUT_KEYWORDS.some(k => normalized.includes(k))) {
    if (!isOptedOut(db, customerPhone)) {
      setOptOut(db, customerPhone);
    }
    const optOutMsg = skills.fallbackReplies[lang].optOutConfirmation;
    return {
      reply: optOutMsg,
      shouldSendReply: true,
      leadScore: 0,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
    };
  }

  const softCloseRow = db.prepare(
    'SELECT soft_closed_at FROM conversations WHERE customer_phone = ?'
  ).get(customerPhone) as { soft_closed_at: string | null } | undefined;

  addMessage(db, {
    whatsapp_message_id: messageId,
    customer_phone: customerPhone,
    direction: 'inbound',
    message_type: 'text',
    body: message,
    created_at: new Date().toISOString(),
    raw_json: null,
  });

  const bookingFields = extractBookingFields(message);
  const contextFields = contextAwareExtract(message, db, customerPhone, bookingFields);
  upsertConversation(db, customerPhone, { language: lang, ...contextFields });

  const rawCollected = getCollectedFields(db, customerPhone);
  const richCollected = reconstructFromHistory(db, customerPhone, rawCollected);

  const missingFromDb: Record<string, unknown> = {};
  if (!rawCollected.nombre && richCollected.nombre) missingFromDb.collected_name = richCollected.nombre;
  if (!rawCollected.personas && richCollected.personas) missingFromDb.collected_people = richCollected.personas;
  if (!rawCollected.fecha && richCollected.fecha) missingFromDb.collected_date = richCollected.fecha;
  if (!rawCollected.transporte && richCollected.transporte) missingFromDb.collected_transport_need = richCollected.transporte;
  if (!rawCollected.mascota && richCollected.mascota) missingFromDb.collected_pet = richCollected.mascota;
  if (Object.keys(missingFromDb).length > 0) {
    upsertConversation(db, customerPhone, missingFromDb);
  }

  const collectedFields = reconstructFromHistory(db, customerPhone, rawCollected);
  const dbQualification = buildDbQualification(collectedFields);
  const recentMessages = getRecentMessages(db, customerPhone, 21).filter((_, i, arr) => i < arr.length - 1);

  const scoreDelta = scoreMessage(normalized, skills);
  const currentScore = (() => {
    const row = db.prepare('SELECT lead_score FROM conversations WHERE customer_phone = ?').get(customerPhone) as { lead_score: number } | undefined;
    const existing = row?.lead_score ?? 0;
    return Math.max(0, Math.min(100, existing + scoreDelta.score));
  })();

  upsertConversation(db, customerPhone, { lead_score: currentScore });

  if (isSoftCloseMessage(message)) {
    if (!softCloseRow?.soft_closed_at) {
      upsertConversation(db, customerPhone, { soft_closed_at: new Date().toISOString() });
    }
    const softCloseReply = skills.fallbackReplies[lang].softCloseReply;
    return {
      reply: softCloseReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
    };
  }

  if (softCloseRow?.soft_closed_at) {
    if (isReEngagementMessage(message)) {
      db.prepare('UPDATE conversations SET soft_closed_at = NULL WHERE customer_phone = ?').run(customerPhone);
    } else {
      return {
        reply: '',
        shouldSendReply: false,
        leadScore: currentScore,
        usedAi: false,
        shouldAlertOwner: false,
        shouldSendImage: false,
      };
    }
  }

  const preLimitPriceRow = db.prepare(
    'SELECT price_given_at FROM conversations WHERE customer_phone = ?'
  ).get(customerPhone) as { price_given_at: string | null } | undefined;
  const lastAssistantQuestion = getLastAssistantQuestion(db, customerPhone);
  const preLimitHandoffAllowed = isQualificationComplete(dbQualification)
    && !!preLimitPriceRow?.price_given_at
    && isReservationIntentOrConfirmation(message, lastAssistantQuestion);

  const limits = checkTimeWindow(db, customerPhone);
  if (limits.isLimited) {
    console.warn('[BOT] message limit reached for', customerPhone, 'reason:', limits.reason);
    if (preLimitHandoffAllowed) {
      db.prepare(
        'UPDATE conversations SET handed_off_at = ? WHERE customer_phone = ?'
      ).run(new Date().toISOString(), customerPhone);
      return {
        reply: safeReservationHandoff(dbQualification, skills.fallbackReplies[lang], lang),
        shouldSendReply: true,
        leadScore: currentScore,
        usedAi: false,
        shouldAlertOwner: true,
        shouldSendImage: false,
      };
    }
    const gracefulReply = skills.fallbackReplies[lang].messageLimitReached;
    return {
      reply: gracefulReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
    };
  }

  const budget = checkBudget(db, customerPhone);
  if (!budget.aiAllowed) {
    console.warn('[AI] budget blocked:', budget.reason);
    const gracefulReply = skills.fallbackReplies[lang].aiFailureQualified;
    return {
      reply: gracefulReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: true,
      shouldSendImage: false,
    };
  }

  const systemPrompt = buildSystemPrompt(skills, lang, collectedFields);
  const aiResult = await callDeepSeek(message, systemPrompt, recentMessages);

  if (!aiResult) {
    console.warn('[AI] DeepSeek call failed, sending graceful reply');
    const fallbackReply = buildFallbackReply(dbQualification, message, skills, lang, db, customerPhone);
    return {
      reply: fallbackReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: isQualificationComplete(dbQualification),
      shouldSendImage: false,
    };
  }

  const { response: aiResponse } = aiResult;

  recordAiUsage(db, customerPhone, {
    prompt_tokens: aiResult.promptTokens,
    completion_tokens: aiResult.completionTokens,
  });

  if (aiResponse.reply === null || aiResponse.reply === '') {
    console.warn('[AI] DeepSeek returned null reply, sending graceful reply');
    const fallbackReply = buildFallbackReply(dbQualification, message, skills, lang, db, customerPhone);
    return {
      reply: fallbackReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: true,
      shouldAlertOwner: isQualificationComplete(dbQualification),
      shouldSendImage: false,
    };
  }

  const finalScore = Math.max(0, Math.min(100, currentScore + aiResponse.lead_score_delta));

  const collectedFromAi = aiResponse.collected_fields ?? {};
  const dbFields: Record<string, unknown> = {};
  if (collectedFromAi.name != null) dbFields.collected_name = collectedFromAi.name;
  if (collectedFromAi.people != null) dbFields.collected_people = collectedFromAi.people;
  if (collectedFromAi.date != null) dbFields.collected_date = collectedFromAi.date;
  if (collectedFromAi.transport_need != null) dbFields.collected_transport_need = collectedFromAi.transport_need;
  if (collectedFromAi.lodging_need != null) dbFields.collected_lodging_need = collectedFromAi.lodging_need;
  if (collectedFromAi.pet != null) dbFields.collected_pet = collectedFromAi.pet;
  if (Object.keys(dbFields).length > 0) {
    upsertConversation(db, customerPhone, { lead_score: finalScore, ...dbFields });
  } else {
    upsertConversation(db, customerPhone, { lead_score: finalScore });
  }

  const shouldSendImage = aiResponse.should_send_image && canSendImage(db, customerPhone);

  let replyText = stripHandoffPhrases(aiResponse.reply);

  const merged: MergedQualification = {
    nombre: collectedFields.nombre ?? collectedFromAi.name,
    personas: collectedFields.personas ?? collectedFromAi.people,
    fecha: collectedFields.fecha ?? collectedFromAi.date,
    transporte: collectedFields.transporte ?? collectedFromAi.transport_need,
    mascota: collectedFields.mascota ?? collectedFromAi.pet,
  };

  if (asksItinerary(message) && isGenericConversionReply(replyText)) {
    replyText = itineraryReply(merged, skills.fallbackReplies[lang]);
  } else if (isUserConfusedOrRepeating(message) && isGenericConversionReply(replyText)) {
    const preCheckPrice = db.prepare(
      'SELECT price_given_at FROM conversations WHERE customer_phone = ?'
    ).get(customerPhone) as { price_given_at: string | null } | undefined;
    if (preCheckPrice?.price_given_at) {
      const name = String(merged.nombre ?? '');
      replyText = lang === 'es'
        ? `${name}, perdón, me enredé. Para resumir: el plan sale bien, y si quieres, valido disponibilidad exacta con el equipo y te confirmo.`
        : `${name}, sorry, I got tangled up. To summarize: the plan works, and if you want, I'll validate exact availability with the team and confirm.`;
    }
  }

  if (isTruncatedReply(replyText)) {
    console.warn('[AI] reply may be truncated', { customerPhone, replySnippet: replyText.slice(0, 40) });
  }

  const priceJustGiven = replyMentionsPrice(replyText);
  const priceRow = db.prepare(
    'SELECT price_given_at FROM conversations WHERE customer_phone = ?'
  ).get(customerPhone) as { price_given_at: string | null } | undefined;
  const pricePresented = !!(priceJustGiven || priceRow?.price_given_at);
  if (priceJustGiven && !priceRow?.price_given_at) {
    upsertConversation(db, customerPhone, { price_given_at: new Date().toISOString() });
  }

  const reservationIntent = isReservationIntentOrConfirmation(message, lastAssistantQuestion);
  const handoffAllowed = isQualificationComplete(merged) && pricePresented && reservationIntent;

  let needsHumanEffective = false;

  if (handoffAllowed) {
    replyText = safeReservationHandoff(merged, skills.fallbackReplies[lang], lang);
    needsHumanEffective = true;
    db.prepare(
      'UPDATE conversations SET handed_off_at = ? WHERE customer_phone = ?'
    ).run(new Date().toISOString(), customerPhone);
  } else {
    if (containsUnsafeReservationClaim(replyText) && isQualificationComplete(merged) && pricePresented) {
      console.warn('[BOT] blocked unsafe reservation claim', {
        customerPhone,
        pricePresented,
        reservationIntent,
      });
      replyText = safeReservationHandoff(merged, skills.fallbackReplies[lang], lang);
      needsHumanEffective = true;
      db.prepare(
        'UPDATE conversations SET handed_off_at = ? WHERE customer_phone = ?'
      ).run(new Date().toISOString(), customerPhone);
    }

    const modelTriedHandoff =
      aiResponse.needs_human || replyText.length === 0 || containsHandoffPhrase(aiResponse.reply);
    if (!needsHumanEffective && modelTriedHandoff) {
      console.warn('[BOT] suppressed premature handoff', {
        customerPhone, merged: {
          nombre: merged.nombre,
          personas: merged.personas,
          fecha: merged.fecha,
          transporte: merged.transporte,
          mascota: merged.mascota,
        }, pricePresented, reservationIntent,
      });
      if (!isQualificationComplete(merged)) {
        const nextQ = asksItinerary(message)
          ? itineraryReply(merged, skills.fallbackReplies[lang])
          : hasActionableUserQuestion(message)
            ? skills.fallbackReplies[lang].answerQuestionBeforeQualification
          : nextQualificationQuestion(merged, skills.fallbackReplies[lang]);
        const lastAssistant = getLastAssistantQuestion(db, customerPhone);
        if (lastAssistant && lastAssistant.trim().toLowerCase() === nextQ.trim().toLowerCase()) {
          const extractedNow = extractBookingFields(message);
          if (extractedNow.collected_people && !merged.personas) {
            upsertConversation(db, customerPhone, { collected_people: extractedNow.collected_people });
            replyText = nextQualificationQuestion({ ...merged, personas: extractedNow.collected_people }, skills.fallbackReplies[lang]);
          } else {
            replyText = lang === 'es'
              ? 'Perdón, creo que no tomé bien tu respuesta. ¿Me confirmas de nuevo?'
              : 'Sorry, I think I missed that. Could you confirm again?';
          }
        } else {
          replyText = nextQ;
        }
      } else if (!pricePresented) {
        replyText = skills.fallbackReplies[lang].repairPriceNotPresented.replace('{{name}}', String(merged.nombre ?? ''));
        upsertConversation(db, customerPhone, { price_given_at: new Date().toISOString() });
      } else {
        replyText = skills.fallbackReplies[lang].repairPricePresented.replace('{{name}}', String(merged.nombre ?? ''));
      }
    }
  }

  const shouldAlertOwner = needsHumanEffective || (
    finalScore >= skills.salesStrategy.hotLeadThreshold
    && isQualificationComplete(merged)
    && pricePresented
    && reservationIntent
  );

  return {
    reply: replyText,
    shouldSendReply: true,
    leadScore: finalScore,
    usedAi: true,
    shouldAlertOwner,
    shouldSendImage,
  };
}
