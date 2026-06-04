import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadMedia, uploadMedia, MAX_AUDIO_BYTES, MAX_MEDIA_BYTES } from '../services/whatsapp-client.js';

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
