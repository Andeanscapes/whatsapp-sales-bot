import type Database from 'better-sqlite3';
import { getSkills } from './skill-loader.js';
import { scoreMessage } from './lead-scoring.js';
import { isOptedOut, setOptOut } from './opt-out-service.js';
import { addMessage, getRecentMessages, upsertConversation } from './conversation-store.js';
import { checkTimeWindow } from './time-window-policy.js';
import { canSendImage } from './media-service.js';
import { checkBudget } from './budget-guard.js';
import { detectLanguage, normalizeText } from './language-service.js';
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

function extractBookingFields(text: string): Record<string, unknown> {
  const normalized = normalizeText(text);
  const fields: Record<string, unknown> = {};

  const monthInText = MONTH_NAMES.find(m => normalized.includes(m));
  if (monthInText) fields.collected_date = monthInText;

  const peopleMatch = normalized.match(/(\d+)\s*(?:people|person|persons|personas|pax)/);
  if (peopleMatch) fields.collected_people = parseInt(peopleMatch[1], 10);

  const coupleMatch = normalized.match(/\bcouple\b|\bpareja\b/);
  if (coupleMatch) fields.collected_people = 2;

  if (/transport|pickup|transporte|recoger|Bogotá|Bogota/i.test(text)) {
    fields.collected_transport_need = 'yes';
  }

  if (/lodging|hotel|stay|overnight|hospedaje|alojamiento/i.test(text)) {
    fields.collected_lodging_need = 'yes';
  }

  return fields;
}

function getCollectedFields(db: Database.Database, phone: string): Record<string, unknown> {
  const row = db.prepare(
    'SELECT collected_name, collected_date, collected_people, collected_transport_need, collected_lodging_need, language FROM conversations WHERE customer_phone = ?'
  ).get(phone) as Record<string, unknown> | undefined;
  if (!row) return {};
  const fields: Record<string, unknown> = {};
  if (row.collected_name) fields.nombre = row.collected_name;
  if (row.collected_date) fields.fecha = row.collected_date;
  if (row.collected_people) fields.personas = row.collected_people;
  if (row.collected_transport_need) fields.transporte = row.collected_transport_need;
  if (row.collected_lodging_need) fields.hospedaje = row.collected_lodging_need;
  if (row.language) fields.idioma = row.language;
  return fields;
}

export async function processMessage(input: ProcessMessageInput): Promise<ProcessMessageOutput> {
  const { db, customerPhone, message, messageId } = input;
  const skills = getSkills();

  const handedOffRow = db.prepare(
    'SELECT handed_off_at FROM conversations WHERE customer_phone = ?'
  ).get(customerPhone) as { handed_off_at: string | null } | undefined;

  if (handedOffRow?.handed_off_at) {
    const variants = [
      'El equipo ya tiene tus datos y te contactara pronto. Cualquier duda, aca estoy.',
      'Ya le pase tu info al equipo de reservas. Te escriben en breve. Quedo atento por si necesitas algo mas.',
    ];
    const idx = Math.floor(Date.now() / 1000) % 2;
    return {
      reply: variants[idx],
      shouldSendReply: true,
      leadScore: 0,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
    };
  }

  const normalized = normalizeText(message);
  const lang = detectLanguage(message);

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
  upsertConversation(db, customerPhone, { language: lang, ...bookingFields });

  const collectedFields = getCollectedFields(db, customerPhone);
  const recentMessages = getRecentMessages(db, customerPhone, 21).filter((_, i, arr) => i < arr.length - 1);

  const scoreDelta = scoreMessage(normalized, skills);
  const currentScore = (() => {
    const row = db.prepare('SELECT lead_score FROM conversations WHERE customer_phone = ?').get(customerPhone) as { lead_score: number } | undefined;
    const existing = row?.lead_score ?? 0;
    return Math.max(0, Math.min(100, existing + scoreDelta.score));
  })();

  upsertConversation(db, customerPhone, { lead_score: currentScore });

  const limits = checkTimeWindow(db, customerPhone);
  if (limits.isLimited) {
    console.warn('[BOT] message limit reached for', customerPhone, 'reason:', limits.reason);
    const gracefulReply = lang === 'es'
      ? 'Dame unos minuticos, termino de validar con el equipo de reservas para continuar con tu proceso.'
      : 'Give me a few minutes, I am finishing up with the reservations team to continue your process.';
    return {
      reply: gracefulReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: true,
      shouldSendImage: false,
    };
  }

  const budget = checkBudget(db, customerPhone);
  if (!budget.aiAllowed) {
    console.warn('[AI] budget blocked:', budget.reason);
    const gracefulReply = lang === 'es'
      ? 'Dame unos minuticos, termino de validar con el equipo de reservas para continuar con tu proceso.'
      : 'Give me a few minutes, I am finishing up with the reservations team to continue your process.';
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
    const gracefulReply = lang === 'es'
      ? 'Dame unos minuticos, termino de validar con el equipo de reservas para continuar con tu proceso.'
      : 'Give me a few minutes, I am finishing up with the reservations team to continue your process.';
    return {
      reply: gracefulReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: false,
      shouldAlertOwner: true,
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
    const gracefulReply = lang === 'es'
      ? 'Dame unos minuticos, termino de validar con el equipo de reservas para continuar con tu proceso.'
      : 'Give me a few minutes, I am finishing up with the reservations team to continue your process.';
    return {
      reply: gracefulReply,
      shouldSendReply: true,
      leadScore: currentScore,
      usedAi: true,
      shouldAlertOwner: true,
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
  if (Object.keys(dbFields).length > 0) {
    upsertConversation(db, customerPhone, { lead_score: finalScore, ...dbFields });
  } else {
    upsertConversation(db, customerPhone, { lead_score: finalScore });
  }

  const shouldSendImage = aiResponse.should_send_image && canSendImage(db, customerPhone);
  const shouldAlertOwner = finalScore >= skills.salesStrategy.hotLeadThreshold || aiResponse.needs_human;

  if (aiResponse.needs_human) {
    db.prepare(
      'UPDATE conversations SET handed_off_at = ? WHERE customer_phone = ?'
    ).run(new Date().toISOString(), customerPhone);
  }

  return {
    reply: aiResponse.reply,
    shouldSendReply: true,
    leadScore: finalScore,
    usedAi: true,
    shouldAlertOwner,
    shouldSendImage,
  };
}
