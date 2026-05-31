import { env } from '../config/env.js';
import type { ConversationSummary } from '../db/repositories/types.js';
import type { CommandContext } from './index.js';

function formatLeads(leads: ConversationSummary[]): string {
  if (leads.length === 0) return 'No hay hot leads activos.';

  const lines = [`🔥 *Top ${leads.length} Hot Leads*`, ''];
  for (let i = 0; i < leads.length; i++) {
    const l = leads[i];
    const name = l.name ?? '—';
    const people = l.people ? `${l.people} pers` : '—';
    const date = l.date ? l.date.slice(0, 10) : '—';
    const plan = l.plan ?? '—';
    lines.push(`${i + 1}. ${l.customerPhone} | ${name} | ${l.score} pts | ${plan} | ${people} | ${date}`);
  }
  return lines.join('\n');
}

export async function leadsHandler(ctx: CommandContext): Promise<string> {
  const limit = parseInt(ctx.args[0], 10) || 10;
  const leads = ctx.repos.stats.getTopLeads(limit, env.HOT_LEAD_THRESHOLD);
  return formatLeads(leads);
}
