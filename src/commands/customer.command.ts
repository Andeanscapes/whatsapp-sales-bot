import type { ConversationRow, RecentMessage } from '../db/repositories/types.js';
import { canAccessConversation } from '../services/access-control.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { formatAdReferral } from '../services/ad-referral.js';
import { formatChildAges } from '../services/qualification-format.js';
import { emitTranscript, formatTranscriptFooter, parseTurnLimit } from './transcript-blocks.js';
import { normalizeCommandPhone } from './phone.js';
import type { CommandContext } from './index.js';

const DEFAULT_TURNS = 6;
const MAX_TURNS = 40;

function md(text: string): string {
  return text.replace(/([*_`[])/g, '\\$1');
}

function formatCustomer(conv: ConversationRow, recentMessages: RecentMessage[]): string {
  const fields: string[] = [];

  if (conv.collected_name) fields.push(`Nombre: ${md(conv.collected_name)}`);
  fields.push(`Telefono: ${md(conv.customer_phone)}`);
  fields.push(`Score: ${conv.lead_score} | Fase: ${md(conv.sales_phase ?? '—')}`);
  if (conv.language) fields.push(`Idioma: ${md(conv.language)}`);
  if (conv.collected_date) fields.push(`Fecha: ${md(conv.collected_date.slice(0, 10))}`);
  if (conv.collected_people) fields.push(`Personas: ${conv.collected_people}`);
  if (conv.collected_adults != null) fields.push(`Adultos: ${conv.collected_adults}`);
  if (conv.collected_children != null) fields.push(`Ninos: ${conv.collected_children}`);
  const childAges = formatChildAges(conv.collected_child_ages_json);
  if (childAges) fields.push(`Edades ninos: ${childAges}`);
  if (conv.collected_travel_origin) fields.push(`Origen: ${md(conv.collected_travel_origin)}`);
  if (conv.collected_plan) fields.push(`Plan: ${md(conv.collected_plan)}`);
  if (conv.collected_transport_need) fields.push(`Transporte: ${md(conv.collected_transport_need)}`);
  if (conv.collected_lodging_need) fields.push(`Hospedaje: ${md(conv.collected_lodging_need)}`);
  if (conv.collected_pet) fields.push(`Mascota: ${md(conv.collected_pet)}`);
  if (conv.lead_intent) fields.push(`Intencion: ${md(conv.lead_intent)}`);
  if (conv.handed_off_at) fields.push(`Handed off: ${md(conv.handed_off_at.slice(0, 10))}`);
  if (conv.soft_closed_at) fields.push(`Soft closed: ${md(conv.soft_closed_at.slice(0, 10))}`);
  if (conv.opt_out_at) fields.push(`Opt-out: ${md(conv.opt_out_at.slice(0, 10))}`);
  if (conv.entry_marker) fields.push(`Entrada: ${md(conv.entry_marker)} (${md(conv.entry_temperature ?? 'unknown')})`);
  const adReferral = formatAdReferral(conv.ad_referral_json);
  if (adReferral) fields.push(`Anuncio: ${md(adReferral)}`);

  const lines = ['👤 *Perfil de Cliente*', '', ...fields];

  if (recentMessages.length > 0) {
    lines.push('', '💬 *Ultimos mensajes:*');
    for (const m of recentMessages.slice(-6)) {
      const arrow = m.role === 'user' ? '←' : '→';
      const text = m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content;
      lines.push(`${arrow} ${md(text)}`);
    }
  }

  return lines.join('\n');
}

export async function customerHandler(ctx: CommandContext): Promise<string> {
  const phone = normalizeCommandPhone(ctx.args[0]);
  if (!phone) return 'Uso: /customer <telefono>';

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (!conv) return bridgeMessages.leadNotFound(phone);

  if (!canAccessConversation(ctx.repos, ctx.chatId, phone)) return bridgeMessages.leadAssignedToOther;

  const limit = parseTurnLimit(ctx.args[1], DEFAULT_TURNS, MAX_TURNS);

  // Without an emitter (offline callers, tests) keep the compact text card.
  if (!ctx.emit) {
    return formatCustomer(conv, ctx.repos.message.getRecentMessages(phone, limit));
  }

  ctx.emit({ kind: 'text', text: formatCustomer(conv, []), parseMode: 'Markdown' });
  const stats = await emitTranscript(ctx, phone, limit);
  return formatTranscriptFooter(stats, limit);
}
