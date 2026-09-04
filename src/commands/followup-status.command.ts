import { env } from '../config/env.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { canAccessConversation } from '../services/access-control.js';
import {
  consentThresholdMs,
  devAllowlist,
  hasFollowupPermission,
  parseStoredTimestamp,
  FREE_FORM_WINDOW_MS,
} from '../services/followup-service.js';
import { consentCycleKey } from '../services/followup-consent.js';
import type { ConversationRow } from '../db/repositories/types.js';
import type { CommandContext } from './index.js';

const EVENT_LIMIT = 8;

function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return '—';
  // Same parser the scheduler uses, so the diagnostic can never disagree with the
  // timing it is supposed to explain.
  const parsed = parseStoredTimestamp(iso);
  if (Number.isNaN(parsed)) return iso;
  const seconds = Math.floor((now - parsed) / 1000);
  if (seconds < 60) return `hace ${seconds}s`;
  if (seconds < 3600) return `hace ${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `hace ${Math.floor(seconds / 3600)}h`;
  return `hace ${Math.floor(seconds / 86_400)}d`;
}

/**
 * Mirrors the blocking clauses of `listConsentAskCandidates`. Kept as an explicit
 * list so the operator sees WHICH gate rejected the lead — the whole point of the
 * command is to stop guessing why an ask never fired.
 */
function candidacyBlockers(conv: ConversationRow): string[] {
  const blockers: string[] = [];
  if (conv.opt_out_at) blockers.push('opt_out_at');
  if (conv.converted_at) blockers.push('converted_at');
  if (conv.handed_off_at) blockers.push('handed_off_at');
  if (conv.soft_closed_at) blockers.push('soft_closed_at');
  const mode = conv.conversation_mode ?? 'bot';
  if (mode !== 'bot' && mode !== 'human_pending') blockers.push(`mode=${mode}`);
  if (conv.lead_intent === 'not_interested') blockers.push('lead_intent=not_interested');
  const qualified = !!conv.collected_plan || conv.collected_people != null || !!conv.price_given_at;
  if (!qualified) blockers.push('no calificado (sin plan, personas ni precio dado)');
  return blockers;
}

export async function followupStatusHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0]?.replace(/\D/g, '');
  if (!phone) return 'Uso: /followupstatus <telefono>';

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (!conv) return bridgeMessages.leadNotFound(phone);
  if (!canAccessConversation(ctx.repos, ctx.chatId, phone)) return bridgeMessages.leadAssignedToOther;

  const now = Date.now();
  const subscription = ctx.repos.followupSubscription.getByPhone(phone);
  const events = ctx.repos.followupSubscriptionEvent.listByPhone(phone, EVENT_LIMIT);
  const lastInbound = ctx.repos.message.getLastInboundAt(phone);
  const lastDirection = ctx.repos.message.getLastMessageDirection(phone);

  const lines: string[] = ['*Follow-up*', `Phone: ${phone}`];

  lines.push('', '*Switches*');
  lines.push(`consent ask: ${env.FOLLOWUP_CONSENT_ASK_ENABLED ? 'ON' : 'OFF'}`);
  lines.push(`one-shot template: ${env.ALLOW_FOLLOWUP_TEMPLATE ? 'ON' : 'OFF'}`);
  lines.push(`recurring: ${env.FOLLOWUP_RECURRING_ENABLED ? 'ON' : 'OFF'}`);
  const allowlist = devAllowlist();
  if (allowlist.length > 0) {
    lines.push(`dev allowlist: ${allowlist.includes(phone) ? 'incluye este numero' : 'EXCLUYE este numero'}`);
  }

  // Permission is one predicate over two provenances (AGENTS.md invariant 10), and
  // the one-shot template reads exactly this. Showing only the subscription hid the
  // operator grant, so an operator could not tell whether a template was authorised
  // or by whom.
  //
  // The verdict itself comes from the predicate the SENDER uses — never a local copy
  // of the OR. A duplicated expression here reported "SI" for a lead who had declined
  // while still carrying an operator grant, i.e. the diagnostic contradicted the send
  // path it exists to explain. The two provenance lines below stay independent reads,
  // because their job is to show WHO authorised it, not whether it is authorised.
  const operatorGrant = ctx.repos.followupConsent.hasConsent(phone);
  const customerConsent = subscription?.status === 'active';
  const authorised = hasFollowupPermission(ctx.repos, phone);
  lines.push('', '*Permiso*');
  lines.push(`plantilla autorizada: ${authorised ? 'SI' : 'NO'}`);
  lines.push(`  via operador (/followupgrant): ${operatorGrant ? 'si' : 'no'}`);
  lines.push(`  via cliente ("si"): ${customerConsent ? 'si' : 'no'}`);
  if (!authorised && operatorGrant && subscription?.status === 'declined') {
    lines.push('  NOTA: el cliente respondio NO; su negativa anula el permiso del operador.');
  }

  // The live rows above are mutable; this ledger is append-only and is the only
  // place that can answer "when, and by whom?". An EMPTY history is not evidence of
  // refusal — rows before 2026-09-03 do not exist.
  const decisions = ctx.repos.followupConsentGrant.listByPhone(phone, 5);
  if (decisions.length === 0) {
    lines.push('historial: sin registros (anterior al ledger)');
  } else {
    for (const decision of decisions) {
      const actor = decision.actor_id ? `, ${decision.actor_id}` : '';
      lines.push(`historial: ${decision.decision} (${decision.source}${actor}) ${ago(decision.decided_at, now)}`);
    }
  }

  lines.push('', '*Suscripcion*');
  if (!subscription) {
    lines.push('sin registro (se crea al primer ask)');
  } else {
    lines.push(`status: ${subscription.status}`);
    lines.push(`asked_at: ${ago(subscription.asked_at, now)}`);
    // `consent_session` drives the cycle key, so both are shown: an operator
    // debugging a missing ask needs to know which event row to look for.
    // `followup_subscriptions.ask_attempts` is deliberately NOT shown — no code
    // writes it, so it always reads 0. Real attempts live on the event rows below.
    lines.push(`sesion de consentimiento: ${subscription.consent_session} (cycle_key ${consentCycleKey(subscription.consent_session)})`);
    lines.push(`deferral usada: ${subscription.deferred_reask_used ? 'si' : 'no'}`);
    if (subscription.decided_at) lines.push(`decided_at: ${ago(subscription.decided_at, now)}`);
    if (subscription.activated_at) lines.push(`activated_at: ${ago(subscription.activated_at, now)}`);
    if (subscription.revoked_at) lines.push(`revoked_at: ${ago(subscription.revoked_at, now)} (${subscription.revoke_source ?? '—'})`);
  }

  lines.push('', '*Timing*');
  const thresholdMs = consentThresholdMs();
  lines.push(`ultimo inbound: ${ago(lastInbound, now)}`);
  lines.push(`ultimo mensaje: ${lastDirection ?? '—'}`);
  lines.push(`silencio requerido: ${Math.round(thresholdMs / 1000)}s`);
  if (lastInbound) {
    const silentMs = now - parseStoredTimestamp(lastInbound);
    const remaining = thresholdMs - silentMs;
    lines.push(remaining > 0
      ? `faltan ~${Math.ceil(remaining / 1000)}s de silencio`
      : 'silencio suficiente');
    // The free-form window is measured from THEIR message, not ours. Shared
    // constant, so this can never drift from the scheduler's own cutoff.
    const windowLeftMs = FREE_FORM_WINDOW_MS - silentMs;
    lines.push(windowLeftMs > 0
      ? `ventana 24h: abierta (~${Math.floor(windowLeftMs / 3_600_000)}h)`
      : 'ventana 24h: CERRADA (solo plantilla)');
  }

  // Every blocker is collected BEFORE deciding the verdict. Reporting "elegible"
  // while one of these still holds would make the diagnostic lie, which is worse
  // than having no diagnostic at all.
  const blockers = candidacyBlockers(conv);
  if (subscription && subscription.status !== 'unasked') {
    blockers.push(`suscripcion en '${subscription.status}' (solo 'unasked' es elegible)`);
  }
  // The SQL requires an outbound AFTER the last inbound: the ask only goes to a
  // customer who never replied to us.
  if (lastDirection === 'inbound') {
    blockers.push('el ultimo mensaje es del cliente (debe ser nuestro)');
  }
  if (allowlist.length > 0 && !allowlist.includes(phone)) {
    blockers.push('excluido por FOLLOWUP_DEV_ALLOWLIST_PHONES');
  }
  if (!env.FOLLOWUP_CONSENT_ASK_ENABLED) {
    blockers.push('FOLLOWUP_CONSENT_ASK_ENABLED=false');
  }
  // The failure mode this command exists for: the cycle burned every bounded
  // attempt, so `claim()` refuses forever while the SQL keeps serving the lead.
  // Nothing recovers automatically — either a new session (the bounded deferral or an
  // opt-out reopen) mints a fresh cycle_key, or an operator runs /followupretry.
  if (subscription) {
    const currentCycle = consentCycleKey(subscription.consent_session);
    const currentEvent = ctx.repos.followupSubscriptionEvent
      .getByPhoneKindCycle(phone, 'consent_ask', currentCycle);
    if (currentEvent && currentEvent.status === 'failed' && currentEvent.attempts >= env.FOLLOWUP_MAX_ATTEMPTS) {
      blockers.push(
        `ciclo ${currentCycle} AGOTADO (${currentEvent.attempts}/${env.FOLLOWUP_MAX_ATTEMPTS} intentos, ${currentEvent.error_reason ?? 'sin motivo'}) — /followupretry ${phone} o nueva sesion`,
      );
    }
  }

  lines.push('', '*Bloqueos*');
  if (blockers.length === 0) {
    lines.push('ninguno — elegible cuando se cumpla el silencio');
  } else {
    for (const blocker of blockers) lines.push(`• ${blocker}`);
  }

  lines.push('', `*Eventos* (${events.length})`);
  if (events.length === 0) lines.push('ninguno');
  for (const event of events) {
    const detail = event.error_reason ? ` — ${event.error_reason.slice(0, 60)}` : '';
    lines.push(`${event.event_kind} ${event.cycle_key}: ${event.status} (att ${event.attempts ?? 0}, ${ago(event.updated_at ?? event.scheduled_for, now)})${detail}`);
  }

  return lines.join('\n');
}
