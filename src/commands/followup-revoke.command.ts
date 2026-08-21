import { logger } from '../config/logger.js';
import type { CommandContext } from './index.js';
import { normalizeCommandPhone } from './phone.js';

export async function followupRevokeHandler(ctx: CommandContext): Promise<string> {
  const phone = normalizeCommandPhone(ctx.args[0]);
  if (!phone) return 'Uso: /followup-revoke <telefono>';

  // Revocation is unconditional — never blocked by a missing conversation.
  // Revokes BOTH paths: the operator-granted one-shot consent and the
  // customer-granted recurring subscription.
  ctx.repos.runInTransaction(() => {
    ctx.repos.followupConsent.revokeConsent(phone);
    ctx.repos.followupSubscription.ensureExists(phone);
    ctx.repos.followupSubscription.revoke(phone, 'operator');
  });
  logger.info({ phone }, '[FOLLOWUP] consent revoked');
  return `Consentimiento de follow-up revocado para ${phone}.`;
}
