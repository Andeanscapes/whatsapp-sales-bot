import type { Repositories } from '../db/repositories/index.js';
import { normalizeText, detectLanguageOrNull, type SupportedLanguage } from './language-service.js';
import type { FallbackReplies } from './skill-loader.js';
import { getSkills } from './skill-loader.js';
import type { MergedQualification } from './types.js';
import { getActiveExperience, getPlans } from './product-registry.js';
import { MONTH_NAMES } from './constants.js';

export const NAME_PATTERNS = [
  /soy ([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+)/i,
  /me llamo ([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+)/i,
  /mi nombre es ([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+)/i,
  /i am ([A-Z][a-z]+)/i,
  /my name is ([A-Z][a-z]+)/i,
];

export const NAME_BLACKLIST = /^(?:hola|buenas|hello|hi|hey|ok|si|no|yes|ya|gracias|thanks|quiero|cual|como|cuanto|donde|cuando|que|qué|cual|cuál|precio|itinerario|agenda|actividades|what|how|where|when|porque|por qu[eé]|me|te|se|el|la|los|las|es|own|solo|sola|bien|listo)$/i;

export const TRANSPORT_OWN_PATTERNS = [
  /\b(?:veh[ií]culo propio|carro propio|mi carro|mi coche|mi auto|mi camioneta|en mi carro|voy en carro|voy con carro|llevo carro|tengo mi carro|moto|moto propia|vamos en (?:carro|moto|auto)|tenemos (?:carro|moto|auto|veh[ií]culo)|transporte propio|transporte si|si tenemos)\b/i,
  /\b(?:propio transporte|transporte propio|coche propio|no necesitamos transporte|nosotros manejamos|manejamos|si propio|yo manejo|manejo|si[,.]?\s*mi\s+(?:carro|auto|coche|camioneta)|s[ií][,.]?\s*(?:mi\s+)?(?:carro|auto|coche|camioneta|propio))\b/i,
  /\b(?:we have (?:our own|a) (?:car|motorcycle|vehicle|transport|truck)|own transport|driving ourselves|yes own|i have (?:my )?own|my (?:own )?car|my car|my vehicle|rental car|we'?ll? drive|coming by car|driving there)\b/i,
  /\b(?:yes[,.]?\s*(?:i have|my|own|driving|car|vehicle)|yeah[,.]?\s*(?:my|own|car))\b/i,
];

export const TRANSPORT_OWN_CONTEXT_PATTERNS = [
  /\b(?:si|s[ií])\b.*\b(?:propio|tengo|tenemos|transporte|mi\s+(?:carro|auto|coche|camioneta))\b/i,
  /\b(?:propio|tengo carro|tengo moto|tengo veh[ií]culo|en carro|en moto|manejando|mi carro|mi auto|mi coche|voy en|voy con)\b/i,
  /\b(?:yes|yeah|yep)\b.*\b(?:own|have (?:a |my )?(?:car|transport|vehicle|ride)|my car|i drive)\b/i,
  /\b(?:i (?:have|drive) (?:a |my own )?(?:car|motorcycle|vehicle))\b/i,
  /\b(?:si[,.]?\s*(?:tengo|mi|con)\s*(?:carro|auto|coche|camioneta))\b/i,
];

export const PET_KEYWORDS = /\b(?:perro|perrito|mascota|mascotas|gato|gatos|perra|perros|gatito|pet|dog|cat|dogs|cats|puppy|kitten)\b/i;

export function detectPlan(message: string): string | null {
  const norm = normalizeText(message);
  const skills = getSkills();
  const plans = getPlans(getActiveExperience(skills));
  if (!plans.length) return null;

  const durationBoosts = new Map<string, RegExp>([
    ['3d2n_rural', /\b(3\s*d|3\s*dias|3\s*días|tres\s+dias|tres\s+días|2\s*noches|dos\s+noches)\b/],
    ['2d1n_mining', /\b(2\s*d|2\s*dias|2\s*días|dos\s+dias|dos\s+días|1\s*noche|una\s+noche)\b/],
  ]);

  let best: { id: string; score: number } | null = null;
  let tied = false;

  for (const plan of plans) {
    let score = plan.keywords.reduce((total, keyword) => {
      return norm.includes(normalizeText(keyword)) ? total + 1 : total;
    }, 0);

    const durationBoost = durationBoosts.get(plan.id);
    if (durationBoost?.test(norm)) score += 10;

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
  return repos.message.getLastOutboundBody(phone);
}

export function isQualificationComplete(q: MergedQualification): boolean {
  return q.nombre != null && q.plan != null && q.personas != null && q.fecha != null && q.transporte != null;
}

export function nextQualificationQuestion(q: MergedQualification, fb: FallbackReplies['es']): string {
  if (q.nombre == null) return fb.askName;
  if (q.plan == null) return fb.askPlan.replace('{{name}}', String(q.nombre));
  if (q.personas == null) return fb.askPeople;
  if (q.fecha == null) return fb.askDate;
  return fb.askTransport;
}

export function extractStandaloneName(text: string): string | null {
  const cleaned = text.trim().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const first = cleaned.split(' ')[0];
  if (!first || first.length < 2 || first.length > 20 || NAME_BLACKLIST.test(first)) return null;
  if (!/^[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+$/u.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
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

export function extractBookingFields(text: string): Record<string, unknown> {
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
    const dayMonthEs = text.match(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i);
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

  const peopleMatch = text.match(/(\d+)\s*(?:people|person|persons|personas|pax)/i);
  if (peopleMatch) fields.collected_people = parseInt(peopleMatch[1], 10);

  const simpleNumberMatch = text.match(/\b(?:somos|van|vamos|seriamos|serian|somos como|van como)\s+(\d+)\b/i);
  if (simpleNumberMatch && !fields.collected_people) {
    fields.collected_people = parseInt(simpleNumberMatch[1], 10);
  }

  const couplePattern = /\b(?:couple|pareja|dos personas|2 personas|mi esposo y yo|mi esposa y yo|mi novio y yo|mi novia y yo|mi pareja y yo|mi hija y yo|mi hijo y yo|mi (?:mam[aá]|madre|made) y yo|vamos dos|somos dos|somos 2|vamos 2)\b/i;
  if (couplePattern.test(text) && !fields.collected_people) {
    fields.collected_people = 2;
  }

  if (/\b(?:sola|solo|voy sola|voy solo|ir[ií]a sola|ir[ií]a solo|yo sola|yo solo|una persona|1 persona|just me|only me|me alone|solo traveler)\b/i.test(text) && !fields.collected_people) {
    fields.collected_people = 1;
  }

  const tresPeople = /\b(?:tres personas|3 personas|tree\s+personas?|somos\s+(?:tres|tree|3)|mis dos hijos|mi esposa y mi hijo|mi esposo y mi hija|somos tres|somos 3)\b/i;
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

  const detectedPlan = detectPlan(text);
  if (detectedPlan) fields.collected_plan = detectedPlan;

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

export function contextAwareExtract(message: string, repos: Repositories, phone: string, existing: Record<string, unknown>): Record<string, unknown> {
  const fields = { ...existing };
  const lastQuestion = getLastAssistantQuestion(repos, phone);
  const norm = message.trim();

  if (lastQuestion && !fields.collected_people) {
    const askedPeople = /cu[aá]ntas personas|cu[aá]ntos ser[ií]an|how many people/i.test(lastQuestion);
    if (askedPeople) {
      const people = extractPeopleFromReply(norm);
      if (people != null) fields.collected_people = people;
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

  if (lastQuestion && !fields.collected_plan) {
    const askedPlan = /que plan|which plan|cual plan|2 dias|3 dias|2d|3d/i.test(lastQuestion);
    if (askedPlan) {
      const detectedPlan = detectPlan(norm);
      if (detectedPlan) fields.collected_plan = detectedPlan;
    }
  }

  if (!fields.collected_plan) {
    const detectedPlan = detectPlan(norm);
    if (detectedPlan) fields.collected_plan = detectedPlan;
  }

  return fields;
}

export function reconstructFromHistory(repos: Repositories, phone: string, current: Record<string, unknown>): Record<string, unknown> {
  const fields = { ...current };
  const allInbound = repos.message.getLastInboundBodies(phone, 20);
  const need = {
    nombre: !fields.nombre,
    personas: !fields.personas,
    fecha: !fields.fecha,
    transporte: !fields.transporte,
    mascota: !fields.mascota,
  };
  let planChecked = false;
  for (const row of allInbound) {
    if (!row.body || (!need.nombre && planChecked && !need.personas && !need.fecha && !need.transporte && !need.mascota)) continue;
    const extracted = extractBookingFields(row.body);
    if (need.nombre && extracted.collected_name) { fields.nombre = extracted.collected_name; need.nombre = false; }
    if (!planChecked && extracted.collected_plan) { fields.plan = extracted.collected_plan; planChecked = true; }
    if (need.personas && extracted.collected_people) { fields.personas = extracted.collected_people; need.personas = false; }
    if (need.fecha && extracted.collected_date) { fields.fecha = extracted.collected_date; need.fecha = false; }
    if (need.transporte && extracted.collected_transport_need) { fields.transporte = extracted.collected_transport_need; need.transporte = false; }
    if (need.mascota && extracted.collected_pet) { fields.mascota = extracted.collected_pet; need.mascota = false; }
  }
  return fields;
}

export function buildDbQualification(collected: Record<string, unknown>): MergedQualification {
  return {
    nombre: collected.nombre,
    plan: collected.plan,
    personas: collected.personas,
    fecha: collected.fecha,
    transporte: collected.transporte,
    mascota: collected.mascota,
  };
}

export function getCollectedFields(repos: Repositories, phone: string): Record<string, unknown> {
  return repos.conversation.getCollectedFields(phone);
}

export function resolveLanguage(repos: Repositories, phone: string, message: string): SupportedLanguage {
  const detected = detectLanguageOrNull(message);
  if (detected) return detected;
  return repos.conversation.getLanguage(phone) ?? 'es';
}
