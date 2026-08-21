import { logger } from '../config/logger.js';
import type { CommandContext } from './index.js';
import { normalizeCommandPhone } from './phone.js';

export async function followupGrantHandler(ctx: CommandContext): Promise<string> {
  const phone = normalizeCommandPhone(ctx.args[0]);
  if (!phone) return 'Uso: /followup-grant <telefono>';

  // Consent must attach to a real conversation: a typo would otherwise create an
  // orphan opt-in row that never matches a lead.
  if (!ctx.repos.conversation.getByPhone(phone)) {
    return `No hay conversacion para ${phone}. Verifica el numero.`;
  }

  const grantedBy = `telegram:${ctx.chatId}`;
  ctx.repos.followupConsent.grantConsent(phone, grantedBy);
  logger.info({ phone, grantedBy }, '[FOLLOWUP] consent granted');
  return `Consentimiento de follow-up registrado para ${phone}.`;
}
