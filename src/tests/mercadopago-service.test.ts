import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { env } from '../config/env.js';
import { migrate } from '../db/migrate.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { createMercadoPagoPreference } from '../services/mercadopago-service.js';

let db: Database.Database;
let repos: Repositories;
let previousAccessToken: string;

const bookingSnapshot = {
  planId: '2d1n_mining',
  date: '2026-11-14',
  people: 2,
  transportNeed: 'own',
  depositPercent: 15,
  availabilityConfirmedAt: '2026-07-26T12:00:00.000Z',
};

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repos = createRepositories(db);
  previousAccessToken = env.MERCADOPAGO_ACCESS_TOKEN;
  env.MERCADOPAGO_ACCESS_TOKEN = 'TEST-access-token';
});

afterEach(() => {
  env.MERCADOPAGO_ACCESS_TOKEN = previousAccessToken;
  vi.restoreAllMocks();
  db.close();
});

describe('createMercadoPagoPreference', () => {
  it('persists the expected deposit and returns Mercado Pago checkout URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'pref-123', init_point: 'https://www.mercadopago.com.co/checkout/v1/redirect?pref_id=pref-123' }),
    } as unknown as Response);

    const result = await createMercadoPagoPreference({
      customerPhone: '573001112233',
      title: 'Reserva Andean Scapes - 2D/1N',
      amountCop: 150000,
      externalReference: 'as_test_123',
      notificationUrl: 'https://bot.example.com/webhooks/mercadopago',
      ...bookingSnapshot,
    }, repos);

    expect(result).toEqual({
      preferenceId: 'pref-123',
      paymentUrl: 'https://www.mercadopago.com.co/checkout/v1/redirect?pref_id=pref-123',
    });
    expect(repos.paymentReservation.getByExternalReference('as_test_123')).toMatchObject({
      customerPhone: '573001112233',
      expectedAmountCop: 150000,
      preferenceId: 'pref-123',
      status: 'pending',
      planId: '2d1n_mining',
      date: '2026-11-14',
      people: 2,
      depositPercent: 15,
      availabilityConfirmedAt: '2026-07-26T12:00:00.000Z',
    });
    expect(fetchSpy).toHaveBeenCalledWith('https://api.mercadopago.com/checkout/preferences', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer TEST-access-token' }),
    }));
  });

  it('rejects non-HTTPS checkout URLs without attaching a preference', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'pref-123', init_point: 'http://unsafe.example.com/pay' }),
    } as unknown as Response);

    const result = await createMercadoPagoPreference({
      customerPhone: '573001112233',
      title: 'Reserva Andean Scapes - 2D/1N',
      amountCop: 150000,
      externalReference: 'as_test_unsafe',
      notificationUrl: 'https://bot.example.com/webhooks/mercadopago',
      ...bookingSnapshot,
    }, repos);

    expect(result).toBeNull();
    expect(repos.paymentReservation.getByExternalReference('as_test_unsafe')).toMatchObject({
      preferenceId: null,
      status: 'failed',
    });
  });

  it('returns null when the request and failed-state persistence both fail', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unavailable'));
    vi.spyOn(repos.paymentReservation, 'markFailed').mockImplementation(() => {
      throw new Error('sqlite unavailable');
    });

    await expect(createMercadoPagoPreference({
      customerPhone: '573001112233',
      title: 'Reserva Andean Scapes - 2D/1N',
      amountCop: 150000,
      externalReference: 'as_test_failed_cleanup',
      notificationUrl: 'https://bot.example.com/webhooks/mercadopago',
      ...bookingSnapshot,
    }, repos)).resolves.toBeNull();
  });

  it('does not create a second pending preference for the same customer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'pref-123', init_point: 'https://www.mercadopago.com.co/checkout/v1/redirect?pref_id=pref-123' }),
    } as unknown as Response);

    const first = await createMercadoPagoPreference({
      customerPhone: '573001112233',
      title: 'Reserva Andean Scapes - 2D/1N',
      amountCop: 150000,
      externalReference: 'as_test_first',
      notificationUrl: 'https://bot.example.com/webhooks/mercadopago',
      ...bookingSnapshot,
    }, repos);
    const second = await createMercadoPagoPreference({
      customerPhone: '573001112233',
      title: 'Reserva Andean Scapes - 2D/1N',
      amountCop: 150000,
      externalReference: 'as_test_second',
      notificationUrl: 'https://bot.example.com/webhooks/mercadopago',
      ...bookingSnapshot,
    }, repos);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(repos.paymentReservation.getByExternalReference('as_test_second')).toBeNull();
  });
});
