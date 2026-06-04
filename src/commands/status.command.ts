import { env } from '../config/env.js';
import type { LineLeadCount } from '../db/repositories/types.js';
import { getLineById, getRoutingConfig } from '../services/lead-routing.js';
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

export async function statusHandler(ctx: CommandContext): Promise<string> {
  const paused = ctx.repos.isPaused();
  const uptime = fmtUptime(process.uptime());

  const todayUtc = new Date();
  const todayStart = new Date(Date.UTC(
    todayUtc.getUTCFullYear(),
    todayUtc.getUTCMonth(),
    todayUtc.getUTCDate(),
  )).toISOString();

  const stats = ctx.repos.stats.getDailyStats(todayStart, env.HOT_LEAD_THRESHOLD);
  const byLine = ctx.repos.stats.getLeadCountsByLine(env.HOT_LEAD_THRESHOLD);
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
  parts.push('', '_Usa /report para detalle completo._');

  return parts.join('\n');
}
