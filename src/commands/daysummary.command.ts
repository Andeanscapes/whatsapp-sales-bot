import type { DayActivityResult } from '../db/repositories/types.js';
import { sendTelegramDocument } from '../services/telegram-document.js';
import type { CommandContext } from './index.js';

function md(text: string): string {
  return text.replace(/([*_`[])/g, '\\$1');
}

function utcMidnight(daysOffset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOffset);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function resolvePeriod(arg: string | undefined): { label: string; sinceIso: string; untilIso: string | null } | null {
  const period = (arg ?? 'hoy').toLowerCase();
  switch (period) {
    case 'hoy':
    case 'today':
      return { label: 'Hoy', sinceIso: utcMidnight(0), untilIso: null };
    case 'ayer':
    case 'yesterday':
      return { label: 'Ayer', sinceIso: utcMidnight(-1), untilIso: utcMidnight(0) };
    default:
      return null;
  }
}

function formatSummary(result: DayActivityResult, label: string, documentSent: boolean): string {
  const { totals, conversations } = result;
  const warning = documentSent ? null : '⚠️ JSON no enviado. Reintenta /daysummary para descargar el archivo.';
  if (conversations.length === 0) {
    return [
      `📋 *Resumen ${label}*: sin conversaciones activas en este periodo.`,
      warning,
    ].filter(Boolean).join('\n');
  }

  const lines = [
    `📋 *Resumen ${label}*`,
    '',
    `👥 Conversaciones: ${totals.totalConversations}`,
    `📨 Mensajes: ${totals.totalMessages} (← ${totals.totalInbound} | → ${totals.totalOutbound})`,
    `💰 IA: $${totals.totalAiCostUsd.toFixed(4)}`,
    '',
  ];

  const top = conversations.slice(0, 15);
  for (const c of top) {
    const name = md(c.name ?? '—');
    const plan = md(c.plan ?? '—');
    lines.push(`${md(c.customerPhone)} | ${name} | ${c.score}pts | ${plan} | ${c.messageCount}msgs`);
  }

  if (conversations.length > 15) {
    lines.push(`... y ${conversations.length - 15} mas (ver JSON)`);
  }

  if (warning) lines.push('', warning);

  return lines.join('\n');
}

function buildJson(result: DayActivityResult, label: string): string {
  const payload = { ...result };
  payload.totals.label = label;
  return JSON.stringify(payload, null, 2);
}

const usage = 'Uso: /daysummary <hoy|ayer>';

export async function daysummaryHandler(ctx: CommandContext): Promise<string> {
  const period = resolvePeriod(ctx.args[0]);
  if (!period) return usage;

  const result = ctx.repos.transcripts.getDayActivity(period.sinceIso, period.untilIso);

  const jsonStr = buildJson(result, period.label);
  const buffer = Buffer.from(jsonStr, 'utf-8');
  const dateSlug = new Date().toISOString().slice(0, 10);
  const filename = `andean-summary-${period.label.toLowerCase()}-${dateSlug}.json`;
  let documentSent = false;

  try {
    documentSent = await sendTelegramDocument(
      ctx.chatId,
      buffer,
      filename,
      'application/json',
      `Resumen ${period.label}: ${result.totals.totalConversations} conversaciones`,
    );
  } catch {
    documentSent = false;
  }

  return formatSummary(result, period.label, documentSent);
}
