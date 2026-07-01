import type { ConversationSummary } from '../db/repositories/types.js';
import { resolveCallerLineId } from '../services/access-control.js';
import { getReportExcludedPhones } from '../services/report-exclusions.js';
import type { CommandContext } from './index.js';

function formatRecent(conversations: ConversationSummary[]): string {
  if (conversations.length === 0) return 'No hay actividad reciente.';

  const lines = [`🕐 *Actividad Reciente*`, ''];
  for (const c of conversations) {
    const name = c.name ?? '—';
    const phase = c.phase ?? '—';
    const ts = new Date(c.lastSeenAt);
    const time = ts.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    lines.push(`${c.customerPhone} | ${name} | ${c.score} | ${phase} | ${time}`);
  }
  return lines.join('\n');
}

export async function recentHandler(ctx: CommandContext): Promise<string> {
  const limit = parseInt(ctx.args[0], 10) || 5;
  const lineId = resolveCallerLineId(ctx.chatId);
  const conversations = ctx.repos.stats.getRecentInboundAfterFirstReply(limit, lineId, getReportExcludedPhones());
  return formatRecent(conversations);
}
