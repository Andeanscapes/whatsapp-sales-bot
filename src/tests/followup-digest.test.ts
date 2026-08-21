import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { env } from '../config/env.js';
import {
  bogotaDayWindow,
  buildFollowupDigest,
  deliverDailyDigest,
  previousBogotaDayWindow,
  renderFollowupDigest,
} from '../services/followup-digest.js';

const PHONE = '573009900001';
const OTHER = '573009900002';

/** SQLite `datetime('now')` format, which is what the sender writes. */
function sqliteTs(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * 2026-03-10 14:00 UTC is 09:00 in Bogota, so the local day is unambiguous and the
 * UTC/Bogota distinction is actually exercised (a UTC-midnight window would place
 * the early-morning cases on the wrong day).
 */
const NOW = new Date('2026-03-10T14:00:00.000Z');

function seedQualifiedLead(db: Database.Database, phone: string, lastInbound: Date): void {
  db.prepare(`
    INSERT INTO conversations (customer_phone, first_seen_at, last_seen_at, collected_plan, collected_people)
    VALUES (?, ?, ?, '2d1n_mining', 2)
  `).run(phone, sqliteTs(lastInbound), sqliteTs(lastInbound));
  db.prepare(
    "INSERT INTO messages (customer_phone, direction, message_type, body, created_at) VALUES (?, 'inbound', 'text', 'hola', ?)"
  ).run(phone, sqliteTs(lastInbound));
  // The last message in the thread must be ours for every candidate query.
  db.prepare(
    "INSERT INTO messages (customer_phone, direction, message_type, body, created_at) VALUES (?, 'outbound', 'text', 'reply', ?)"
  ).run(phone, sqliteTs(new Date(lastInbound.getTime() + 60_000)));
}

function addInbound(db: Database.Database, phone: string, at: Date): void {
  db.prepare(
    "INSERT INTO messages (customer_phone, direction, message_type, body, created_at) VALUES (?, 'inbound', 'text', 'gracias', ?)"
  ).run(phone, sqliteTs(at));
}

describe('followup digest', () => {
  let db: Database.Database;
  let repos: Repositories;
  const spies: { mockRestore: () => void }[] = [];

  function stub<K extends keyof typeof env>(key: K, value: (typeof env)[K]): void {
    spies.push(vi.spyOn(env, key, 'get').mockReturnValue(value));
  }

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    stub('ALLOW_FOLLOWUP_TEMPLATE', true);
    stub('FOLLOWUP_CONSENT_ASK_ENABLED', true);
    stub('FOLLOWUP_RECURRING_ENABLED', true);
    stub('FOLLOWUP_DEV_ALLOWLIST_PHONES', '');
    stub('FOLLOWUP_DEV_MINUTES', 0);
    stub('FOLLOWUP_DEV_CONSENT_SECONDS', 0);
    stub('FOLLOWUP_DEV_RECURRING_SECONDS', 0);
    stub('FOLLOWUP_DEV_RECURRING_MIN_SILENCE_SECONDS', 0);
    stub('FOLLOWUP_HOURS_AFTER_INBOUND', 24);
    stub('FOLLOWUP_CONSENT_HOURS_AFTER_INBOUND', 23);
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    db.close();
  });

  describe('bogotaDayWindow', () => {
    it('spans the Colombia-local day, not the UTC one', () => {
      const window = bogotaDayWindow(NOW);
      expect(window.day).toEqual({ year: 2026, month: 3, day: 10 });
      // 00:00 in Bogota is 05:00 UTC on the same date.
      expect(window.startIso).toBe('2026-03-10T05:00:00.000Z');
      expect(window.endIso).toBe('2026-03-11T05:00:00.000Z');
    });

    it('puts an early-morning Bogota instant on the local date, not the UTC one', () => {
      // 02:00 UTC on the 11th is still 21:00 on the 10th in Bogota.
      expect(bogotaDayWindow(new Date('2026-03-11T02:00:00.000Z')).day)
        .toEqual({ year: 2026, month: 3, day: 10 });
    });

    it('resolves the previous local day', () => {
      expect(previousBogotaDayWindow(NOW).day).toEqual({ year: 2026, month: 3, day: 9 });
    });
  });

  describe('scheduled projection', () => {
    it('projects a one-shot due later today from the operator grant', () => {
      // Inbound 20h before "now" → due in 4h, still inside today's local window.
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 20 * 3_600_000));
      repos.followupConsent.grantConsent(PHONE, 'operator');

      const digest = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW);
      const oneShot = digest.scheduled.filter(item => item.path === 'one_shot');
      expect(oneShot).toHaveLength(1);
      expect(oneShot[0].phone).toBe(PHONE);
      expect(oneShot[0].overdue).toBe(false);
      expect(oneShot[0].dueAt.toISOString()).toBe(new Date(NOW.getTime() + 4 * 3_600_000).toISOString());
    });

    it('omits a one-shot with no operator grant', () => {
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 20 * 3_600_000));

      const digest = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW);
      expect(digest.scheduled.filter(item => item.path === 'one_shot')).toEqual([]);
    });

    it('flags an already-due one-shot as overdue instead of hiding it', () => {
      // Inbound 40h ago: the 24h threshold elapsed before today's window opened, so
      // it fires on the next tick. Reporting nothing would make the digest look
      // empty while sends happen.
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 40 * 3_600_000));
      repos.followupConsent.grantConsent(PHONE, 'operator');

      const oneShot = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW).scheduled
        .filter(item => item.path === 'one_shot');
      expect(oneShot).toHaveLength(1);
      expect(oneShot[0].overdue).toBe(true);
    });

    it('projects a consent ask inside the free-form window and reports its cycle', () => {
      // 22h of silence: the 23h ask is due in 1h and the 23h50m window is still open.
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 22 * 3_600_000));

      const asks = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW).scheduled
        .filter(item => item.path === 'consent_ask');
      expect(asks).toHaveLength(1);
      expect(asks[0].cycleLabel).toBe('c1');
    });

    it('omits a consent ask whose 24h window closes before it comes due', () => {
      // A 30h-old inbound is past the free-form window entirely: the ask can never
      // be sent, so listing it would send the operator chasing a lead we cannot write to.
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 30 * 3_600_000));

      const asks = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW).scheduled
        .filter(item => item.path === 'consent_ask');
      expect(asks).toEqual([]);
    });

    it('schedules nothing for a day that already ended', () => {
      // `/followupdigest ayer` must not invent send opportunities the sender never
      // had. The sent section carries the retrospective instead.
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 22 * 3_600_000));

      const yesterday = buildFollowupDigest(repos, previousBogotaDayWindow(NOW), NOW);
      expect(yesterday.scheduled).toEqual([]);
    });

    it('omits a consent ask whose window closed earlier in the reported day', () => {
      // Due 07:00Z, window shuts 07:50Z, report runs at 14:00Z: the band intersects
      // today but is unreachable, so listing it would send the operator chasing a
      // lead we can no longer write to.
      seedQualifiedLead(db, PHONE, new Date('2026-03-09T08:00:00.000Z'));

      const asks = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW).scheduled
        .filter(item => item.path === 'consent_ask');
      expect(asks).toEqual([]);
    });

    it('dates an overdue entry that came due on an earlier day', () => {
      // A bare HH:MM would read as today. The one-shot below came due 16h before
      // the report, which is the previous Colombia day.
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 40 * 3_600_000));
      repos.followupConsent.grantConsent(PHONE, 'operator');

      const text = renderFollowupDigest(buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW));
      expect(text).toContain('03-09 17:00');
      expect(text).toContain('⏳atrasado');
    });

    it('respects the per-path enable switches', () => {
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 22 * 3_600_000));
      stub('FOLLOWUP_CONSENT_ASK_ENABLED', false);

      expect(buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW).scheduled).toEqual([]);
    });

    it('reports only allowlisted leads when the dev allowlist is set', () => {
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 22 * 3_600_000));
      seedQualifiedLead(db, OTHER, new Date(NOW.getTime() - 22 * 3_600_000));
      stub('FOLLOWUP_DEV_ALLOWLIST_PHONES', PHONE);

      const digest = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW);
      // The allowlist suppresses every non-listed send, so the report must match.
      expect(digest.scheduled.map(item => item.phone)).toEqual([PHONE]);
      expect(digest.devAllowlistActive).toBe(true);
      expect(renderFollowupDigest(digest)).toContain('allowlist activa');
    });
  });

  describe('sent history', () => {
    /** Mirrors what the sender writes for a delivered consent ask. */
    function seedAskSent(phone: string, sentAt: Date, status = 'accepted'): void {
      db.prepare(`
        INSERT INTO followup_subscription_events
          (customer_phone, event_kind, cycle_key, scheduled_for, status, accepted_at, updated_at, attempts)
        VALUES (?, 'consent_ask', 'c1', ?, ?, ?, ?, 1)
      `).run(phone, sqliteTs(sentAt), status, status === 'accepted' ? sqliteTs(sentAt) : null, sqliteTs(sentAt));
      if (status !== 'accepted') {
        db.prepare('UPDATE followup_subscription_events SET failed_at = ? WHERE customer_phone = ?')
          .run(sqliteTs(sentAt), phone);
      }
    }

    it('counts an answered send when an inbound follows it', () => {
      const sentAt = new Date(NOW.getTime() - 3 * 3_600_000);
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 24 * 3_600_000));
      seedAskSent(PHONE, sentAt);
      addInbound(db, PHONE, new Date(sentAt.getTime() + 30 * 60_000));

      const digest = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW);
      expect(digest.sent).toHaveLength(1);
      expect(digest.sent[0].answered).toBe(true);
    });

    it('counts an unanswered send when the newest inbound predates it', () => {
      const sentAt = new Date(NOW.getTime() - 3 * 3_600_000);
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 24 * 3_600_000));
      seedAskSent(PHONE, sentAt);

      const digest = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW);
      expect(digest.sent[0].answered).toBe(false);
      expect(renderFollowupDigest(digest)).toContain('sin responder: 1');
    });

    it('attributes a reply to the send it followed, not to every send that day', () => {
      // Two sends, one reply, and the reply lands AFTER the second: only the second
      // is answered. Testing the latest inbound marked both, reporting
      // "contestaron: 2" off a single reply and making the rate meaningless.
      const first = new Date(NOW.getTime() - 6 * 3_600_000);
      const second = new Date(NOW.getTime() - 2 * 3_600_000);
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 24 * 3_600_000));
      seedAskSent(PHONE, first);
      db.prepare(`
        INSERT INTO followup_subscription_events
          (customer_phone, event_kind, cycle_key, scheduled_for, status, accepted_at, updated_at, attempts)
        VALUES (?, 'recurring', 'c1-r1', ?, 'accepted', ?, ?, 1)
      `).run(PHONE, sqliteTs(second), sqliteTs(second), sqliteTs(second));
      addInbound(db, PHONE, new Date(second.getTime() + 15 * 60_000));

      const digest = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW);
      const byPath = new Map(digest.sent.map(item => [item.path, item.answered]));
      expect(byPath.get('consent_ask')).toBe(false);
      expect(byPath.get('recurring')).toBe(true);
      expect(renderFollowupDigest(digest)).toContain('contestaron: 1');
    });

    it('credits the earlier send when the reply arrives before the next one', () => {
      const first = new Date(NOW.getTime() - 6 * 3_600_000);
      const second = new Date(NOW.getTime() - 2 * 3_600_000);
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 24 * 3_600_000));
      seedAskSent(PHONE, first);
      db.prepare(`
        INSERT INTO followup_subscription_events
          (customer_phone, event_kind, cycle_key, scheduled_for, status, accepted_at, updated_at, attempts)
        VALUES (?, 'recurring', 'c1-r1', ?, 'accepted', ?, ?, 1)
      `).run(PHONE, sqliteTs(second), sqliteTs(second), sqliteTs(second));
      addInbound(db, PHONE, new Date(first.getTime() + 15 * 60_000));

      const byPath = new Map(
        buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW).sent.map(item => [item.path, item.answered]),
      );
      expect(byPath.get('consent_ask')).toBe(true);
      expect(byPath.get('recurring')).toBe(false);
    });

    it('reports the recorded consent outcome, not just whether they replied', () => {
      const sentAt = new Date(NOW.getTime() - 3 * 3_600_000);
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 24 * 3_600_000));
      seedAskSent(PHONE, sentAt);
      repos.followupSubscription.ensureExists(PHONE);
      repos.followupSubscription.markAsked(PHONE, 'wamid.ask');
      repos.followupSubscription.affirm(PHONE, 'wamid.yes', 'customer_reply');

      const digest = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW);
      expect(digest.sent[0].consentOutcome).toBe('active');
      expect(renderFollowupDigest(digest)).toContain('permisos → si: 1');
    });

    it('includes an uncertain send, whose terminal stamp is failed_at', () => {
      // `uncertain` never sets accepted_at, so a query keyed on it would silently
      // drop sends Meta may have accepted.
      const sentAt = new Date(NOW.getTime() - 2 * 3_600_000);
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 24 * 3_600_000));
      seedAskSent(PHONE, sentAt, 'uncertain');

      const digest = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW);
      expect(digest.sent).toHaveLength(1);
      expect(digest.sent[0].uncertain).toBe(true);
      expect(renderFollowupDigest(digest)).toContain('entrega sin confirmar: 1');
    });

    it('excludes sends outside the reported local day', () => {
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 24 * 3_600_000));
      // 06:00 UTC on the 9th is 01:00 Bogota on the 9th — the previous local day.
      seedAskSent(PHONE, new Date('2026-03-09T06:00:00.000Z'));

      expect(buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW).sent).toEqual([]);
      expect(buildFollowupDigest(repos, previousBogotaDayWindow(NOW), NOW).sent).toHaveLength(1);
    });

    it('includes a one-shot template send from its own ledger', () => {
      const sentAt = new Date(NOW.getTime() - 4 * 3_600_000);
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 30 * 3_600_000));
      db.prepare(`
        INSERT INTO followup_events (customer_phone, anchor_at, claimed_at, attempts, sent_at, status)
        VALUES (?, ?, ?, 1, ?, 'sent')
      `).run(PHONE, sqliteTs(new Date(NOW.getTime() - 30 * 3_600_000)), sqliteTs(sentAt), sqliteTs(sentAt));

      const digest = buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW);
      expect(digest.sent.map(item => item.path)).toEqual(['one_shot']);
    });
  });

  describe('deliverDailyDigest', () => {
    beforeEach(() => {
      stub('FOLLOWUP_DIGEST_ENABLED', true);
      stub('TELEGRAM_BOT_TOKEN', 'test-token');
      stub('TELEGRAM_CHAT_ID', '333');
    });

    it('delivers once per Colombia day and refuses a second call', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));

      expect(await deliverDailyDigest(repos, NOW)).toBe(true);
      // A restart at the trigger hour must not re-deliver: the claim is persisted.
      expect(await deliverDailyDigest(repos, NOW)).toBe(false);
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('sendMessage'))).toHaveLength(1);

      fetchSpy.mockRestore();
    });

    it('refuses to re-deliver an earlier day after a later one', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));

      expect(await deliverDailyDigest(repos, NOW)).toBe(true);
      // The claim must be monotonic: an inequality test would rewind the marker on
      // a backwards clock step and let an already-delivered day be claimed again.
      expect(await deliverDailyDigest(repos, new Date(NOW.getTime() - 24 * 3_600_000))).toBe(false);
      expect(await deliverDailyDigest(repos, NOW)).toBe(false);

      fetchSpy.mockRestore();
    });

    it('delivers again on the next Colombia day', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));

      expect(await deliverDailyDigest(repos, NOW)).toBe(true);
      expect(await deliverDailyDigest(repos, new Date(NOW.getTime() + 24 * 3_600_000))).toBe(true);

      fetchSpy.mockRestore();
    });

    it('consumes the claim even when delivery fails, instead of retrying every tick', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('telegram down'));

      expect(await deliverDailyDigest(repos, NOW)).toBe(false);
      // Second call is blocked by the claim, not by a new send attempt.
      expect(await deliverDailyDigest(repos, NOW)).toBe(false);
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('sendMessage'))).toHaveLength(1);

      fetchSpy.mockRestore();
    });

    it('does not burn the day when no Telegram target is configured', async () => {
      stub('TELEGRAM_CHAT_ID', '');

      expect(await deliverDailyDigest(repos, NOW)).toBe(false);

      // The claim must still be available once the target is configured, otherwise
      // a missing token silently costs that day's digest.
      stub('TELEGRAM_CHAT_ID', '333');
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
      expect(await deliverDailyDigest(repos, NOW)).toBe(true);
      fetchSpy.mockRestore();
    });

    it('keeps the body under the Telegram text limit', async () => {
      // Telegram 400s an over-length message and a text block has no fallback, so
      // the operator would get nothing at all.
      for (let i = 0; i < 60; i += 1) {
        const phone = `5730099${String(100000 + i)}`;
        seedQualifiedLead(db, phone, new Date(NOW.getTime() - 22 * 3_600_000));
      }
      let body = '';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if (typeof init?.body === 'string') body = JSON.parse(init.body).text ?? '';
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      });

      await deliverDailyDigest(repos, NOW);

      expect(body.length).toBeLessThanOrEqual(4000);
      expect(body).toContain('mas');
      fetchSpy.mockRestore();
    });

    it('never sends to a customer', async () => {
      seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 22 * 3_600_000));
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));

      await deliverDailyDigest(repos, NOW);

      // The digest is an operator report: no Graph API call, so it cannot be a
      // fourth outbound path.
      expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes('graph.facebook.com'))).toBe(true);
      fetchSpy.mockRestore();
    });
  });

  it('renders an empty day without pretending anything is scheduled', () => {
    const text = renderFollowupDigest(buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW));
    expect(text).toContain('2026-03-10');
    expect(text).toContain('PROGRAMADOS');
    expect(text).toContain('ninguno');
  });

  it('carries no Markdown markup, so both delivery paths render identically', () => {
    // A command's return string is sent with parseMode 'Markdown'; the scheduled
    // push sends none. Markup would render bold on demand and as literal asterisks
    // at 08:00 — and a malformed one would make Telegram drop the whole message.
    seedQualifiedLead(db, PHONE, new Date(NOW.getTime() - 22 * 3_600_000));
    const text = renderFollowupDigest(buildFollowupDigest(repos, bogotaDayWindow(NOW), NOW));

    expect(text).not.toMatch(/[*_`[\]]/);
  });
});
