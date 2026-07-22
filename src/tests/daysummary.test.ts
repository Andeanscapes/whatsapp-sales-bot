import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { daysummaryHandler } from '../commands/daysummary.command.js';
import { env } from '../config/env.js';

let repos: Repositories;
let db: Database.Database;
let previousTelegramToken: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousTelegramToken = env.TELEGRAM_BOT_TOKEN;
  env.TELEGRAM_BOT_TOKEN = 'test-token';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
});

afterEach(() => {
  env.TELEGRAM_BOT_TOKEN = previousTelegramToken;
  vi.restoreAllMocks();
  db.close();
});

function insertConversation(phone: string, firstSeenAt: string, leadScore: number, name?: string): void {
  db.prepare(
    'INSERT INTO conversations (customer_phone, first_seen_at, last_seen_at, lead_score, collected_name) VALUES (?, ?, ?, ?, ?)'
  ).run(phone, firstSeenAt, firstSeenAt, leadScore, name ?? null);
}

function insertMessage(phone: string, direction: 'inbound' | 'outbound', body: string, createdAt: string): void {
  const appVersion = direction === 'outbound' ? env.APP_VERSION : null;
  db.prepare(
    'INSERT INTO messages (customer_phone, direction, message_type, body, created_at, app_version) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(phone, direction, 'text', body, createdAt, appVersion);
}

function insertAiUsage(phone: string, cost: number, createdAt: string): void {
  db.prepare(
    'INSERT INTO ai_usage (customer_phone, model, prompt_tokens, completion_tokens, estimated_cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(phone, 'deepseek', 100, 50, cost, createdAt);
}

describe('getDayActivity', () => {
  function todayH(hour: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour)).toISOString();
  }

  function todayMidnight(): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }

  it('returns conversations with messages in period', () => {
    insertConversation('+111', todayMidnight(), 50, 'Alice');
    insertMessage('+111', 'inbound', 'Hola', todayH(10));
    insertMessage('+111', 'outbound', 'Buen dia', todayH(10));

    const result = repos.transcripts.getDayActivity(todayMidnight(), null);

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].customerPhone).toBe('+111');
    expect(result.conversations[0].name).toBe('Alice');
    expect(result.conversations[0].messageCount).toBe(2);
    expect(result.conversations[0].inboundCount).toBe(1);
    expect(result.conversations[0].outboundCount).toBe(1);
    expect(result.conversations[0].messages).toHaveLength(2);
    expect(result.totals.totalConversations).toBe(1);
    expect(result.totals.totalMessages).toBe(2);
  });

  it('sets appVersion on outbound messages, null on inbound', () => {
    insertConversation('+111', todayMidnight(), 50, 'Alice');
    insertMessage('+111', 'inbound', 'Hola', todayH(10));
    insertMessage('+111', 'outbound', 'Respuesta', todayH(10));

    const result = repos.transcripts.getDayActivity(todayMidnight(), null);

    const msgs = result.conversations[0].messages;
    expect(msgs).toHaveLength(2);
    const inboundMsg = msgs.find(m => m.direction === 'inbound');
    const outboundMsg = msgs.find(m => m.direction === 'outbound');
    expect(inboundMsg!.appVersion).toBeNull();
    expect(outboundMsg!.appVersion).toBe(env.APP_VERSION);
  });

  it('excludes messages outside period', () => {
    insertConversation('+111', '2020-01-01T00:00:00.000Z', 50, 'Alice');
    insertMessage('+111', 'inbound', 'Hola', todayH(10));
    insertMessage('+111', 'inbound', 'Hola ayer', '2020-01-01T10:00:00.000Z');

    const result = repos.transcripts.getDayActivity(todayMidnight(), null);

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].messages).toHaveLength(1);
    expect(result.conversations[0].messages[0].text).toBe('Hola');
  });

  it('includes AI cost for the period', () => {
    insertConversation('+111', todayMidnight(), 50, 'Alice');
    insertMessage('+111', 'inbound', 'Hola', todayH(10));
    insertAiUsage('+111', 0.0025, todayH(10));

    const result = repos.transcripts.getDayActivity(todayMidnight(), null);

    expect(result.conversations[0].aiCostUsd).toBe(0.0025);
    expect(result.totals.totalAiCostUsd).toBe(0.0025);
  });

  it('reports follow-up outcomes and post-follow-up booking attribution', () => {
    const at = todayH(10);
    insertConversation('+111', todayMidnight(), 50, 'Alice');
    insertMessage('+111', 'inbound', 'Hola', at);
    repos.followUpEvent.insert({
      customerPhone: '+111', sequenceNumber: 1, stage: 'first_nudge', sentAt: at,
      repliedAt: todayH(11), scoreBefore: 50, scoreAfter: 65, detectedPain: 'price', status: 'replied',
    });
    repos.conversation.upsert('+111', {
      handed_off_at: todayH(12),
      converted_at: todayH(12),
    });

    const result = repos.transcripts.getDayActivity(todayMidnight(), null);

    expect(result.totals.followUpsSent).toBe(1);
    expect(result.totals.followUpsReplied).toBe(1);
    expect(result.totals.followUpHandoffs).toBe(1);
    expect(result.totals.followUpBookings).toBe(1);
    expect(result.conversations[0].followUps[0]?.detectedPain).toBe('price');
  });

  it('returns empty result when no messages in period', () => {
    insertConversation('+111', '2020-01-01T00:00:00.000Z', 50, 'Alice');
    insertMessage('+111', 'inbound', 'Hola antigua', '2020-01-01T10:00:00.000Z');

    const result = repos.transcripts.getDayActivity(todayMidnight(), null);

    expect(result.conversations).toHaveLength(0);
  });

  it('respects untilIso for yesterday period', () => {
    insertConversation('+111', todayMidnight(), 50, 'Alice');
    insertMessage('+111', 'inbound', 'ayer msg', todayH(-20));

    const yesterdayStart = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
    })();

    const result = repos.transcripts.getDayActivity(yesterdayStart, todayMidnight());

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].messages[0].text).toBe('ayer msg');
  });

  it('computes day label in returned JSON', () => {
    insertConversation('+111', todayMidnight(), 50, 'Alice');
    insertMessage('+111', 'inbound', 'Hola', todayH(10));

    const result = repos.transcripts.getDayActivity(todayMidnight(), null);

    expect(result.totals.generatedAt).toBeTruthy();
    expect(result.totals.totalConversations).toBe(1);
  });
});

describe('daysummary command handler', () => {
  it('returns usage for invalid period', async () => {
    const out = await daysummaryHandler({ repos, args: ['marzo'], chatId: 111 });
    expect(out).toContain('Uso:');
  });

  it('reports zero conversations for empty period', async () => {
    const out = await daysummaryHandler({ repos, args: ['hoy'], chatId: 111 });
    expect(out).toContain('sin conversaciones activas');
  });

  it('shows conversation summary for today', async () => {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const h10 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10)).toISOString();

    insertConversation('+111', midnight, 75, 'Alice');
    insertMessage('+111', 'inbound', 'Hola', h10);
    insertMessage('+111', 'outbound', 'Buen dia', h10);

    const out = await daysummaryHandler({ repos, args: ['hoy'], chatId: 111 });
    expect(out).toContain('Resumen Hoy');
    expect(out).toContain('+111');
    expect(out).toContain('Alice');
    expect(out).toContain('75pts');
    expect(out).toContain('2msgs');
  });

  it('escapes Markdown-sensitive customer fields', async () => {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const h10 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10)).toISOString();

    insertConversation('+111', midnight, 75, 'Ana_Test [VIP] `gold` *lead*');
    insertMessage('+111', 'inbound', 'Hola', h10);

    const out = await daysummaryHandler({ repos, args: ['hoy'], chatId: 111 });
    expect(out).toContain('Ana\\_Test \\[VIP] \\`gold\\` \\*lead\\*');
  });

  it('keeps text summary visible when JSON document send fails', async () => {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const h10 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10)).toISOString();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 500 }));

    insertConversation('+111', midnight, 75, 'Alice');
    insertMessage('+111', 'inbound', 'Hola', h10);

    const out = await daysummaryHandler({ repos, args: ['hoy'], chatId: 111 });
    expect(out).toContain('Resumen Hoy');
    expect(out).toContain('JSON no enviado');
  });

  it('truncates display at 15 conversations', async () => {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const h10 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10)).toISOString();

    for (let i = 0; i < 20; i++) {
      const phone = `+111${String(i).padStart(2, '0')}`;
      insertConversation(phone, midnight, 50, `User${i}`);
      insertMessage(phone, 'inbound', `msg${i}`, h10);
    }

    const out = await daysummaryHandler({ repos, args: ['hoy'], chatId: 111 });
    expect(out).toContain('y 5 mas (ver JSON)');
  });

  it('sends JSON document via Telegram fetch', async () => {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const h10 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10)).toISOString();

    insertConversation('+111', midnight, 75, 'Alice');
    insertMessage('+111', 'inbound', 'Hola', h10);

    await daysummaryHandler({ repos, args: ['hoy'], chatId: 111 });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
    const docCall = calls.find(c => String(c[0]).includes('/sendDocument'));
    expect(docCall).toBeTruthy();
  });
});
