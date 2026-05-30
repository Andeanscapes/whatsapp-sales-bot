import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { loadSkills } from '../services/skill-loader.js';

let repos: Repositories;
let db: Database.Database;

beforeAll(() => {
  loadSkills();
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
});

function insertAlertAt(phone: string, channel: string, score: number, alertType: string, sentAtIso: string): void {
  db.prepare(
    'INSERT INTO owner_alerts (customer_phone, channel, score, alert_type, sent_at, body) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(phone, channel, score, alertType, sentAtIso, 'test alert body');
}

describe('OwnerAlertRepository.wasAlertedToday (UTC timezone)', () => {
  it('returns false when last alert was before UTC midnight today', () => {
    const phone = '573001112299';

    const beforeMidnightUtc = new Date();
    beforeMidnightUtc.setUTCHours(0, 0, 0, 0);
    beforeMidnightUtc.setUTCSeconds(beforeMidnightUtc.getUTCSeconds() - 1);

    insertAlertAt(phone, 'telegram', 90, 'urgent', beforeMidnightUtc.toISOString());

    expect(repos.ownerAlert.wasAlertedToday(phone, 'urgent')).toBe(false);
  });

  it('returns true when alert was just after UTC midnight today', () => {
    const phone = '573001112298';

    const afterMidnightUtc = new Date();
    afterMidnightUtc.setUTCHours(0, 0, 1, 0);

    insertAlertAt(phone, 'whatsapp', 95, 'hot', afterMidnightUtc.toISOString());

    expect(repos.ownerAlert.wasAlertedToday(phone, 'hot')).toBe(true);
  });

  it('returns true for an alert sent right now', () => {
    const phone = '573001112297';
    repos.ownerAlert.insert(phone, 'whatsapp', 85, 'hot', 'test body');
    expect(repos.ownerAlert.wasAlertedToday(phone, 'hot')).toBe(true);
  });

  it('distinguishes alert types independently', () => {
    const phone = '573001112296';
    repos.ownerAlert.insert(phone, 'telegram', 90, 'urgent', 'test body');
    expect(repos.ownerAlert.wasAlertedToday(phone, 'hot')).toBe(false);
    expect(repos.ownerAlert.wasAlertedToday(phone, 'urgent')).toBe(true);
  });
});
