import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { Repositories } from '../db/repositories/index.js';
import type { FollowupSubscriptionEventKind } from '../db/repositories/types.js';
import { bogotaLocalToUtcIso, getBogotaCalendarDate, type CalendarDate } from './colombia-calendar.js';
import {
  FREE_FORM_WINDOW_MS,
  consentThresholdMs,
  devAllowlist,
  parseStoredTimestamp,
  recurringDueBeforeIso,
  recurringMinSilenceMs,
  recurringNextDueAt,
  silenceThresholdHours,
} from './followup-service.js';

/**
 * Operator-only visibility into the follow-up pipeline: what is scheduled for a
 * Colombia-local day, and what already reached Meta with whether the customer
 * answered.
 *
 * This module NEVER writes to a customer. It reads state and renders text for the
 * owner's Telegram chat, so it is not a fourth outbound path (AGENTS.md invariant
 * 10) and carries no customer-facing sales copy (invariant 9).
 *
 * Gate reuse is deliberate: the three candidate queries on `ConversationRepository`
 * are pure reads, so the digest calls them with widened cutoffs and applies the
 * exact timing math from `followup-service`. Re-implementing the eligibility gates
 * in TypeScript would be a third copy — `followup-status.command.ts` already carries
 * one and documents the drift risk.
 */

/** Bogota is fixed UTC-5, so a local day is exactly 24h with no DST seam. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Reporting bound per path. Deliberately NOT `FOLLOWUP_MAX_SENDS_PER_TICK`: that is
 * a send-batch limit, and borrowing it would silently truncate the report to the
 * size of one tick.
 */
const SCAN_LIMIT = 500;

/**
 * Entries listed per section, beyond which the section reports a count only.
 * A cap on the SECTION, not per path — the counts line above it already breaks the
 * total down by path.
 */
const MAX_LISTED_ENTRIES = 12;

/**
 * Telegram hard-fails a text message over 4096 chars. The scheduled push
 * concatenates two sections, so the bound is enforced on the assembled body rather
 * than trusted to the per-section caps.
 */
const MAX_TELEGRAM_TEXT_CHARS = 4000;

export type DigestPath = 'one_shot' | 'consent_ask' | 'recurring';

export interface ScheduledFollowup {
  phone: string;
  path: DigestPath;
  /** Exact instant the sender becomes eligible. */
  dueAt: Date;
  /** True when `dueAt` already passed: it fires on the next tick, not later today. */
  overdue: boolean;
  /** Consent-scoped cycle label where the path has one (`c2`, `c1-r3`). */
  cycleLabel?: string;
}

export interface SentFollowup {
  phone: string;
  path: DigestPath;
  sentAt: Date;
  /** Meta accepted but delivery is unconfirmed (terminal, never retried). */
  uncertain: boolean;
  /** An inbound arrived after the send. */
  answered: boolean;
  /** For consent asks: what the customer's answer resolved to. */
  consentOutcome?: 'active' | 'declined' | 'pending' | 'revoked' | 'unasked';
}

export interface DigestWindow {
  /** Colombia-local calendar day the digest describes. */
  day: CalendarDate;
  startIso: string;
  /** Exclusive. */
  endIso: string;
}

export interface FollowupDigest {
  window: DigestWindow;
  scheduled: ScheduledFollowup[];
  sent: SentFollowup[];
  /** Non-empty only in dev, where it suppresses every non-listed lead. */
  devAllowlistActive: boolean;
}

/** The Colombia-local day containing `instant`, as an exclusive UTC range. */
export function bogotaDayWindow(instant: Date): DigestWindow {
  const local = getBogotaCalendarDate(instant);
  const day: CalendarDate = { year: local.year, month: local.month, day: local.day };
  const startIso = bogotaLocalToUtcIso(day, 0, 0);
  return {
    day,
    startIso,
    endIso: new Date(new Date(startIso).getTime() + MS_PER_DAY).toISOString(),
  };
}

/** The Colombia-local day before the one containing `instant`. */
export function previousBogotaDayWindow(instant: Date): DigestWindow {
  const today = bogotaDayWindow(instant);
  return bogotaDayWindow(new Date(new Date(today.startIso).getTime() - MS_PER_DAY / 2));
}

function isAllowlisted(phone: string, allowlist: string[]): boolean {
  return allowlist.length === 0 || allowlist.includes(phone);
}

/**
 * Bounds for a scheduling projection.
 *
 * `reachableFromMs` is the reported day's start clamped forward to the reference
 * instant, because a send opportunity that already elapsed cannot be scheduled. It
 * is what keeps the digest from listing a consent ask whose free-form window shut
 * hours before the report ran. `referenceMs` only decides the `overdue` flag.
 */
interface ProjectionSpan {
  startMs: number;
  endMs: number;
  referenceMs: number;
  reachableFromMs: number;
}

/**
 * One-shot template: due at `last_inbound + silence threshold`.
 *
 * The SQL gate requires the silence to have ALREADY elapsed, so projecting forward
 * means passing a cutoff shifted to the end of the window. Rows whose due instant
 * is before the window start are still reported, flagged `overdue` — they fire on
 * the next tick, and hiding them would make the digest look empty while sends
 * happen.
 */
function projectOneShot(repos: Repositories, span: ProjectionSpan, allowlist: string[]): ScheduledFollowup[] {
  const thresholdMs = silenceThresholdHours() * 3_600_000;
  const candidates = repos.conversation.listFollowupCandidates({
    silentSinceIso: new Date(span.endMs - thresholdMs).toISOString(),
    limit: SCAN_LIMIT,
  });

  const scheduled: ScheduledFollowup[] = [];
  for (const candidate of candidates) {
    if (!isAllowlisted(candidate.customer_phone, allowlist)) continue;
    const anchorMs = parseStoredTimestamp(candidate.anchor_at);
    if (Number.isNaN(anchorMs)) continue;
    const dueAt = new Date(anchorMs + thresholdMs);
    scheduled.push({
      phone: candidate.customer_phone,
      path: 'one_shot',
      dueAt,
      overdue: dueAt.getTime() < span.referenceMs,
    });
  }
  return scheduled;
}

/**
 * Consent ask: due at `last_inbound + consent threshold`, but only while the 24h
 * free-form window is still open.
 *
 * In production the eligible band is roughly 50 minutes wide (23h threshold inside
 * a 23h50m window), so the SQL scan is widened at BOTH ends and the exact band is
 * resolved per row here. Shifting `windowExpiryIso` to the window end instead would
 * drop a lead that is due at 10:00 but whose window closes at 14:00.
 */
function projectConsentAsk(repos: Repositories, span: ProjectionSpan, allowlist: string[]): ScheduledFollowup[] {
  const thresholdMs = consentThresholdMs();
  const candidates = repos.conversation.listConsentAskCandidates({
    silentSinceIso: new Date(span.endMs - thresholdMs).toISOString(),
    windowExpiryIso: new Date(span.startMs - FREE_FORM_WINDOW_MS).toISOString(),
    limit: SCAN_LIMIT,
  });

  const scheduled: ScheduledFollowup[] = [];
  for (const candidate of candidates) {
    if (!isAllowlisted(candidate.customer_phone, allowlist)) continue;
    const anchorMs = parseStoredTimestamp(candidate.anchor_at);
    if (Number.isNaN(anchorMs)) continue;

    const dueAt = anchorMs + thresholdMs;
    const windowClosesAt = anchorMs + FREE_FORM_WINDOW_MS;
    // No send is possible when the window shuts before the ask becomes due.
    if (windowClosesAt <= dueAt) continue;
    // The band must still be reachable: a band that closed before the reference
    // instant can never be sent, and listing it sends the operator chasing a lead
    // we are no longer allowed to write to.
    if (dueAt >= span.endMs || windowClosesAt <= span.reachableFromMs) continue;

    scheduled.push({
      phone: candidate.customer_phone,
      path: 'consent_ask',
      dueAt: new Date(dueAt),
      overdue: dueAt < span.referenceMs,
      cycleLabel: `c${candidate.consent_session}`,
    });
  }
  return scheduled;
}

/**
 * Recurring template: due on the consent-scoped exponential cadence, and only for a
 * customer dormant for the independent silence floor.
 *
 * Mirrors the sender's own two-stage shape — broad SQL scan, then the exact
 * `recurringNextDueAt` — so a cadence change cannot make the digest disagree with
 * what actually ships.
 */
function projectRecurring(repos: Repositories, span: ProjectionSpan, allowlist: string[]): ScheduledFollowup[] {
  const candidates = repos.conversation.listRecurringCandidates({
    dueBeforeIso: recurringDueBeforeIso(span.endMs),
    silentSinceIso: new Date(span.endMs - recurringMinSilenceMs()).toISOString(),
    maxSends: env.FOLLOWUP_MAX_RECURRING_SENDS,
    scanLimit: SCAN_LIMIT,
  });

  const scheduled: ScheduledFollowup[] = [];
  for (const candidate of candidates) {
    if (!isAllowlisted(candidate.customer_phone, allowlist)) continue;
    const dueAt = recurringNextDueAt(candidate.last_send_at, candidate.sends_so_far);
    if (!dueAt || dueAt.getTime() >= span.endMs) continue;

    scheduled.push({
      phone: candidate.customer_phone,
      path: 'recurring',
      dueAt,
      overdue: dueAt.getTime() < span.referenceMs,
      cycleLabel: `c${Math.max(1, candidate.consent_cycle)}-r${candidate.sends_so_far + 1}`,
    });
  }
  return scheduled;
}

/**
 * Marks each send answered when an inbound landed after it and before the NEXT send
 * to the same customer.
 *
 * Derived rather than stored: no table records a reply against a follow-up, and
 * `getDayActivity` still reports `followUpsReplied: 0` hardcoded.
 *
 * Bounding by the next send is what makes the count a reply RATE. Testing the
 * latest inbound instead marked every send of the day as answered off a single
 * reply, so two sends and one reply reported "contestaron: 2".
 */
function attributeAnswers(repos: Repositories, sent: SentFollowup[]): void {
  if (sent.length === 0) return;

  const phones = [...new Set(sent.map(item => item.phone))];
  const earliestSendMs = Math.min(...sent.map(item => item.sentAt.getTime()));
  const inboundByPhone = new Map<string, number[]>();
  for (const row of repos.message.listInboundSince(phones, new Date(earliestSendMs).toISOString())) {
    const at = parseStoredTimestamp(row.created_at);
    if (Number.isNaN(at)) continue;
    const existing = inboundByPhone.get(row.customer_phone);
    if (existing) existing.push(at);
    else inboundByPhone.set(row.customer_phone, [at]);
  }

  const sendsByPhone = new Map<string, SentFollowup[]>();
  for (const item of sent) {
    const existing = sendsByPhone.get(item.phone);
    if (existing) existing.push(item);
    else sendsByPhone.set(item.phone, [item]);
  }

  for (const [phone, items] of sendsByPhone) {
    const inbounds = inboundByPhone.get(phone) ?? [];
    const ordered = [...items].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    for (const [index, item] of ordered.entries()) {
      const from = item.sentAt.getTime();
      // The last send of the window has no upper bound: any later reply counts.
      const until = index + 1 < ordered.length ? ordered[index + 1].sentAt.getTime() : Number.POSITIVE_INFINITY;
      item.answered = inbounds.some(at => at > from && at < until);
    }
  }
}

function collectSubscriptionSends(
  repos: Repositories,
  kind: FollowupSubscriptionEventKind,
  path: DigestPath,
  window: DigestWindow,
): SentFollowup[] {
  const rows = repos.followupSubscriptionEvent.listReachedMetaBetween(kind, window.startIso, window.endIso);
  const sent: SentFollowup[] = [];
  for (const row of rows) {
    const terminalAt = row.accepted_at ?? row.delivered_at ?? row.failed_at;
    if (!terminalAt) continue;
    const sentAtMs = parseStoredTimestamp(terminalAt);
    if (Number.isNaN(sentAtMs)) continue;

    sent.push({
      phone: row.customer_phone,
      path,
      sentAt: new Date(sentAtMs),
      uncertain: row.status === 'uncertain',
      // Resolved in one pass by attributeAnswers once every path is collected.
      answered: false,
    });
  }
  return sent;
}

/**
 * Attaches the recorded consent decision to each ask.
 *
 * A stronger signal than "answered": it is what the classifier actually decided,
 * so an ambiguous reply does not read as acceptance.
 */
function attachConsentOutcomes(repos: Repositories, sent: SentFollowup[]): void {
  const asks = sent.filter(item => item.path === 'consent_ask');
  if (asks.length === 0) return;

  const statuses = new Map(
    repos.followupSubscription
      .listStatuses([...new Set(asks.map(item => item.phone))])
      .map(row => [row.customer_phone, row.status]),
  );
  for (const ask of asks) ask.consentOutcome = statuses.get(ask.phone) ?? 'unasked';
}

function collectOneShotSends(repos: Repositories, window: DigestWindow): SentFollowup[] {
  const rows = repos.followupEvent.listReachedMetaBetween(window.startIso, window.endIso);
  const sent: SentFollowup[] = [];
  for (const row of rows) {
    const terminalAt = row.sent_at ?? row.failed_at;
    if (!terminalAt) continue;
    const sentAtMs = parseStoredTimestamp(terminalAt);
    if (Number.isNaN(sentAtMs)) continue;

    sent.push({
      phone: row.customer_phone,
      path: 'one_shot',
      sentAt: new Date(sentAtMs),
      uncertain: row.status === 'uncertain',
      answered: false,
    });
  }
  return sent;
}

/**
 * Builds the digest for one Colombia-local day. Pure reads: safe to call from a
 * command without any risk of triggering a send.
 */
export function buildFollowupDigest(
  repos: Repositories,
  window: DigestWindow,
  reference: Date = new Date(),
): FollowupDigest {
  const allowlist = devAllowlist();
  const startMs = new Date(window.startIso).getTime();
  const endMs = new Date(window.endIso).getTime();
  const referenceMs = reference.getTime();
  const span: ProjectionSpan = {
    startMs,
    endMs,
    referenceMs,
    reachableFromMs: Math.max(startMs, referenceMs),
  };

  // A finished day has nothing left to schedule. The sent section carries the
  // retrospective; projecting into the past would invent opportunities that the
  // sender never had.
  const dayIsOver = referenceMs >= endMs;
  const scheduled = dayIsOver ? [] : [
    ...(env.ALLOW_FOLLOWUP_TEMPLATE ? projectOneShot(repos, span, allowlist) : []),
    ...(env.FOLLOWUP_CONSENT_ASK_ENABLED ? projectConsentAsk(repos, span, allowlist) : []),
    ...(env.FOLLOWUP_RECURRING_ENABLED ? projectRecurring(repos, span, allowlist) : []),
  ].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());

  const sent = [
    ...collectOneShotSends(repos, window),
    ...collectSubscriptionSends(repos, 'consent_ask', 'consent_ask', window),
    ...collectSubscriptionSends(repos, 'recurring', 'recurring', window),
  ].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

  // Both run over the whole set: one batched read each instead of two per row.
  // Attribution must see every path, since the next send bounding a reply may
  // belong to a different one.
  attributeAnswers(repos, sent);
  attachConsentOutcomes(repos, sent);

  return { window, scheduled, sent, devAllowlistActive: allowlist.length > 0 };
}

const PATH_LABEL: Record<DigestPath, string> = {
  one_shot: 'template 24h',
  consent_ask: 'permiso',
  recurring: 'recurrente',
};

function formatDay(day: CalendarDate): string {
  return `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
}

/**
 * Colombia-local clock, prefixed with the date when the instant falls outside the
 * reported day.
 *
 * A bare `HH:MM` on an overdue item reads as "today": an ask that came due at 11:01
 * yesterday and is still pending renders identically to one due at 11:01 today. The
 * prefix is what keeps an overdue entry honest.
 */
function formatBogotaClock(instant: Date, reportedDay: CalendarDate): string {
  const local = getBogotaCalendarDate(instant);
  const clock = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
  const sameDay = local.year === reportedDay.year
    && local.month === reportedDay.month
    && local.day === reportedDay.day;
  return sameDay ? clock : `${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')} ${clock}`;
}

function countBy(items: { path: DigestPath }[]): Record<DigestPath, number> {
  const counts: Record<DigestPath, number> = { one_shot: 0, consent_ask: 0, recurring: 0 };
  for (const item of items) counts[item.path] += 1;
  return counts;
}

function renderScheduled(digest: FollowupDigest): string[] {
  const lines = ['PROGRAMADOS'];
  if (digest.scheduled.length === 0) {
    lines.push('ninguno');
    return lines;
  }

  const counts = countBy(digest.scheduled);
  lines.push(
    `${digest.scheduled.length} en total — `
    + `template 24h: ${counts.one_shot} · permiso: ${counts.consent_ask} · recurrente: ${counts.recurring}`,
  );

  for (const item of digest.scheduled.slice(0, MAX_LISTED_ENTRIES)) {
    const cycle = item.cycleLabel ? ` ${item.cycleLabel}` : '';
    // "atrasado" is not a failure: it fires on the next tick.
    const flag = item.overdue ? ' ⏳atrasado' : '';
    lines.push(`• ${formatBogotaClock(item.dueAt, digest.window.day)} ${item.phone} — ${PATH_LABEL[item.path]}${cycle}${flag}`);
  }
  if (digest.scheduled.length > MAX_LISTED_ENTRIES) {
    lines.push(`…y ${digest.scheduled.length - MAX_LISTED_ENTRIES} mas`);
  }
  return lines;
}

function renderSent(digest: FollowupDigest): string[] {
  const lines = ['ENVIADOS'];
  if (digest.sent.length === 0) {
    lines.push('ninguno');
    return lines;
  }

  const answered = digest.sent.filter(item => item.answered);
  const counts = countBy(digest.sent);
  lines.push(
    `${digest.sent.length} en total — `
    + `template 24h: ${counts.one_shot} · permiso: ${counts.consent_ask} · recurrente: ${counts.recurring}`,
  );
  lines.push(`contestaron: ${answered.length} · sin responder: ${digest.sent.length - answered.length}`);

  const uncertain = digest.sent.filter(item => item.uncertain).length;
  // Terminal by design: Meta may have accepted these, so they are never retried.
  if (uncertain > 0) lines.push(`entrega sin confirmar: ${uncertain}`);

  const asks = digest.sent.filter(item => item.path === 'consent_ask');
  if (asks.length > 0) {
    const accepted = asks.filter(item => item.consentOutcome === 'active').length;
    const declined = asks.filter(item => item.consentOutcome === 'declined').length;
    lines.push(`permisos → si: ${accepted} · no: ${declined} · sin responder: ${asks.length - accepted - declined}`);
  }

  for (const item of digest.sent.slice(0, MAX_LISTED_ENTRIES)) {
    const mark = item.answered ? '✅' : '·';
    const outcome = item.consentOutcome && item.consentOutcome !== 'unasked' ? ` (${item.consentOutcome})` : '';
    lines.push(`${mark} ${formatBogotaClock(item.sentAt, digest.window.day)} ${item.phone} — ${PATH_LABEL[item.path]}${outcome}`);
  }
  if (digest.sent.length > MAX_LISTED_ENTRIES) {
    lines.push(`…y ${digest.sent.length - MAX_LISTED_ENTRIES} mas`);
  }
  return lines;
}

/**
 * Renders the digest as text carrying NO Markdown markup.
 *
 * The two delivery paths disagree on parse mode: a command's return string is sent
 * with `parseMode: 'Markdown'`, while the scheduled push sends none. Markup would
 * therefore render bold on demand and as literal asterisks at 08:00. Plain text
 * renders identically through both.
 *
 * It also removes a failure mode: Telegram rejects a malformed Markdown message
 * with a 400, and `describeBlockFallback` has no fallback for a text block, so the
 * operator would silently get nothing.
 */
export function renderFollowupDigest(digest: FollowupDigest): string {
  const switches = [
    `template 24h: ${env.ALLOW_FOLLOWUP_TEMPLATE ? 'ON' : 'OFF'}`,
    `permiso: ${env.FOLLOWUP_CONSENT_ASK_ENABLED ? 'ON' : 'OFF'}`,
    `recurrente: ${env.FOLLOWUP_RECURRING_ENABLED ? 'ON' : 'OFF'}`,
  ].join(' · ');

  const lines = [
    `Follow-ups ${formatDay(digest.window.day)} (hora Colombia)`,
    switches,
  ];
  if (digest.devAllowlistActive) {
    lines.push('DEV: allowlist activa — solo los numeros listados reciben envios');
  }
  lines.push('', ...renderScheduled(digest), '', ...renderSent(digest));
  return lines.join('\n');
}

/** `bot_config` key for the once-per-day claim. */
const DIGEST_JOB_KEY = 'followup_digest_last_run';

/**
 * Delivers the digest for the current Colombia day at most once, whoever calls.
 *
 * The claim is persisted and taken BEFORE the send, so a restart at the trigger
 * hour cannot re-deliver. The in-process alternative re-sends on every boot, and a
 * crash loop at 08:00 would spam the operator.
 */
export async function deliverDailyDigest(repos: Repositories, now: Date = new Date()): Promise<boolean> {
  // Checked BEFORE the claim: an unconfigured target would otherwise burn the day's
  // slot on a send that never happened, and configuring the token later that day
  // would not bring the digest back.
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    logger.info('[FOLLOWUP_DIGEST] no Telegram target configured — skipped');
    return false;
  }

  const window = bogotaDayWindow(now);
  const periodKey = formatDay(window.day);
  if (!repos.claimPeriodicJob(DIGEST_JOB_KEY, periodKey)) return false;

  // Yesterday's sends are the useful "what happened" half: today's have barely
  // started at the trigger hour, while today's schedule is the actionable part.
  const digest = buildFollowupDigest(repos, window, now);
  const yesterday = buildFollowupDigest(repos, previousBogotaDayWindow(now), now);

  const full = [
    renderFollowupDigest(digest),
    '',
    `— Ayer (${formatDay(yesterday.window.day)}) —`,
    ...renderSent(yesterday),
  ].join('\n');
  // Truncate rather than let Telegram reject the whole message: an over-length
  // send is a 400, and a text block has no fallback, so the operator would get
  // nothing at all.
  const body = full.length > MAX_TELEGRAM_TEXT_CHARS
    ? `${full.slice(0, MAX_TELEGRAM_TEXT_CHARS - 1)}…`
    : full;

  try {
    const { sendTelegramMessage } = await import('./telegram-bot.js');
    await sendTelegramMessage(env.TELEGRAM_CHAT_ID, body);
    logger.info(
      { day: periodKey, scheduled: digest.scheduled.length, sentYesterday: yesterday.sent.length },
      '[FOLLOWUP_DIGEST] delivered',
    );
    return true;
  } catch (err) {
    // The claim is already consumed: one lost informational digest is cheaper than
    // repeating it on every 5-minute tick for the rest of the day.
    logger.warn({ err, day: periodKey }, '[FOLLOWUP_DIGEST] delivery failed');
    return false;
  }
}

/** Poll cadence for the wall-clock trigger. Small enough to hit the hour, cheap enough to ignore. */
const DIGEST_POLL_MS = 5 * 60 * 1000;

/**
 * Wall-clock scheduler for the digest.
 *
 * Deliberately separate from the follow-up tick: that loop dispatches to customers
 * and its interval is tuned for send latency, so hanging an operator report off it
 * would couple a reporting change to the sending path.
 */
export function startFollowupDigestScheduler(repos: Repositories): ReturnType<typeof setInterval> | undefined {
  if (!env.FOLLOWUP_DIGEST_ENABLED) return undefined;

  if (env.FOLLOWUP_DIGEST_DEV_FORCE) {
    // Rejected in production by env.ts; here it makes the digest testable without
    // waiting for the trigger hour.
    logger.info('[FOLLOWUP_DIGEST] dev force enabled — sending one digest now');
    void deliverDailyDigest(repos);
  }

  logger.info(
    { hourBogota: env.FOLLOWUP_DIGEST_HOUR_BOGOTA, pollMs: DIGEST_POLL_MS },
    '[FOLLOWUP_DIGEST] scheduler started',
  );

  return setInterval(() => {
    // `>=`, not `===`: an equality test ties the whole day's digest to the process
    // being alive during that one hour, so a deploy or a crash spanning 08:00 meant
    // the report never went out. The persisted claim is what prevents a late send
    // from becoming a duplicate.
    if (getBogotaCalendarDate(new Date()).hour < env.FOLLOWUP_DIGEST_HOUR_BOGOTA) return;
    void deliverDailyDigest(repos);
  }, DIGEST_POLL_MS);
}
