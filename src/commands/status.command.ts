import { env } from '../config/env.js';
import type { LineLeadCount } from '../db/repositories/types.js';
import { getLineById, getRoutingConfig } from '../services/lead-routing.js';
import { getReportExcludedPhones } from '../services/report-exclusions.js';
import { getWebhookStats } from '../services/webhook-stats.js';
import type { CommandContext } from './index.js';

function lineLabel(lineId: string): string {
  if (lineId === 'unassigned') return 'Sin asignar';
  const line = getLineById(lineId);
  return line ? `${line.agentName}` : lineId;
}

function fmtUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function byLineSection(counts: LineLeadCount[]): string {
  if (counts.length === 0) return '';
  const lines = ['', '*Conversaciones por linea*'];
  for (const l of counts) {
    lines.push(`• ${lineLabel(l.lineId)}: ${l.total} total | ${l.hot} calientes | ${l.booked} reservas`);
  }
  return lines.join('\n');
}

/**
 * Webhook intake since the last restart. `Descartados > 0` means Meta delivered
 * something the bot could not turn into a message — the one symptom that used
 * to be completely invisible. Reactions are counted apart because they are
 * ignored on purpose and are not losses.
 */
function webhookSection(): string {
  const w = getWebhookStats();
  const lines = [
    '',
    '*Webhooks (desde el ultimo reinicio)*',
    `• POSTs: ${w.posts} | Mensajes: ${w.messages}`,
    `• Descartados: ${w.skipped} | Reacciones ignoradas: ${w.reactions}`,
  ];
  if (w.skipped > 0) lines.push('⚠️ Revisa webhook_parse en system_errors.');
  return lines.join('\n');
}

export async function statusHandler(ctx: CommandContext): Promise<string> {
  const paused = ctx.repos.isPaused();
  const uptime = fmtUptime(process.uptime());

  const todayUtc = new Date();
  const todayStart = new Date(Date.UTC(
    todayUtc.getUTCFullYear(),
    todayUtc.getUTCMonth(),
    todayUtc.getUTCDate(),
  )).toISOString();

  const excluded = getReportExcludedPhones();
  const stats = ctx.repos.stats.getDailyStats(todayStart, env.HOT_LEAD_THRESHOLD, excluded);
  const byLine = ctx.repos.stats.getLeadCountsByLine(env.HOT_LEAD_THRESHOLD, excluded);
  const linesConfigured = getRoutingConfig()?.salesLines.length ?? 0;

  const parts = [
    `📊 *Estado del Bot*`,
    '',
    paused ? '⏸️ Estado: PAUSADO' : '✅ Estado: Activo',
    `⏱️ Uptime: ${uptime}`,
    `📋 Lineas configuradas: ${linesConfigured}`,
    '',
    `📈 *Hoy (${stats.label})*`,
    `👥 Conversaciones: ${stats.totalConversations} (${stats.newConversations} nuevas)`,
    `📨 Entrantes: ${stats.messagesInbound} | 📤 Salientes: ${stats.messagesOutbound}`,
    `🔥 Leads calientes: ${stats.hotLeads} (${stats.hotLeadPercentage}%)`,
    `🤝 Transferidos: ${stats.handedOff}`,
    `🎉 Reservas hoy: ${stats.bookedToday}`,
    `💰 IA gastada: $${stats.aiSpentUsd.toFixed(4)}`,
  ];

  parts.push(byLineSection(byLine));
  parts.push(webhookSection());
  parts.push('', '_Usa /report para detalle completo._');

  return parts.join('\n');
}
