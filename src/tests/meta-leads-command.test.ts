import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { env } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { metaLeadsHandler } from '../commands/meta-leads.command.js';
import { metaConsentHandler } from '../commands/meta-consent.command.js';

describe('meta leads command handler', () => {
  let db: Database.Database;
  let repos: Repositories;
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

  it('sends consented active unbooked leads and excludes missing consent, opted-out, and booked leads', async () => {
    repos.conversation.upsert('573001112233', { collected_name: 'Ana Maria' });
    repos.conversation.upsert('573001112234', { collected_name: 'Luis' });
    repos.conversation.upsert('573001112235', { collected_name: 'Booked Person' });
    repos.conversation.upsert('573001112236', { collected_name: 'No Consent' });
    repos.conversation.recordMetaAudienceConsent('573001112233', 'whatsapp_explicit_opt_in');
    repos.conversation.recordMetaAudienceConsent('573001112234', 'whatsapp_explicit_opt_in');
    repos.conversation.recordMetaAudienceConsent('573001112235', 'booking_checkout_opt_in');
    repos.optOut.setOptOut('573001112234');
    repos.conversation.setBooked('573001112235');

    const result = await metaLeadsHandler({ repos, args: [], chatId: 111 });

    expect(result).toContain('CSV enviado: 1 leads sin reserva');
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
    const documentCall = calls.find(([input]) => input.includes('/sendDocument'));
    expect(documentCall).toBeTruthy();
    const form = documentCall?.[1].body as FormData;
    expect(await (form.get('document') as Blob).text()).toContain('"573001112233","Ana","Maria","CO"');
    expect(await (form.get('document') as Blob).text()).not.toContain('573001112234');
    expect(await (form.get('document') as Blob).text()).not.toContain('573001112235');
    expect(await (form.get('document') as Blob).text()).not.toContain('573001112236');
  });

  it('returns an error message when Telegram rejects the document', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('down', { status: 500 }));

    await expect(metaLeadsHandler({ repos, args: [], chatId: 111 }))
      .resolves.toBe('No se pudo enviar el CSV. Intenta de nuevo.');
  });

  it('records documented consent through the owner command', async () => {
    const result = await metaConsentHandler({
      repos,
      args: ['+57-300-111-2233', 'whatsapp_explicit_opt_in'],
      chatId: 111,
    });

    expect(result).toContain('Consentimiento Meta registrado');
    expect(repos.conversation.listMetaAudienceLeads()).toEqual([
      { customerPhone: '573001112233', collectedName: null },
    ]);
  });

  it('rejects an undocumented consent source', async () => {
    const result = await metaConsentHandler({ repos, args: ['573001112233', 'inferred'], chatId: 111 });

    expect(result).toContain('Uso: /metaconsent');
    expect(repos.conversation.listMetaAudienceLeads()).toEqual([]);
  });
});
