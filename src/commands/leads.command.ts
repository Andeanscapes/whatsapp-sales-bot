import { env } from '../config/env.js';
import type { ConversationSummary } from '../db/repositories/types.js';
import { resolveCallerLineId } from '../services/access-control.js';
import { getReportExcludedPhones } from '../services/report-exclusions.js';
import type { CommandContext } from './index.js';

function formatLeads(leads: ConversationSummary[]): string {
  if (leads.length === 0) return 'No hay hot leads activos.';

  const lines = [`🔥 *Top ${leads.length} Hot Leads*`, ''];
  for (let i = 0; i < leads.length; i++) {
    const l = leads[i];
    const name = l.name?.slice(0, 40) ?? '—';
    const people = l.people ? `${l.people} pers` : '—';
    const date = l.date ? l.date.slice(0, 10) : '—';
    const plan = l.plan?.slice(0, 40) ?? '—';
    const group = l.adults != null || l.children != null
      ? `${l.adults ?? 0}A/${l.children ?? 0}N`
      : people;
    const origin = l.travelOrigin?.slice(0, 30) ?? '—';
    const entry = l.entryMarker ? `${l.entryMarker}/${l.entryTemperature ?? 'unknown'}` : '—';
    lines.push(`${i + 1}. ${l.customerPhone} | ${name} | ${l.score} pts | ${plan} | ${group} | ${date} | ${origin} | ${entry}`);
  }
  return lines.join('\n');
}

export async function leadsHandler(ctx: CommandContext): Promise<string> {
  const requestedLimit = parseInt(ctx.args[0], 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 15) : 10;
  const lineId = resolveCallerLineId(ctx.chatId);
  const leads = ctx.repos.stats.getTopLeads(limit, env.HOT_LEAD_THRESHOLD, lineId, getReportExcludedPhones());
  return formatLeads(leads);
}
