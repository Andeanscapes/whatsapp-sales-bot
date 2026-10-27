import { env } from '../config/env.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { hasRoutingConfig } from '../services/lead-routing.js';
import { normalizeCommandPhone } from './phone.js';
import type { CommandContext } from './index.js';

export async function blockHandler(ctx: CommandContext): Promise<string> {
  // Digits-only, like every stored `customer_phone`. A raw `+57 300…` arg used to
  // be written verbatim by setOptOut, creating a phantom opted-out row that never
  // matched the real conversation — a block that silently blocked nothing.
  const phone = normalizeCommandPhone(ctx.args[0]);
  if (!phone) return 'Uso: /block <telefono>';

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (hasRoutingConfig()) {
    if (!conv) return bridgeMessages.leadNotFound(phone);
    const assignment = ctx.repos.conversation.getAssignment(phone);
    if (!assignment) return bridgeMessages.leadNotAssigned;
    if (assignment.assignedAgentChat !== String(ctx.chatId)) return bridgeMessages.leadAssignedToOther;
  }
  // Operator block is permanent until an operator explicitly changes it. Even if
  // the customer had already opted out, overwrite the subscription provenance so
  // a later inbound cannot reopen the consent opportunity automatically.
  ctx.repos.runInTransaction(() => {
    ctx.repos.optOut.setOptOut(phone);
    ctx.repos.followupSubscription.ensureExists(phone);
    ctx.repos.followupSubscription.revoke(phone, 'operator');
    ctx.repos.followupConsent.revokeConsent(phone);
    // `/block` mutates permission, so it appends like every other permission change
    // (AGENTS.md invariant 10). Omitting it left an operator block with no entry in
    // the audit trail, so "who ended this permission, and when?" was unanswerable
    // for exactly the action that is meant to be permanent.
    ctx.repos.followupConsentGrant.record({
      customer_phone: phone,
      decision: 'revoke',
      decided_at: new Date().toISOString(),
      source: 'operator_revoke',
      actor_id: `telegram:${ctx.chatId}`,
      app_version: env.APP_VERSION,
    });
  });
  if (conv && conv.opt_out_at) return `🔄 ${phone} ya estaba bloqueado; bloqueo de operador confirmado.`;

  return `🚫 ${phone} bloqueado (opt-out).`;
}
