import { env } from '../config/env.js';
import type { DailyStats, LineLeadCount } from '../db/repositories/types.js';
import { getLineById } from '../services/lead-routing.js';
import type { CommandContext } from './index.js';

function lineLabel(lineId: string): string {
  if (lineId === 'unassigned') return 'Sin asignar';
  const line = getLineById(lineId);
  return line ? `${line.label} (${line.agentName})` : lineId;
}

function formatReport(stats: DailyStats, byLine: LineLeadCount[]): string {
  const lines = [
    `📊 *Reporte Diario* — ${stats.label}`,
    '',
    `👥 Total conversaciones: ${stats.totalConversations}`,
    `🆕 Nuevas hoy: ${stats.newConversations}`,
    `✅ Activas: ${stats.activeConversations}`,
    `📨 Mensajes entrantes: ${stats.messagesInbound}`,
    `📤 Mensajes salientes: ${stats.messagesOutbound}`,
    `🔥 Leads calientes (>=${env.HOT_LEAD_THRESHOLD}): ${stats.hotLeads} (${stats.hotLeadPercentage}%)`,
    `🚫 Opt-out hoy: ${stats.optedOut}`,
    `🤝 Transferidos hoy: ${stats.handedOff}`,
    `🎉 Reservas hoy: ${stats.bookedToday}`,
    `💤 Soft closed hoy: ${stats.softClosed}`,
    '',
    `🤖 *IA* — ${stats.aiCalls} llamadas`,
    `💰 Costo total: $${stats.aiSpentUsd.toFixed(4)}`,
    `📊 Tokens: ${stats.aiPromptTokens.toLocaleString()} prompt | ${stats.aiCompletionTokens.toLocaleString()} completion`,
    `   Reply: $${stats.aiReplyCost.toFixed(4)} | Analysis: $${stats.aiAnalysisCost.toFixed(4)} | Follow-up: $${stats.aiFollowUpCost.toFixed(4)}`,
  ];

  if (byLine.length > 0) {
    lines.push('', '*Conversaciones por linea (global):*');
    for (const l of byLine) {
      lines.push(`• ${lineLabel(l.lineId)}: ${l.total} total | ${l.hot} calientes | ${l.booked} reservas`);
    }
  }

  return lines.join('\n');
}

export async function reportHandler(ctx: CommandContext): Promise<string> {
  const todayUtc = new Date();
  const todayStart = new Date(Date.UTC(
    todayUtc.getUTCFullYear(),
    todayUtc.getUTCMonth(),
    todayUtc.getUTCDate(),
  )).toISOString();

  const stats = ctx.repos.stats.getDailyStats(todayStart, env.HOT_LEAD_THRESHOLD);
  const byLine = ctx.repos.stats.getLeadCountsByLine(env.HOT_LEAD_THRESHOLD);
  return formatReport(stats, byLine);
}
