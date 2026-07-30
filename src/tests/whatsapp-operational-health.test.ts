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
  reportAiBudgetBlocked,
  reportCriticalSystemError,
  reportDeepSeekFailure,
  reportDeepSeekSuccess,
  reportWhatsAppApiFailure,
  reportWhatsAppApiSuccess,
  resetWhatsAppOperationalHealth,
  runPeriodicOperationalChecks,
  sendStartupStatus,
} = await import('../services/whatsapp-operational-health.js');
const { downloadMedia, sendText } = await import('../services/whatsapp-client.js');
const { requestDeepSeekCompletion } = await import('../services/llm/deepseek-completion.js');

const originalTelegramToken = env.TELEGRAM_BOT_TOKEN;
const originalTelegramChat = env.TELEGRAM_CHAT_ID;
const originalAiEnabled = env.AI_ENABLED;
const originalPublicBaseUrl = env.PUBLIC_BASE_URL;
const originalDynamicSkillUrl = env.DYNAMIC_SKILL_URL;

async function flushOps(expectedCalls = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(mockSendTelegram).toHaveBeenCalledTimes(expectedCalls);
  });
}

function mockHealthyExternalServices(options?: { whatsappOk?: boolean }): void {
  const whatsappOk = options?.whatsappOk ?? true;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('graph.facebook.com')) {
      if (url.includes('/phone_numbers')) {
        const body = whatsappOk
          ? { data: [{ id: env.WHATSAPP_PHONE_NUMBER_ID }] }
          : { data: [] };
        return Promise.resolve(new Response(JSON.stringify(body), { status: whatsappOk ? 200 : 401 }));
      }
      return Promise.resolve(new Response('{}', { status: whatsappOk ? 200 : 401 }));
    }
    if (url.includes('api.deepseek.com')) {
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }
    if (url.includes('api.telegram.org') && url.includes('/getMe')) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200 }));
    }
    if (url.includes('/health')) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, uptime: 1 }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
}

beforeEach(() => {
  env.TELEGRAM_BOT_TOKEN = 'test-token';
  env.TELEGRAM_CHAT_ID = '999';
  env.AI_ENABLED = true;
  env.PUBLIC_BASE_URL = 'https://bot.example.com';
  env.DYNAMIC_SKILL_URL = 'https://cdn.example.com/dynamic.json';
  mockSendTelegram.mockReset();
  mockSendTelegram.mockResolvedValue(undefined);
  resetWhatsAppOperationalHealth();
  vi.restoreAllMocks();
});

afterEach(() => {
  env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
  env.TELEGRAM_CHAT_ID = originalTelegramChat;
  env.AI_ENABLED = originalAiEnabled;
  env.PUBLIC_BASE_URL = originalPublicBaseUrl;
  env.DYNAMIC_SKILL_URL = originalDynamicSkillUrl;
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
    // Ops notify is fire-and-forget (+ dynamic telegram import); wait until it starts.
    await vi.waitFor(() => {
      expect(resolveTelegram).toBeTypeOf('function');
    });
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

  it('does not alert owner on HTTP 400 client errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 400 }));

    await expect(sendText('573001112233', 'hola')).rejects.toThrow('HTTP 400');
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('does not flap recovery when a later send succeeds after ignored 400', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 400 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await expect(sendText('573001112233', 'hola')).rejects.toThrow('HTTP 400');
    await sendText('573001112233', 'hola');
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(mockSendTelegram).not.toHaveBeenCalled();
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
  it('reports healthy external services', async () => {
    mockHealthyExternalServices();

    const whatsapp = await checkWhatsAppApiHealth();
    await sendStartupStatus({ whatsapp, dynamicDataAvailable: true });

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    const body = mockSendTelegram.mock.calls[0][1];
    expect(body).toContain('🚀 Bot iniciado correctamente');
    expect(body).toContain('✅ WhatsApp API: OK');
    expect(body).toContain('✅ DeepSeek LLM: OK');
    expect(body).toContain('✅ Datos dinamicos: OK');
    expect(body).toContain('✅ Telegram API: OK');
    expect(body).toContain('✅ Webhook publico (tunnel): OK');
    expect(body).not.toContain('Base de datos');
  });

  it('reports degraded startup and suppresses duplicate first-send alert', async () => {
    mockHealthyExternalServices({ whatsappOk: false });

    const whatsapp = await checkWhatsAppApiHealth();
    await sendStartupStatus({ whatsapp, dynamicDataAvailable: false });

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    const body = mockSendTelegram.mock.calls[0][1];
    expect(body).toContain('⚠️ Bot iniciado con alertas');
    expect(body).toContain('❌ WhatsApp API: ERROR');
    expect(body).toContain('❌ Datos dinamicos: ERROR');

    await reportWhatsAppApiFailure({ operation: 'envio de texto', status: 401 });
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
  });

  it('marks DeepSeek disabled and public webhook unconfigured without failing hard', async () => {
    env.AI_ENABLED = false;
    env.PUBLIC_BASE_URL = 'https://bot.yourdomain.com';
    env.DYNAMIC_SKILL_URL = '';
    mockHealthyExternalServices();

    const whatsapp = await checkWhatsAppApiHealth();
    await sendStartupStatus({ whatsapp, dynamicDataAvailable: false });

    const body = mockSendTelegram.mock.calls[0][1];
    expect(body).toContain('🚀 Bot iniciado correctamente');
    expect(body).toContain('⏸️ DeepSeek LLM: deshabilitado');
    expect(body).toContain('⚪ Datos dinamicos: no configurado');
    expect(body).toContain('⚪ Webhook publico (tunnel): no configurado');
  });
});

describe('Runtime operational alerts', () => {
  it('alerts once for DeepSeek outage and reports recovery', async () => {
    await reportDeepSeekFailure('HTTP 503');
    await reportDeepSeekFailure('HTTP 503');

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('DeepSeek LLM ERROR');

    await reportDeepSeekSuccess();
    expect(mockSendTelegram).toHaveBeenCalledTimes(2);
    expect(mockSendTelegram.mock.calls[1][1]).toContain('DeepSeek LLM RECUPERADO');
  });

  it('alerts once per day when AI budget is blocked', async () => {
    await reportAiBudgetBlocked('daily_budget_exceeded');
    await reportAiBudgetBlocked('daily_budget_exceeded');

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('AI budget agotado');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('daily_budget_exceeded');
  });

  it('alerts once per hour for critical system errors of same type', async () => {
    await reportCriticalSystemError('uncaught_exception', 'boom');
    await reportCriticalSystemError('uncaught_exception', 'boom again');

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    expect(mockSendTelegram.mock.calls[0][1]).toContain('Error critico del sistema');
    expect(mockSendTelegram.mock.calls[0][1]).toContain('uncaught_exception');
  });

  it('reports DeepSeek failure from completion transport', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));

    const result = await requestDeepSeekCompletion({
      messages: [{ role: 'user', content: 'hola' }],
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 1000,
      logTag: '[TEST]',
    });
    expect(result).toBeNull();
    await flushOps();
    expect(mockSendTelegram.mock.calls[0][1]).toContain('DeepSeek LLM ERROR');
  });

  it('opens webhook incident on periodic check when public health fails', async () => {
    env.AI_ENABLED = false;
    env.DYNAMIC_SKILL_URL = '';
    env.PUBLIC_BASE_URL = 'https://bot.example.com';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 502 }));

    await runPeriodicOperationalChecks();
    await flushOps();

    expect(mockSendTelegram.mock.calls[0][1]).toContain('Webhook publico ERROR');
  });

  it('never pages when AI is intentionally disabled (ai_disabled)', async () => {
    await reportAiBudgetBlocked('ai_disabled');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('does not throw on a critical error when Telegram is not configured', async () => {
    env.TELEGRAM_BOT_TOKEN = '';
    env.TELEGRAM_CHAT_ID = '';

    await expect(reportCriticalSystemError('uncaught_exception', 'boom')).resolves.toBeUndefined();
    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  it('reports webhook recovery after an incident (ERROR then OK)', async () => {
    env.AI_ENABLED = false;
    env.DYNAMIC_SKILL_URL = '';
    env.PUBLIC_BASE_URL = 'https://bot.example.com';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 502 }));
    await runPeriodicOperationalChecks();
    await flushOps();
    expect(mockSendTelegram.mock.calls[0][1]).toContain('Webhook publico ERROR');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await runPeriodicOperationalChecks();
    await flushOps(2);
    expect(mockSendTelegram.mock.calls[1][1]).toContain('Webhook publico RECUPERADO');
  });
});
