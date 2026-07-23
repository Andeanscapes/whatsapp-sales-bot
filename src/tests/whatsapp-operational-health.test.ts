import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env.js';

const { mockSendTelegram } = vi.hoisted(() => ({
  mockSendTelegram: vi.fn<(_chatId: string, _text: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('../services/telegram-bot.js', () => ({
  sendTelegramMessage: mockSendTelegram,
}));

const {
  checkWhatsAppApiHealth,
  reportWhatsAppApiFailure,
  reportWhatsAppApiSuccess,
  resetWhatsAppOperationalHealth,
  sendStartupStatus,
} = await import('../services/whatsapp-operational-health.js');
const { downloadMedia, sendText } = await import('../services/whatsapp-client.js');

const originalTelegramToken = env.TELEGRAM_BOT_TOKEN;
const originalTelegramChat = env.TELEGRAM_CHAT_ID;

async function flushOps(expectedCalls = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(mockSendTelegram).toHaveBeenCalledTimes(expectedCalls);
  });
}

beforeEach(() => {
  env.TELEGRAM_BOT_TOKEN = 'test-token';
  env.TELEGRAM_CHAT_ID = '999';
  mockSendTelegram.mockReset();
  mockSendTelegram.mockResolvedValue(undefined);
  resetWhatsAppOperationalHealth();
  vi.restoreAllMocks();
});

afterEach(() => {
  env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
  env.TELEGRAM_CHAT_ID = originalTelegramChat;
  vi.restoreAllMocks();
});

describe('WhatsApp operational alerts', () => {
  it('alerts once for an API incident and reports recovery', async () => {
    await reportWhatsAppApiFailure({ operation: 'envio de texto', status: 401 });
    await reportWhatsAppApiFailure({ operation: 'envio de imagen', status: 401 });

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('WhatsApp API ERROR');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('autorizacion rechazada');

    await reportWhatsAppApiSuccess();

    expect(mockSendTelegram).toHaveBeenCalledTimes(2);
    expect(mockSendTelegram.mock.calls[1][1]).toContain('WhatsApp API RECUPERADA');
  });

  it('retries owner alert when Telegram delivery fails', async () => {
    mockSendTelegram.mockRejectedValueOnce(new Error('telegram down'));
    await reportWhatsAppApiFailure({ operation: 'envio de texto', status: 401 });
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);

    mockSendTelegram.mockResolvedValueOnce(undefined);
    await reportWhatsAppApiFailure({ operation: 'envio de texto', status: 401 });
    expect(mockSendTelegram).toHaveBeenCalledTimes(2);
    expect(mockSendTelegram.mock.calls[1][1]).toContain('WhatsApp API ERROR');
  });

  it('does not block sendText on owner Telegram notify', async () => {
    let resolveTelegram: (() => void) | undefined;
    mockSendTelegram.mockImplementation(() => new Promise<void>(resolve => {
      resolveTelegram = resolve;
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));

    await expect(sendText('573001112233', 'hola')).rejects.toThrow('HTTP 401');
    expect(resolveTelegram).toBeTypeOf('function');
    resolveTelegram?.();
    await flushOps();
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
  });

  it('alerts owner when a customer text send receives HTTP 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));

    await expect(sendText('573001112233', 'hola')).rejects.toThrow('HTTP 401');
    await flushOps();

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('WhatsApp API ERROR');
  });

  it('alerts once when media binary download fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('media-123')) {
        return Promise.resolve(new Response(JSON.stringify({
          url: 'https://lookaside.fbsbx.com/whatsapp/abc',
          mime_type: 'image/jpeg',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 403 }));
    });

    await expect(downloadMedia('media-123')).rejects.toThrow('HTTP 403');
    await flushOps();

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('descarga de media');
  });
});

describe('WhatsApp startup health report', () => {
  it('reports healthy Graph API authentication and configured phone membership', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: env.WHATSAPP_PHONE_NUMBER_ID }] }), { status: 200 }));

    const whatsapp = await checkWhatsAppApiHealth();
    await sendStartupStatus({ whatsapp, dynamicDataAvailable: true });

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('Bot iniciado correctamente');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('WhatsApp API: OK');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('Datos dinamicos: OK');
    expect(mockSendTelegram.mock.calls[0][1]).not.toContain('Base de datos');
  });

  it('reports degraded startup and suppresses duplicate first-send alert', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));

    const whatsapp = await checkWhatsAppApiHealth();
    await sendStartupStatus({ whatsapp, dynamicDataAvailable: false });

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('Bot iniciado con alertas');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('WhatsApp API: ERROR');

    await reportWhatsAppApiFailure({ operation: 'envio de texto', status: 401 });
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
  });
});
