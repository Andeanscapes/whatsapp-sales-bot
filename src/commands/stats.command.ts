import { env } from '../config/env.js';
import type { DailyStats, LineLeadCount } from '../db/repositories/types.js';
import { getLineById } from '../services/lead-routing.js';
import { getReportExcludedPhones } from '../services/report-exclusions.js';
import type { CommandContext } from './index.js';

function lineLabel(lineId: string): string {
  if (lineId === 'unassigned') return 'Sin asignar';
  const line = getLineById(lineId);
  return line ? `${line.label} (${line.agentName})` : lineId;
}

function utcMidnight(daysOffset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOffset);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

interface Period {
  label: string;
  sinceIso: string;
  untilIso: string | null;
}

function resolvePeriod(arg: string | undefined): Period | null {
  const period = (arg ?? 'hoy').toLowerCase();
  switch (period) {
    case 'hoy':
    case 'today':
      return { label: 'Hoy', sinceIso: utcMidnight(0), untilIso: null };
    case 'ayer':
    case 'yesterday':
      return { label: 'Ayer', sinceIso: utcMidnight(-1), untilIso: utcMidnight(0) };
    case 'semana':
    case 'week':
      return { label: 'Ultimos 7 dias', sinceIso: utcMidnight(-7), untilIso: null };
    case 'todo':
    case 'all':
      return { label: 'Historico (todo)', sinceIso: '1970-01-01T00:00:00.000Z', untilIso: null };
    default:
      return null;
  }
}

function formatStats(stats: DailyStats, byLine: LineLeadCount[], label: string): string {
  const lines = [
    `📊 *Estadisticas — ${label}*`,
    '',
    `👥 Total conversaciones: ${stats.totalConversations}`,
    `🆕 Nuevas en periodo: ${stats.newConversations}`,
    `✅ Activas: ${stats.activeConversations}`,
    `📨 Entrantes: ${stats.messagesInbound} | 📤 Salientes: ${stats.messagesOutbound}`,
    `🔥 Leads calientes (>=${env.HOT_LEAD_THRESHOLD}): ${stats.hotLeads} (${stats.hotLeadPercentage}%)`,
    `🚫 Opt-out: ${stats.optedOut}`,
    `🤝 Transferidos: ${stats.handedOff}`,
    `🎉 Reservas: ${stats.bookedToday}`,
    `💰 IA gastada: $${stats.aiSpentUsd.toFixed(4)}`,
  ];

  if (byLine.length > 0) {
    lines.push('', '*Conversaciones por linea:*');
    for (const l of byLine) {
      lines.push(`• ${lineLabel(l.lineId)}: ${l.total} total | ${l.hot} calientes | ${l.booked} reservas`);
    }
  }

  return lines.join('\n');
}

const usage = 'Uso: /stats <hoy|ayer|semana|todo>';

export async function statsHandler(ctx: CommandContext): Promise<string> {
  const period = resolvePeriod(ctx.args[0]);
  if (!period) return usage;

  const excluded = getReportExcludedPhones();
  const stats = ctx.repos.stats.getPeriodStats(period.label, period.sinceIso, period.untilIso, env.HOT_LEAD_THRESHOLD, excluded);
  const byLine = ctx.repos.stats.getLeadCountsByLineForPeriod(period.sinceIso, period.untilIso, env.HOT_LEAD_THRESHOLD, excluded);
  return formatStats(stats, byLine, period.label);
}
