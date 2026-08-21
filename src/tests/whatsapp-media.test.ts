import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadMedia, sendTemplate, sendText, sendTextWithId, uploadMedia, WhatsAppSendError, MAX_AUDIO_BYTES, MAX_MEDIA_BYTES } from '../services/whatsapp-client.js';

const MEDIA_ID = 'media-123';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function binaryResponse(body: string, contentLength?: number): Response {
  const headers: Record<string, string> = { 'content-type': 'image/jpeg' };
  if (contentLength !== undefined) headers['content-length'] = String(contentLength);
  return new Response(body, { status: 200, headers });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('downloadMedia SSRF guard', () => {
  it('rejects a media url whose host is not allowlisted (token never sent to it)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(MEDIA_ID)) return Promise.resolve(jsonResponse({ url: 'https://evil.example.com/steal', mime_type: 'image/jpeg' }));
      return Promise.resolve(binaryResponse('abc'));
    });

    await expect(downloadMedia(MEDIA_ID)).rejects.toThrow('host not allowed');

    // Only the metadata call happened; the attacker host was never fetched.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain(MEDIA_ID);
  });

  it('accepts an allowlisted facebook host', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(MEDIA_ID)) return Promise.resolve(jsonResponse({ url: 'https://lookaside.fbsbx.com/whatsapp/abc', mime_type: 'image/jpeg' }));
      return Promise.resolve(binaryResponse('abc'));
    });

    const result = await downloadMedia(MEDIA_ID);
    expect(result.buffer.byteLength).toBe(3);
    expect(result.mimeType).toBe('image/jpeg');
  });
});

describe('media size cap', () => {
  it('rejects download when content-length exceeds the cap', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(MEDIA_ID)) return Promise.resolve(jsonResponse({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg' }));
      return Promise.resolve(binaryResponse('a', MAX_MEDIA_BYTES + 1));
    });

    await expect(downloadMedia(MEDIA_ID)).rejects.toThrow('exceeds');
  });

  it('allows inbound audio above the image cap but within the audio cap', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(MEDIA_ID)) return Promise.resolve(jsonResponse({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'audio/ogg' }));
      return Promise.resolve(binaryResponse('a', MAX_MEDIA_BYTES + 1));
    });

    const result = await downloadMedia(MEDIA_ID);
    expect(result.mimeType).toBe('audio/ogg');
  });

  it('rejects inbound audio above the audio cap', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(MEDIA_ID)) return Promise.resolve(jsonResponse({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'audio/ogg' }));
      return Promise.resolve(binaryResponse('a', MAX_AUDIO_BYTES + 1));
    });

    await expect(downloadMedia(MEDIA_ID)).rejects.toThrow('exceeds');
  });

  it('rejects upload when buffer exceeds the cap (no network call)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const tooBig = Buffer.alloc(MAX_MEDIA_BYTES + 1);

    await expect(uploadMedia(tooBig, 'image/jpeg')).rejects.toThrow('exceeds');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('uploadMedia type normalization', () => {
  async function captureUpload(mimeType: string): Promise<FormData> {
    let captured: FormData | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      captured = init?.body as FormData;
      return Promise.resolve(new Response(JSON.stringify({ id: 'media-xyz' }), { status: 200 }));
    });
    await uploadMedia(Buffer.from('img'), mimeType);
    if (!captured) throw new Error('no form captured');
    return captured;
  }

  it('falls back to image/jpeg + .jpg for application/octet-stream', async () => {
    const form = await captureUpload('application/octet-stream');
    expect(form.get('type')).toBe('image/jpeg');
    const file = form.get('file') as File;
    expect(file.name).toBe('upload.jpg');
  });

  it('strips charset suffix and keeps png', async () => {
    const form = await captureUpload('image/png; charset=binary');
    expect(form.get('type')).toBe('image/png');
    const file = form.get('file') as File;
    expect(file.name).toBe('upload.png');
  });

  it('normalizes Telegram voice audio to WhatsApp ogg upload', async () => {
    const form = await captureUpload('audio/opus');
    expect(form.get('type')).toBe('audio/ogg');
    const file = form.get('file') as File;
    expect(file.name).toBe('upload.ogg');
  });
});

describe('sendTemplate', () => {
  it('sends an image header + body params and returns the wamid', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return Promise.resolve(new Response(JSON.stringify({ messages: [{ id: 'wamid.123' }] }), { status: 200 }));
    });

    const result = await sendTemplate('573001112233', 'tour_followup_decide_v1', 'es_CO', ['2 dias / 1 noche', '17 de noviembre'], 'https://cdn.example.com/plan.jpg');

    expect(result.whatsappMessageId).toBe('wamid.123');
    expect(capturedBody).toMatchObject({
      messaging_product: 'whatsapp',
      to: '573001112233',
      type: 'template',
      template: {
        name: 'tour_followup_decide_v1',
        language: { code: 'es_CO' },
      },
    });
    const components = (capturedBody!.template as { components: Array<{ type: string; parameters: unknown[] }> }).components;
    expect(components[0]).toEqual({ type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.example.com/plan.jpg' } }] });
    expect(components[1]).toEqual({
      type: 'body',
      parameters: [{ type: 'text', text: '2 dias / 1 noche' }, { type: 'text', text: '17 de noviembre' }],
    });
  });

  it('omits the header component when no image is supplied (single-variable band)', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return Promise.resolve(new Response(JSON.stringify({ messages: [{ id: 'wamid.456' }] }), { status: 200 }));
    });

    await sendTemplate('573001112233', 'tour_followup_explore_v1', 'es_CO', ['17 de noviembre']);

    const components = (capturedBody!.template as { components: Array<{ type: string }> }).components;
    expect(components).toHaveLength(1);
    expect(components[0].type).toBe('body');
  });

  it('throws a retryable WhatsAppSendError on HTTP 5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));

    await expect(sendTemplate('573001112233', 'tour_followup_decide_v1', 'es_CO', ['a', 'b']))
      .rejects.toMatchObject({ retryable: true });
  });

  it('throws a non-retryable WhatsAppSendError on HTTP 400 (e.g. unapproved template)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 400 }));

    const err = await sendTemplate('573001112233', 'tour_followup_decide_v1', 'es_CO', ['a', 'b']).catch(e => e);
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect(err.retryable).toBe(false);
  });

  it('treats a malformed success response as delivery-uncertain', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ messages: [] }), { status: 200 }));

    await expect(sendTemplate('573001112233', 'tour_followup_decide_v1', 'es_CO', ['a', 'b']))
      .rejects.toMatchObject({ deliveryUncertain: true });
  });
});

describe('sendText', () => {
  it('returns the wamid on a normal success response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.text' }] }), { status: 200 }));

    await expect(sendText('573001112233', 'hola')).resolves.toEqual({ whatsappMessageId: 'wamid.text' });
  });

  // Every customer reply goes through sendText: a 2xx with an unexpected body must
  // not turn a delivered message into a thrown error for ordinary reply paths.
  it('does not fail an ordinary send when the success body carries no id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ messages: [] }), { status: 200 }));

    await expect(sendText('573001112233', 'hola')).resolves.toEqual({ whatsappMessageId: null });
  });

  it('throws delivery-uncertain from sendTextWithId when no id is returned', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ messages: [] }), { status: 200 }));

    await expect(sendTextWithId('573001112233', 'hola'))
      .rejects.toMatchObject({ deliveryUncertain: true });
  });

  it('propagates HTTP failures unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));

    await expect(sendText('573001112233', 'hola')).rejects.toMatchObject({ retryable: true });
  });

  // A bare "HTTP 403" is undiagnosable: 190 (expired token), 368 (policy block) and
  // 131030 (recipient not allowlisted on a test number) all surface the same status.
  it('surfaces the Meta error code on a failed send', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'Permissions error', code: 200, error_subcode: 2534061 } }),
      { status: 403 },
    ));

    const err = await sendText('573001112233', 'hola').catch(e => e);
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect(err.metaCode).toBe('200:2534061');
    expect(err.message).toContain('meta 200:2534061');
    expect(err.retryable).toBe(false);
  });
});
