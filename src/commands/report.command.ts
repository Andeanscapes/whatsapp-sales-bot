import { env } from '../config/env.js';
import type { DailyStats } from '../db/repositories/types.js';
import type { CommandContext } from './index.js';

function formatReport(stats: DailyStats): string {
  const lines = [
    `📊 *Reporte Diario* — ${stats.date}`,
    '',
    `👥 Total conversaciones: ${stats.totalConversations}`,
    `🆕 Nuevas hoy: ${stats.newConversations}`,
    `✅ Activas: ${stats.activeConversations}`,
    `📨 Mensajes entrantes: ${stats.messagesInbound}`,
    `📤 Mensajes salientes: ${stats.messagesOutbound}`,
    `🔥 Hot leads (>=${env.HOT_LEAD_THRESHOLD}): ${stats.hotLeads} (${stats.hotLeadPercentage}%)`,
    `🚫 Opt-out hoy: ${stats.optedOut}`,
    `🤝 Handed off hoy: ${stats.handedOff}`,
    `💤 Soft closed hoy: ${stats.softClosed}`,
    `💰 IA gastada: $${stats.aiSpentUsd.toFixed(4)}`,
  ];

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
  return formatReport(stats);
}
