import type { ConversationRow, RecentMessage } from '../db/repositories/types.js';
import type { CommandContext } from './index.js';

function formatCustomer(conv: ConversationRow, recentMessages: RecentMessage[]): string {
  const fields: string[] = [];

  if (conv.collected_name) fields.push(`Nombre: ${conv.collected_name}`);
  fields.push(`Telefono: ${conv.customer_phone}`);
  fields.push(`Score: ${conv.lead_score} | Fase: ${conv.sales_phase ?? '—'}`);
  if (conv.language) fields.push(`Idioma: ${conv.language}`);
  if (conv.collected_date) fields.push(`Fecha: ${conv.collected_date.slice(0, 10)}`);
  if (conv.collected_people) fields.push(`Personas: ${conv.collected_people}`);
  if (conv.collected_plan) fields.push(`Plan: ${conv.collected_plan}`);
  if (conv.collected_transport_need) fields.push(`Transporte: ${conv.collected_transport_need}`);
  if (conv.collected_lodging_need) fields.push(`Hospedaje: ${conv.collected_lodging_need}`);
  if (conv.collected_pet) fields.push(`Mascota: ${conv.collected_pet}`);
  if (conv.lead_intent) fields.push(`Intencion: ${conv.lead_intent}`);
  if (conv.handed_off_at) fields.push(`Handed off: ${conv.handed_off_at.slice(0, 10)}`);
  if (conv.soft_closed_at) fields.push(`Soft closed: ${conv.soft_closed_at.slice(0, 10)}`);
  if (conv.opt_out_at) fields.push(`Opt-out: ${conv.opt_out_at.slice(0, 10)}`);

  const lines = ['👤 *Perfil de Cliente*', '', ...fields];

  if (recentMessages.length > 0) {
    lines.push('', '💬 *Ultimos mensajes:*');
    for (const m of recentMessages.slice(-6)) {
      const arrow = m.role === 'user' ? '←' : '→';
      const text = m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content;
      lines.push(`${arrow} ${text}`);
    }
  }

  return lines.join('\n');
}

export async function customerHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0];
  if (!phone) return 'Uso: /customer <telefono>';

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (!conv) return `No se encontro conversacion para ${phone}`;

  const messages = ctx.repos.message.getRecentMessages(phone, 6);
  return formatCustomer(conv, messages);
}
