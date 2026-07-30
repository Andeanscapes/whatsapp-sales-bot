import { metaAudienceCsv } from '../services/meta-audience-export.js';
import { sendTelegramDocument } from '../services/telegram-document.js';
import type { CommandContext } from './index.js';

export async function metaLeadsHandler(ctx: CommandContext): Promise<string> {
  const { csv, skipped } = metaAudienceCsv(ctx.repos.conversation.listMetaAudienceLeads());
  const exported = Math.max(0, csv.trimEnd().split('\n').length - 1);
  const filename = `andean-meta-leads-${new Date().toISOString().slice(0, 10)}.csv`;

  try {
    const sent = await sendTelegramDocument(
      ctx.chatId,
      Buffer.from(csv, 'utf-8'),
      filename,
      'text/csv',
      `Leads sin reserva: ${exported}`,
    );
    if (!sent) return 'No se pudo enviar el CSV. Verifica la configuracion de Telegram.';
  } catch {
    return 'No se pudo enviar el CSV. Intenta de nuevo.';
  }

  return `CSV enviado: ${exported} leads sin reserva${skipped ? `, ${skipped} omitidos` : ''}.`;
}
