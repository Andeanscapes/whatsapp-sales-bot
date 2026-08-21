import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import type { Repositories } from '../db/repositories/index.js';
import { getConversationReplay } from '../services/conversation-media.js';

const PHONE = '573001112233';

describe('conversation replay merge', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repos = createRepositories(db);
    repos.conversation.upsert(PHONE, { language: 'es' });
  });

  afterEach(() => db.close());

  function inbound(body: string, at: string, mediaId?: string): void {
    repos.message.addMessage({
      whatsapp_message_id: `in-${at}`,
      customer_phone: PHONE,
      direction: 'inbound',
      message_type: mediaId ? 'image' : 'text',
      body,
      created_at: at,
      media_id: mediaId,
    });
  }

  function outbound(body: string, at: string): void {
    repos.message.addMessage({
      customer_phone: PHONE,
      direction: 'outbound',
      message_type: 'text',
      body,
      created_at: at,
    });
  }

  it('renders a captioned photo instead of the duplicate reply text', () => {
    inbound('mandame fotos', '2026-08-20T10:00:00.000Z');
    outbound('Aqui las tienes. Te sirve una fecha de este mes?', '2026-08-20T10:00:05.000Z');
    repos.outboundMedia.record({
      customer_phone: PHONE,
      media_url: 'https://cdn.example.com/mine.jpg',
      media_id: 'gallery_/mine.jpg',
      caption: 'Aqui las tienes. Te sirve una fecha de este mes?',
      carried_reply: 1,
      flow: 'requested_gallery',
      theme_type: 'mine',
      sent_at: '2026-08-20T10:00:04.000Z',
    });

    const replay = getConversationReplay(repos, PHONE);

    // Exactly one assistant turn, delivered as a photo — never text + photo.
    const assistantTurns = replay.filter(item => item.role === 'assistant');
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]).toMatchObject({
      kind: 'outbound_photo',
      mediaUrl: 'https://cdn.example.com/mine.jpg',
      text: 'Aqui las tienes. Te sirve una fecha de este mes?',
      theme: 'mine',
    });
    expect(replay.some(item => item.kind === 'text' && item.role === 'assistant')).toBe(false);
  });

  it('keeps the reply as text when no photo carried it', () => {
    inbound('cuanto vale', '2026-08-20T10:00:00.000Z');
    outbound('Depende del plan. Cuantos van?', '2026-08-20T10:00:05.000Z');

    const replay = getConversationReplay(repos, PHONE);
    expect(replay.map(i => i.kind)).toEqual(['text', 'text']);
    expect(replay[1].text).toBe('Depende del plan. Cuantos van?');
  });

  it('renders captionless gallery frames in chronological position', () => {
    inbound('fotos', '2026-08-20T10:00:00.000Z');
    outbound('Mira estas. Te gusta alguna?', '2026-08-20T10:00:09.000Z');
    // Burst: two captionless frames, then the captioned one.
    for (const [index, at] of ['2026-08-20T10:00:06.000Z', '2026-08-20T10:00:07.000Z'].entries()) {
      repos.outboundMedia.record({
        customer_phone: PHONE,
        media_url: `https://cdn.example.com/f${index}.jpg`,
        media_id: `gallery_/f${index}.jpg`,
        caption: '',
        carried_reply: 0,
        flow: 'requested_gallery',
        sequence: index,
        sent_at: at,
      });
    }
    repos.outboundMedia.record({
      customer_phone: PHONE,
      media_url: 'https://cdn.example.com/f2.jpg',
      media_id: 'gallery_/f2.jpg',
      caption: 'Mira estas. Te gusta alguna?',
      carried_reply: 1,
      flow: 'requested_gallery',
      sequence: 2,
      sent_at: '2026-08-20T10:00:08.000Z',
    });

    const replay = getConversationReplay(repos, PHONE);

    expect(replay.map(i => i.kind)).toEqual(['text', 'outbound_photo', 'outbound_photo', 'outbound_photo']);
    expect(replay.map(i => i.mediaUrl)).toEqual([
      undefined,
      'https://cdn.example.com/f0.jpg',
      'https://cdn.example.com/f1.jpg',
      'https://cdn.example.com/f2.jpg',
    ]);
    // Caption lands on the LAST frame, matching WhatsApp delivery order.
    expect(replay.at(-1)?.text).toBe('Mira estas. Te gusta alguna?');
  });

  it('exposes the inbound media id so a replay can re-download the customer photo', () => {
    inbound('miren esto', '2026-08-20T10:00:00.000Z', 'wamid.MEDIA1');

    const replay = getConversationReplay(repos, PHONE);
    expect(replay[0]).toMatchObject({
      kind: 'inbound_media',
      role: 'user',
      mediaId: 'wamid.MEDIA1',
      text: 'miren esto',
    });
  });

  it('ignores ledger rows older than the loaded message window', () => {
    repos.outboundMedia.record({
      customer_phone: PHONE,
      media_url: 'https://cdn.example.com/ancient.jpg',
      media_id: 'gallery_/ancient.jpg',
      caption: '',
      carried_reply: 0,
      flow: 'requested_gallery',
      sent_at: '2020-01-01T00:00:00.000Z',
    });
    inbound('hola', '2026-08-20T10:00:00.000Z');

    const replay = getConversationReplay(repos, PHONE);
    expect(replay.map(i => i.mediaUrl)).not.toContain('https://cdn.example.com/ancient.jpg');
  });

  it('does not let one photo satisfy two identical replies', () => {
    inbound('fotos', '2026-08-20T10:00:00.000Z');
    outbound('Aqui van.', '2026-08-20T10:00:02.000Z');
    inbound('otra vez', '2026-08-20T10:00:03.000Z');
    outbound('Aqui van.', '2026-08-20T10:00:05.000Z');
    for (const at of ['2026-08-20T10:00:01.000Z', '2026-08-20T10:00:04.000Z']) {
      repos.outboundMedia.record({
        customer_phone: PHONE,
        media_url: `https://cdn.example.com/${at}.jpg`,
        media_id: `gallery_/${at}.jpg`,
        caption: 'Aqui van.',
        carried_reply: 1,
        flow: 'requested_gallery',
        sent_at: at,
      });
    }

    const replay = getConversationReplay(repos, PHONE);
    const photos = replay.filter(i => i.kind === 'outbound_photo');
    expect(photos).toHaveLength(2);
    expect(new Set(photos.map(p => p.mediaUrl)).size).toBe(2);
    expect(replay.filter(i => i.kind === 'text' && i.role === 'assistant')).toHaveLength(0);
  });
});
