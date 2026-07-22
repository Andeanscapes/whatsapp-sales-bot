import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { setErrorRepos, logSystemError, pruneOldErrors } from '../services/error-logger.js';
import { sanitizeSensitiveText, sanitizeUrl } from '../config/logger.js';
import type { Repositories } from '../db/repositories/index.js';

describe('SystemErrorRepository', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    setErrorRepos(repos);
  });

  afterEach(() => {
    db.close();
    setErrorRepos(null);
  });

  it('inserts an error record into system_errors', () => {
    repos.systemErrors.insert('whatsapp_send', 'error', 'HTTP 500 send failed', 'Error: HTTP 500\n  at sendText (whatsapp-client.ts:62:9)', { phone: '573001112233' });

    const row = db.prepare('SELECT * FROM system_errors WHERE error_type = ?').get('whatsapp_send') as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.error_type).toBe('whatsapp_send');
    expect(row?.severity).toBe('error');
    expect(row?.message).toBe('HTTP 500 send failed');
    expect(row?.stack).toContain('sendText');
    expect(row?.context_json).toContain('573001112233');
    expect(row?.created_at).toBeDefined();
  });

  it('stores multiple errors independently', () => {
    repos.systemErrors.insert('telegram_poll', 'warning', 'poll timeout', undefined, { lastUpdateId: 42 });
    repos.systemErrors.insert('webhook_process', 'critical', 'null reference', undefined, undefined);

    const count = db.prepare('SELECT COUNT(*) as c FROM system_errors').get() as { c: number };
    expect(count.c).toBe(2);
  });

  it('handles null stack and context', () => {
    repos.systemErrors.insert('deepseek_call', 'error', 'API timeout');

    const row = db.prepare('SELECT * FROM system_errors WHERE error_type = ?').get('deepseek_call') as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.stack).toBeNull();
    expect(row?.context_json).toBeNull();
  });

  it('prunes errors older than specified days', () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(
      'INSERT INTO system_errors (error_type, severity, message, created_at) VALUES (?, ?, ?, ?)'
    ).run('old_error', 'error', 'old', oldDate);
    db.prepare(
      'INSERT INTO system_errors (error_type, severity, message, created_at) VALUES (?, ?, ?, ?)'
    ).run('recent_error', 'warning', 'recent', recentDate);

    const deleted = repos.systemErrors.pruneOlderThan(90);
    expect(deleted).toBe(1);

    const remaining = db.prepare('SELECT * FROM system_errors').all() as { error_type: string }[];
    expect(remaining.length).toBe(1);
    expect(remaining[0].error_type).toBe('recent_error');
  });

  it('prune returns 0 when no old errors exist', () => {
    repos.systemErrors.insert('test', 'info', 'fresh');

    const deleted = repos.systemErrors.pruneOlderThan(90);
    expect(deleted).toBe(0);
  });
});

describe('logSystemError', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    setErrorRepos(repos);
  });

  afterEach(() => {
    db.close();
    setErrorRepos(null);
  });

  it('writes Error instance to DB', () => {
    const err = new Error('Something broke');
    logSystemError('test_type', 'error', err, { key: 'value' });

    const row = db.prepare('SELECT * FROM system_errors WHERE error_type = ?').get('test_type') as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.message).toBe('Something broke');
    expect(row?.stack).toContain('Something broke');
    expect(row?.context_json).toContain('"key":"value"');
    expect(row?.severity).toBe('error');
  });

  it('masks phone and redacts message context', () => {
    logSystemError('pii_test', 'error', new Error('test'), { phone: '573001112233', messagePreview: 'private customer text' });

    const row = db.prepare('SELECT * FROM system_errors WHERE error_type = ?').get('pii_test') as Record<string, unknown> | undefined;
    expect(row?.context_json).toContain('573***233');
    expect(row?.context_json).not.toContain('573001112233');
    expect(row?.context_json).toContain('[REDACTED]');
    expect(row?.context_json).not.toContain('private customer text');
  });

  it('sanitizes secrets in persisted error message, stack, and URL context', () => {
    const token = 'private-verify-token';
    const err = new Error(`request failed: /webhooks/whatsapp?hub.verify_token=${token}&hub.challenge=abc`);
    err.stack = `Error: ${err.message}\nAuthorization: Bearer private-access-token`;

    logSystemError('secret_test', 'error', err, {
      requestUrl: `/webhooks/whatsapp?hub.verify_token=${token}&hub.challenge=abc`,
      requestId: 'req-123',
    });

    const row = db.prepare('SELECT * FROM system_errors WHERE error_type = ?').get('secret_test') as Record<string, unknown> | undefined;
    expect(row?.message).not.toContain(token);
    expect(row?.stack).not.toContain('private-access-token');
    expect(row?.context_json).not.toContain(token);
    expect(row?.context_json).toContain('req-123');
    expect(row?.message).toContain('[REDACTED]');
  });

  it('handles non-Error thrown values', () => {
    logSystemError('string_error', 'warning', 'plain string error', undefined);

    const row = db.prepare('SELECT * FROM system_errors WHERE error_type = ?').get('string_error') as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.message).toBe('plain string error');
    expect(row?.stack).toBeNull();
  });

  it('does not throw when repos is null', () => {
    setErrorRepos(null);
    expect(() => logSystemError('no_repo', 'error', new Error('test'))).not.toThrow();
  });
});

describe('log sanitizers', () => {
  it('redacts sensitive query parameters while preserving correlation parameters', () => {
    const sanitized = sanitizeUrl('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=secret-token&request_id=req-123');

    expect(sanitized).toBe('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=[REDACTED]&request_id=req-123');
  });

  it('redacts authorization values in error text', () => {
    expect(sanitizeSensitiveText('failed Authorization: Bearer secret-token')).toBe('failed Authorization: [REDACTED]');
  });
});

describe('pruneOldErrors', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
  });

  afterEach(() => {
    db.close();
  });

  it('does not throw when DB fails', () => {
    db.close();
    expect(() => pruneOldErrors(repos)).not.toThrow();
  });
});
