import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { formatAdReferral, recordAdReferral } from '../services/ad-referral.js';

describe('ad referral persistence', () => {
  it('formats seller-safe attribution without exposing click identifiers', () => {
    expect(formatAdReferral(JSON.stringify({ headline: 'Tour', source_type: 'ad', source_id: 'campaign-1', ctwa_clid: 'secret-click-id' })))
      .toBe('anuncio=Tour | tipo=ad | origen=campaign-1');
    expect(formatAdReferral('{invalid')).toBeNull();
  });

  it('stores approved Meta fields once and never overwrites attribution', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);
    const phone = '573001112233';

    recordAdReferral(repos, phone, {
      ctwa_clid: 'clid-first', source_id: 'ad-first', source_type: 'ad', headline: 'Tour',
    });
    recordAdReferral(repos, phone, {
      ctwa_clid: 'clid-second', source_id: 'ad-second', source_type: 'ad', headline: 'Other',
    });

    expect(JSON.parse(repos.conversation.getByPhone(phone)?.ad_referral_json ?? '{}')).toEqual({
      ctwa_clid: 'clid-first', source_id: 'ad-first', source_type: 'ad', headline: 'Tour',
    });
    db.close();
  });

  it('does not create a conversation for empty referral metadata', () => {
    const db = new Database(':memory:');
    migrate(db);
    const repos = createRepositories(db);

    recordAdReferral(repos, '573001112244', {});

    expect(repos.conversation.getByPhone('573001112244')).toBeUndefined();
    db.close();
  });
});
