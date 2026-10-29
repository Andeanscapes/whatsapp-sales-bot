import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';

const PHONE = '573001112244';

describe('returning lead repository', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    repos.conversation.upsert(PHONE, { language: 'es' });
  });

  afterEach(() => db.close());

  function inbound(at: string, body = 'hola'): void {
    repos.message.addMessage({
      whatsapp_message_id: `in-${at}`, customer_phone: PHONE, direction: 'inbound',
      message_type: 'text', body, created_at: at,
    });
  }

  it('returns the previous inbound when the current one is not stored yet', () => {
    inbound('2026-10-01T10:00:00.000Z');
    inbound('2026-10-02T10:00:00.000Z');
    expect(repos.message.getPreviousInboundAt(PHONE, false)).toBe('2026-10-02T10:00:00.000Z');
  });

  it('skips the current inbound when it is already stored', () => {
    inbound('2026-10-01T10:00:00.000Z');
    inbound('2026-10-02T10:00:00.000Z');
    expect(repos.message.getPreviousInboundAt(PHONE, true)).toBe('2026-10-01T10:00:00.000Z');
  });

  it('returns null for a first-ever contact', () => {
    expect(repos.message.getPreviousInboundAt(PHONE, true)).toBeNull();
  });

  it('replay keeps template rows while the model history still drops them', () => {
    inbound('2026-10-01T10:00:00.000Z');
    repos.message.addMessage({
      customer_phone: PHONE, direction: 'outbound', message_type: 'template',
      body: '[template:tour_followup_nodate_v1]', created_at: '2026-10-02T10:00:00.000Z',
    });
    expect(repos.message.getReplayMessages(PHONE, 10).map(m => m.content))
      .toContain('[template:tour_followup_nodate_v1]');
    expect(repos.message.getRecentMessages(PHONE, 10).map(m => m.content))
      .not.toContain('[template:tour_followup_nodate_v1]');
  });

  it('persists the newest entry marker and blockers without touching entry_marker', () => {
    repos.conversation.upsert(PHONE, { entry_marker: 'C01', entry_temperature: 'cold' });
    repos.conversation.upsert(PHONE, { last_entry_marker: 'H02', last_entry_marker_at: '2026-10-20T10:00:00.000Z', last_blockers: '["transporte"]' });
    const row = repos.conversation.getByPhone(PHONE);
    expect(row?.entry_marker).toBe('C01');
    expect(row?.last_entry_marker).toBe('H02');
    expect(row?.last_blockers).toBe('["transporte"]');
  });
});

describe('day activity report follow-ups', () => {
  let db2: Database.Database;
  let repos2: Repositories;

  beforeEach(() => {
    db2 = new Database(':memory:');
    migrate(db2);
    repos2 = createRepositories(db2);
    repos2.conversation.upsert(PHONE, { language: 'es' });
  });

  afterEach(() => db2.close());

  function inbound2(at: string): void {
    repos2.message.addMessage({ customer_phone: PHONE, direction: 'inbound', message_type: 'text', body: 'hola', created_at: at });
  }

  /** Sends a one-shot and stamps `sent_at` in the exact format markSent writes (`datetime('now')`). */
  function sentOneShot(anchorAt: string, sqliteSentAt: string): void {
    const claimId = repos2.followupEvent.claim(PHONE, anchorAt, 3, 10);
    expect(claimId).not.toBeNull();
    repos2.followupEvent.markSent(claimId as number, 'wamid.SENT');
    db2.prepare('UPDATE followup_events SET sent_at = ? WHERE id = ?').run(sqliteSentAt, claimId);
    repos2.message.addMessage({
      customer_phone: PHONE, direction: 'outbound', message_type: 'template',
      body: '[template:tour_followup_nodate_v1]', created_at: `${sqliteSentAt.replace(' ', 'T')}.000Z`,
    });
  }

  it('lists a sent one-shot template and counts a reply inside 72h', () => {
    inbound2('2026-10-24T09:00:00.000Z');
    sentOneShot('2026-10-24T09:00:00.000Z', '2026-10-25 10:00:00');
    inbound2('2026-10-25T12:00:00.000Z');

    const report = repos2.transcripts.getDayActivity('2026-10-20T00:00:00.000Z', null);
    const summary = report.conversations.find(c => c.customerPhone === PHONE);

    expect(summary?.followUps).toEqual([
      { kind: 'one_shot', status: 'sent', at: '2026-10-25T10:00:00Z', whatsappMessageId: 'wamid.SENT', replied: true, repliedAt: '2026-10-25T12:00:00.000Z' },
    ]);
    expect(report.totals.followUpsSent).toBe(1);
    expect(report.totals.followUpsReplied).toBe(1);
  });

  it('does not count a same-day inbound that came before the send', () => {
    inbound2('2026-10-25T08:00:00.000Z');
    sentOneShot('2026-10-25T08:00:00.000Z', '2026-10-25 10:00:00');

    const report = repos2.transcripts.getDayActivity('2026-10-20T00:00:00.000Z', null);

    expect(report.totals.followUpsSent).toBe(1);
    expect(report.totals.followUpsReplied).toBe(0);
  });

  it('includes a send on the first day of the window', () => {
    inbound2('2026-10-24T08:00:00.000Z');
    sentOneShot('2026-10-24T08:00:00.000Z', '2026-10-25 00:30:00');

    const report = repos2.transcripts.getDayActivity('2026-10-25T00:00:00.000Z', null);

    expect(report.totals.followUpsSent).toBe(1);
  });

  it('attributes a handoff only when it happened after the replied follow-up', () => {
    inbound2('2026-10-24T09:00:00.000Z');
    sentOneShot('2026-10-24T09:00:00.000Z', '2026-10-25 10:00:00');
    inbound2('2026-10-25T12:00:00.000Z');
    repos2.conversation.upsert(PHONE, { handed_off_at: '2026-10-23T09:00:00.000Z', converted_at: '2026-10-26T09:00:00.000Z' });

    const report = repos2.transcripts.getDayActivity('2026-10-20T00:00:00.000Z', null);

    expect(report.totals.followUpHandoffs).toBe(0);
    expect(report.totals.followUpBookings).toBe(1);
  });

  it('does not count a reply after the 72h window', () => {
    inbound2('2026-10-20T09:00:00.000Z');
    sentOneShot('2026-10-20T09:00:00.000Z', '2026-10-20 10:00:00');
    inbound2('2026-10-25T09:00:00.000Z');

    const report = repos2.transcripts.getDayActivity('2026-10-19T00:00:00.000Z', null);

    expect(report.totals.followUpsSent).toBe(1);
    expect(report.totals.followUpsReplied).toBe(0);
  });

  it('does not attribute a booking between the send and the reply', () => {
    inbound2('2026-10-24T09:00:00.000Z');
    sentOneShot('2026-10-24T09:00:00.000Z', '2026-10-25 10:00:00');
    inbound2('2026-10-25T12:00:00.000Z');
    repos2.conversation.upsert(PHONE, {
      converted_at: '2026-10-25T11:00:00.000Z', handed_off_at: '2026-10-25T11:30:00.000Z',
    });

    const report = repos2.transcripts.getDayActivity('2026-10-20T00:00:00.000Z', null);

    expect(report.totals.followUpsReplied).toBe(1);
    expect(report.totals.followUpBookings).toBe(0);
    expect(report.totals.followUpHandoffs).toBe(0);
  });

  it('limits replies and conversions to the historical report cutoff', () => {
    inbound2('2026-10-24T09:00:00.000Z');
    sentOneShot('2026-10-24T09:00:00.000Z', '2026-10-25 10:00:00');
    inbound2('2026-10-26T12:00:00.000Z');
    repos2.conversation.upsert(PHONE, { converted_at: '2026-10-26T13:00:00.000Z' });

    const beforeReply = repos2.transcripts.getDayActivity('2026-10-20T00:00:00.000Z', '2026-10-26T00:00:00.000Z');
    expect(beforeReply.totals.followUpsReplied).toBe(0);
    expect(beforeReply.totals.followUpBookings).toBe(0);

    const afterReply = repos2.transcripts.getDayActivity('2026-10-20T00:00:00.000Z', '2026-10-26T12:30:00.000Z');
    expect(afterReply.totals.followUpsReplied).toBe(1);
    expect(afterReply.totals.followUpBookings).toBe(0);
  });
});
