import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { canAccessConversation } from '../services/access-control.js';
import { consentCycleKey } from '../services/followup-consent.js';
import { forgetExhaustedCycleReport } from '../services/followup-service.js';
import type { CommandContext } from './index.js';
import { normalizeCommandPhone } from './phone.js';

/**
 * Re-arms a consent-ask cycle that burned every bounded attempt.
 *
 * Exhaustion is permanent by design — nothing recovers it automatically, because an
 * automatic reset would let a persistently malformed draft loop on the provider's
 * bill forever. But leaving it to a new consent session means a lead whose three
 * attempts all failed is silently unreachable until they write in again, which is
 * exactly the incident this command exists for. An operator action is the bounded
 * middle ground: explicit, audited, one cycle at a time.
 */
export async function followupRetryHandler(ctx: CommandContext): Promise<string> {
  const phone = normalizeCommandPhone(ctx.args[0]);
  if (!phone) return 'Uso: /followupretry <telefono>';

  if (!ctx.repos.conversation.getByPhone(phone)) return bridgeMessages.leadNotFound(phone);
  if (!canAccessConversation(ctx.repos, ctx.chatId, phone)) return bridgeMessages.leadAssignedToOther;

  const subscription = ctx.repos.followupSubscription.getByPhone(phone);
  if (!subscription) return `No hay suscripcion de follow-up para ${phone}. Nada que reintentar.`;

  const cycleKey = consentCycleKey(subscription.consent_session);
  const event = ctx.repos.followupSubscriptionEvent.getByPhoneKindCycle(phone, 'consent_ask', cycleKey);
  if (!event) return `No hay evento consent_ask ${cycleKey} para ${phone}.`;
  if (event.status !== 'failed') {
    return `El ciclo ${cycleKey} esta en '${event.status}', no agotado. Solo se reintentan ciclos 'failed'.`;
  }
  if (event.attempts < env.FOLLOWUP_MAX_ATTEMPTS) {
    return `El ciclo ${cycleKey} aun tiene intentos (${event.attempts}/${env.FOLLOWUP_MAX_ATTEMPTS}). No hace falta reintentar.`;
  }

  if (!ctx.repos.followupSubscriptionEvent.resetExhaustedCycle(phone, 'consent_ask', cycleKey)) {
    return `No se pudo reintentar el ciclo ${cycleKey} de ${phone}.`;
  }

  // The exhaustion notice is gated per process so it only fires once. Forget just
  // THIS cycle, so a second exhaustion after the retry is still observable without
  // re-alerting every other lead that already reported this boot.
  forgetExhaustedCycleReport(phone, cycleKey);

  const requestedBy = `telegram:${ctx.chatId}`;
  logger.info(
    { phone, cycleKey, previousReason: event.error_reason, requestedBy },
    '[FOLLOWUP] consent ask cycle reset by operator',
  );
  return `Ciclo ${cycleKey} de ${phone} reiniciado (era: ${event.error_reason ?? 'sin motivo'}). `
    + 'Se reintentara cuando se cumplan silencio y ventana de 24h.';
}
