import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { CommandContext } from './index.js';
import { normalizeCommandPhone } from './phone.js';

export async function followupGrantHandler(ctx: CommandContext): Promise<string> {
  const phone = normalizeCommandPhone(ctx.args[0]);
  // The registered command name is `followupgrant`: `parseCommand` accepts only
  // [a-zA-Z0-9_], so printing a hyphenated name sends the operator to a command that
  // cannot dispatch (AGENTS.md item 13).
  if (!phone) return 'Uso: /followupgrant <telefono>';

  // Consent must attach to a real conversation: a typo would otherwise create an
  // orphan opt-in row that never matches a lead.
  if (!ctx.repos.conversation.getByPhone(phone)) {
    return `No hay conversacion para ${phone}. Verifica el numero.`;
  }

  // An operator grant cannot overrule the customer's own "no". `hasFollowupPermission`
  // treats `declined` as final, so recording the grant here would produce a row that
  // never authorises a send — an operator told "listo" for an outbound that silently
  // never happens.
  if (ctx.repos.followupSubscription.getByPhone(phone)?.status === 'declined') {
    return `${phone} respondio NO a la solicitud de permiso. `
      + 'No se puede autorizar por encima de una negativa del cliente.';
  }

  const grantedBy = `telegram:${ctx.chatId}`;
  // Live row and audit row commit together: a grant the ledger never saw would leave
  // the same unanswerable history this table exists to prevent.
  ctx.repos.runInTransaction(() => {
    ctx.repos.followupConsent.grantConsent(phone, grantedBy);
    ctx.repos.followupConsentGrant.record({
      customer_phone: phone,
      decision: 'grant',
      decided_at: new Date().toISOString(),
      source: 'operator_grant',
      actor_id: grantedBy,
      app_version: env.APP_VERSION,
    });
  });
  logger.info({ phone, grantedBy }, '[FOLLOWUP] consent granted');
  return `Consentimiento de follow-up registrado para ${phone}.`;
}
