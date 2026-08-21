import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { reportWhatsAppApiFailure, reportWhatsAppApiSuccess } from './whatsapp-operational-health.js';
import { z } from 'zod';

const WHATSAPP_FETCH_TIMEOUT_MS = 10_000;
/** Binary media transfers (download/upload) need more headroom than JSON message calls. */
const WHATSAPP_MEDIA_TIMEOUT_MS = 30_000;

export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly deliveryUncertain: boolean,
    readonly retryable = false,
    readonly metaCode?: string,
  ) {
    super(message);
    this.name = 'WhatsAppSendError';
  }
}

interface MetaErrorBody {
  error?: {
    code?: number;
    error_subcode?: number;
    message?: string;
  };
}

function extractMetaErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as MetaErrorBody;
    const { error } = parsed;
    if (!error) return undefined;
    if (error.error_subcode != null) return `${error.code ?? '?'}:${error.error_subcode}`;
    return error.code != null ? String(error.code) : undefined;
  } catch {
    return undefined;
  }
}

/** WhatsApp rejects image captions longer than this, so a long reply must be sent as text. */
export const MAX_IMAGE_CAPTION_CHARS = 1024;

/** WhatsApp Cloud API image limit is 5MB; cap inbound downloads to protect memory. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
/** WhatsApp Cloud API video limit is 16MB. */
export const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
/** WhatsApp Cloud API audio limit is 16MB; cap outbound voice-note uploads. */
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

/**
 * Hosts allowed to receive the bearer token / serve WhatsApp media. The media id
 * metadata returns a signed URL whose host we must verify before attaching the
 * access token, so a spoofed/redirected response can never exfiltrate the secret.
 */
const ALLOWED_MEDIA_HOSTS = ['fbcdn.net', 'fbsbx.com', 'facebook.com', 'cdninstagram.com'];

function isAllowedMediaHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_MEDIA_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

/** Reads a fetch body into a Buffer, rejecting payloads over the provided cap. */
async function readCappedBuffer(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new Error(`Media exceeds ${maxBytes} bytes (declared ${declared})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Media exceeds ${maxBytes} bytes (actual ${buffer.byteLength})`);
  }
  return buffer;
}

export interface TemplateSendResult {
  whatsappMessageId: string;
}

export interface TextSendResult {
  /**
   * `null` when Meta answered 2xx with an unexpected body. The message may still
   * have been delivered, so callers must not retry on the strength of a null id.
   */
  whatsappMessageId: string | null;
}

const templateResponseSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).min(1),
});

/**
 * Sends an approved Meta message template. This is the only outbound path
 * allowed outside the 24h customer service window (see
 * docs/skills-architecture.md — the LLM never composes this text; the
 * template body is fixed and Meta-approved, only `bodyParams` and
 * `headerImageUrl` are filled deterministically by the caller).
 */
export async function sendTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[],
  headerImageUrl?: string,
): Promise<TemplateSendResult> {
  const url = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const components: Record<string, unknown>[] = [];
  if (headerImageUrl) {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] });
  }
  if (bodyParams.length > 0) {
    components.push({ type: 'body', parameters: bodyParams.map(text => ({ type: 'text', text })) });
  }

  logger.info({ to, templateName, languageCode }, '[WHATSAPP] sending template');
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(WHATSAPP_FETCH_TIMEOUT_MS),
      headers: {
        'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      }),
    });
  } catch (error) {
    void reportWhatsAppApiFailure({ operation: 'envio de plantilla' });
    throw new WhatsAppSendError(error instanceof Error ? error.message : 'WhatsApp transport failed', true);
  }
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    logger.warn({ status: response.status, templateName, errBody: errBody.slice(0, 500) }, '[WHATSAPP] template send failed');
    void reportWhatsAppApiFailure({ operation: 'envio de plantilla', status: response.status });
    const retryable = response.status === 429 || response.status >= 500;
    const metaCode = extractMetaErrorCode(errBody);
    throw new WhatsAppSendError(
      metaCode ? `WhatsApp API error: HTTP ${response.status} (meta ${metaCode})` : `WhatsApp API error: HTTP ${response.status}`,
      false,
      retryable,
      metaCode,
    );
  }
  void reportWhatsAppApiSuccess();
  const parsed = templateResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    void reportWhatsAppApiFailure({ operation: 'respuesta de plantilla invalida' });
    throw new WhatsAppSendError('WhatsApp template response was invalid', true);
  }
  const whatsappMessageId = parsed.data.messages[0].id;
  logger.info({ to, templateName, whatsappMessageId }, '[WHATSAPP] template sent ok');
  return { whatsappMessageId };
}

/**
 * Sends a free-form text. Allowed ONLY inside the 24h customer service window.
 *
 * Exposes the Meta message id for callers that need provenance, but an
 * unparsable 2xx body is NOT an error here: every customer reply, alert and
 * bridge message goes through this function, and they must not start failing
 * over a response-shape change. Callers that require the id use
 * `sendTextWithId()`.
 */
export async function sendText(to: string, text: string): Promise<TextSendResult> {
  const url = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  logger.info({ to, textLen: text.length }, '[WHATSAPP] sending text');
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(WHATSAPP_FETCH_TIMEOUT_MS),
      headers: {
        'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text, preview_url: true },
      }),
    });
  } catch (error) {
    void reportWhatsAppApiFailure({ operation: 'envio de texto' });
    throw new WhatsAppSendError(error instanceof Error ? error.message : 'WhatsApp transport failed', true);
  }
  if (!response.ok) {
    // Meta's error code is the only way to tell an expired token (190) from a
    // policy block (368) from a recipient-not-allowlisted test number (131030).
    // Without it a 403 is undiagnosable, so log the body like sendTemplate does.
    const errBody = await response.text().catch(() => '');
    const metaCode = extractMetaErrorCode(errBody);
    logger.warn(
      { status: response.status, to, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, metaCode, errBody: errBody.slice(0, 500) },
      '[WHATSAPP] text send failed',
    );
    void reportWhatsAppApiFailure({ operation: 'envio de texto', status: response.status });
    const retryable = response.status === 429 || response.status >= 500;
    throw new WhatsAppSendError(
      metaCode ? `WhatsApp API error: HTTP ${response.status} (meta ${metaCode})` : `WhatsApp API error: HTTP ${response.status}`,
      false,
      retryable,
      metaCode,
    );
  }
  void reportWhatsAppApiSuccess();
  // Reuses the template response shape: Meta returns the same `messages[0].id`.
  const parsed = templateResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    // 2xx: Meta accepted the message. Report the missing id without failing the
    // send, and never fabricate one.
    logger.warn({ to }, '[WHATSAPP] text sent but response carried no message id');
    return { whatsappMessageId: null };
  }
  const whatsappMessageId = parsed.data.messages[0].id;
  logger.info({ to, whatsappMessageId }, '[WHATSAPP] text sent ok');
  return { whatsappMessageId };
}

/**
 * Strict variant for callers that must persist which outbound carried a message
 * (currently the follow-up consent ask, whose reply has to be attributable).
 *
 * A 2xx without an id is reported as `deliveryUncertain`: Meta may hold the
 * message, so the caller must record it as terminal and never retry.
 */
export async function sendTextWithId(to: string, text: string): Promise<{ whatsappMessageId: string }> {
  const { whatsappMessageId } = await sendText(to, text);
  if (!whatsappMessageId) {
    throw new WhatsAppSendError('WhatsApp text response carried no message id', true);
  }
  return { whatsappMessageId };
}

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Downloads inbound WhatsApp media. The Graph API requires two steps: resolve the
 * media id to a short-lived signed URL, then fetch the binary with the bearer token.
 */
export async function downloadMedia(mediaId: string): Promise<DownloadedMedia> {
  const metaUrl = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${mediaId}`;
  const metaRes = await fetch(metaUrl, {
    signal: AbortSignal.timeout(WHATSAPP_FETCH_TIMEOUT_MS),
    headers: { 'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!metaRes.ok) {
    logger.warn({ status: metaRes.status }, '[WHATSAPP] media metadata fetch failed');
    void reportWhatsAppApiFailure({ operation: 'consulta de media', status: metaRes.status });
    throw new Error(`WhatsApp media metadata error: HTTP ${metaRes.status}`);
  }
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!meta.url) throw new Error('WhatsApp media metadata missing url');
  if (!isAllowedMediaHost(meta.url)) {
    logger.warn({ host: (() => { try { return new URL(meta.url!).hostname; } catch { return 'invalid'; } })() }, '[WHATSAPP] media url host not allowlisted');
    throw new Error('WhatsApp media url host not allowed');
  }

  const binRes = await fetch(meta.url, {
    signal: AbortSignal.timeout(WHATSAPP_MEDIA_TIMEOUT_MS),
    headers: { 'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!binRes.ok) {
    logger.warn({ status: binRes.status }, '[WHATSAPP] media binary fetch failed');
    void reportWhatsAppApiFailure({ operation: 'descarga de media', status: binRes.status });
    throw new Error(`WhatsApp media binary error: HTTP ${binRes.status}`);
  }
  const mimeType = meta.mime_type ?? binRes.headers.get('content-type') ?? 'application/octet-stream';
  const kind = normalizeMediaType(mimeType).kind;
  const maxBytes = kind === 'audio' ? MAX_AUDIO_BYTES : kind === 'video' ? MAX_VIDEO_BYTES : MAX_MEDIA_BYTES;
  const buffer = await readCappedBuffer(binRes, maxBytes);
  void reportWhatsAppApiSuccess();
  return { buffer, mimeType };
}

/**
 * Sends an image by public URL with an optional caption.
 *
 * Like `sendText`, an unparsable 2xx body is NOT an error here: this is the main
 * customer reply path (plan card, contextual photo) and it must not start failing
 * over a response-shape change. Callers that require the id use
 * `sendImageUrlWithId()`.
 */
export async function sendImageUrl(to: string, imageUrl: string, caption: string): Promise<TextSendResult> {
  const url = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  logger.info({ to, captionLen: caption.length, imageUrl: imageUrl.slice(0, 80) }, '[WHATSAPP] sending image');
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(WHATSAPP_FETCH_TIMEOUT_MS),
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: imageUrl, caption },
    }),
  });
  if (!response.ok) {
    logger.warn({ status: response.status }, '[WHATSAPP] image send failed');
    void reportWhatsAppApiFailure({ operation: 'envio de imagen', status: response.status });
    throw new Error(`WhatsApp API error: HTTP ${response.status}`);
  }
  void reportWhatsAppApiSuccess();
  // Reuses the template response shape: Meta returns the same `messages[0].id`.
  const parsed = templateResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    logger.warn({ to }, '[WHATSAPP] image sent but response carried no message id');
    return { whatsappMessageId: null };
  }
  logger.info({ to, whatsappMessageId: parsed.data.messages[0].id }, '[WHATSAPP] image sent ok');
  return { whatsappMessageId: parsed.data.messages[0].id };
}

/**
 * Strict variant for callers that must persist which outbound carried a message
 * (the follow-up consent ask, whose reply has to be attributable even when the
 * ask is delivered as an image caption).
 *
 * A 2xx without an id is reported as `deliveryUncertain`: Meta may hold the
 * message, so the caller must record it as terminal and never retry.
 */
export async function sendImageUrlWithId(to: string, imageUrl: string, caption: string): Promise<{ whatsappMessageId: string }> {
  const { whatsappMessageId } = await sendImageUrl(to, imageUrl, caption);
  if (!whatsappMessageId) {
    throw new WhatsAppSendError('WhatsApp image response carried no message id', true);
  }
  return { whatsappMessageId };
}

export type MediaKind = 'image' | 'video' | 'audio';

/** WhatsApp-supported MIME types → { kind, normalized type, file extension }. */
const SUPPORTED_MEDIA_TYPES: Record<string, { kind: MediaKind; type: string; ext: string }> = {
  'image/jpeg': { kind: 'image', type: 'image/jpeg', ext: 'jpg' },
  'image/jpg': { kind: 'image', type: 'image/jpeg', ext: 'jpg' },
  'image/png': { kind: 'image', type: 'image/png', ext: 'png' },
  'video/mp4': { kind: 'video', type: 'video/mp4', ext: 'mp4' },
  'video/3gpp': { kind: 'video', type: 'video/3gpp', ext: '3gp' },
  'audio/ogg': { kind: 'audio', type: 'audio/ogg', ext: 'ogg' },
  'audio/opus': { kind: 'audio', type: 'audio/ogg', ext: 'ogg' },
  'audio/mpeg': { kind: 'audio', type: 'audio/mpeg', ext: 'mp3' },
  'audio/mp3': { kind: 'audio', type: 'audio/mpeg', ext: 'mp3' },
  'audio/mp4': { kind: 'audio', type: 'audio/mp4', ext: 'm4a' },
  'audio/aac': { kind: 'audio', type: 'audio/aac', ext: 'aac' },
  'audio/amr': { kind: 'audio', type: 'audio/amr', ext: 'amr' },
  'audio/webm': { kind: 'audio', type: 'audio/ogg', ext: 'ogg' },
};

/**
 * Normalizes an inbound MIME type to one WhatsApp accepts on upload. Telegram can
 * return `application/octet-stream` or a `; charset` suffix, which the Graph
 * `/media` endpoint rejects with HTTP 400. A `video/*` hint maps to mp4; anything
 * else defaults to JPEG.
 */
function normalizeMediaType(mimeType: string): { kind: MediaKind; type: string; ext: string } {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  const match = SUPPORTED_MEDIA_TYPES[base];
  if (match) return match;
  if (base.startsWith('video/')) return { kind: 'video', type: 'video/mp4', ext: 'mp4' };
  if (base.startsWith('audio/') || base === 'application/ogg') return { kind: 'audio', type: 'audio/ogg', ext: 'ogg' };
  return { kind: 'image', type: 'image/jpeg', ext: 'jpg' };
}

export interface UploadedMedia {
  id: string;
  kind: MediaKind;
}

/**
 * Uploads binary media (image or video) to the WhatsApp account and returns the
 * media id + resolved kind. Required to relay an agent's media: WhatsApp cannot
 * pull from Telegram's token-protected file URL, so we upload bytes and send by id.
 */
export async function uploadMedia(file: Buffer, mimeType: string): Promise<UploadedMedia> {
  const { kind, type, ext } = normalizeMediaType(mimeType);
  const cap = kind === 'video' ? MAX_VIDEO_BYTES : kind === 'audio' ? MAX_AUDIO_BYTES : MAX_MEDIA_BYTES;
  if (file.byteLength > cap) {
    throw new Error(`Media exceeds ${cap} bytes (actual ${file.byteLength})`);
  }
  const url = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/media`;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', type);
  // WhatsApp validates the type partly from the filename; it must have a matching extension.
  form.append('file', new Blob([new Uint8Array(file)], { type }), `upload.${ext}`);

  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(WHATSAPP_MEDIA_TIMEOUT_MS),
    headers: { 'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    body: form,
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    logger.warn({ status: response.status, type, errBody: errBody.slice(0, 500) }, '[WHATSAPP] media upload failed');
    void reportWhatsAppApiFailure({ operation: 'carga de media', status: response.status });
    throw new Error(`WhatsApp media upload error: HTTP ${response.status}`);
  }
  void reportWhatsAppApiSuccess();
  const data = (await response.json()) as { id?: string };
  if (!data.id) throw new Error('WhatsApp media upload missing id');
  return { id: data.id, kind };
}

async function sendMediaById(to: string, kind: MediaKind, mediaId: string, caption?: string): Promise<void> {
  const url = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const media: { id: string; caption?: string } = { id: mediaId };
  if (caption && caption.length > 0) media.caption = caption;

  logger.info({ to, kind, mediaId }, '[WHATSAPP] sending media by id');
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(WHATSAPP_FETCH_TIMEOUT_MS),
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: kind, [kind]: media }),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    logger.warn({ status: response.status, kind, errBody: errBody.slice(0, 500) }, '[WHATSAPP] media (id) send failed');
    void reportWhatsAppApiFailure({ operation: `envio de ${kind}`, status: response.status });
    throw new Error(`WhatsApp API error: HTTP ${response.status}`);
  }
  void reportWhatsAppApiSuccess();
  logger.info({ to, kind }, '[WHATSAPP] media sent ok');
}

export async function sendImageId(to: string, mediaId: string, caption?: string): Promise<void> {
  return sendMediaById(to, 'image', mediaId, caption);
}

export async function sendVideoId(to: string, mediaId: string, caption?: string): Promise<void> {
  return sendMediaById(to, 'video', mediaId, caption);
}

export async function sendAudioId(to: string, mediaId: string): Promise<void> {
  return sendMediaById(to, 'audio', mediaId);
}
