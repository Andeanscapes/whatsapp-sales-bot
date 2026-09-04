import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { CommandContext } from './index.js';
import { normalizeCommandPhone } from './phone.js';

export async function followupRevokeHandler(ctx: CommandContext): Promise<string> {
  const phone = normalizeCommandPhone(ctx.args[0]);
  // Registered name is `followuprevoke`; a hyphen cannot dispatch (AGENTS.md item 13).
  if (!phone) return 'Uso: /followuprevoke <telefono>';

  // Revocation is unconditional — never blocked by a missing conversation.
  // Revokes BOTH paths: the operator-granted one-shot consent and the
  // customer-granted recurring subscription.
  ctx.repos.runInTransaction(() => {
    ctx.repos.followupConsent.revokeConsent(phone);
    ctx.repos.followupSubscription.ensureExists(phone);
    ctx.repos.followupSubscription.revoke(phone, 'operator');
    ctx.repos.followupConsentGrant.record({
      customer_phone: phone,
      decision: 'revoke',
      decided_at: new Date().toISOString(),
      source: 'operator_revoke',
      actor_id: `telegram:${ctx.chatId}`,
      app_version: env.APP_VERSION,
    });
  });
  logger.info({ phone }, '[FOLLOWUP] consent revoked');
  return `Consentimiento de follow-up revocado para ${phone}.`;
}
