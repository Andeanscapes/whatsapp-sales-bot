import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sendTelegramMessage } from './telegram-bot.js';

interface WhatsAppApiHealth {
  phoneLookupOk: boolean;
  wabaLookupOk: boolean;
  configuredPhoneFound: boolean;
}

interface WhatsAppApiFailure {
  operation: string;
  status?: number;
}

let activeIncident: WhatsAppApiFailure | null = null;
let failureNotifyInFlight = false;
let recoveryNotifyInFlight = false;

function failureLabel(failure: WhatsAppApiFailure): string {
  if (failure.status === 401 || failure.status === 403) return 'autorizacion rechazada';
  if (failure.status === 429) return 'limite de API alcanzado';
  if (failure.status && failure.status >= 500) return 'error temporal de Meta';
  return failure.status ? `HTTP ${failure.status}` : 'conexion con Meta fallida';
}

async function sendOwnerOperationalMessage(message: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    logger.warn('[OPS] Telegram owner chat unavailable; operational notification not sent');
    return false;
  }

  try {
    await sendTelegramMessage(env.TELEGRAM_CHAT_ID, message);
    return true;
  } catch (err) {
    logger.warn({ err }, '[OPS] Telegram operational notification failed');
    return false;
  }
}

export async function reportWhatsAppApiFailure(failure: WhatsAppApiFailure): Promise<void> {
  if (activeIncident || failureNotifyInFlight) return;
  failureNotifyInFlight = true;
  try {
    const delivered = await sendOwnerOperationalMessage([
      'WhatsApp API ERROR',
      `Estado: ${failureLabel(failure)}`,
      `Operacion: ${failure.operation}`,
      'Mensajes al cliente pueden no estar siendo enviados. Revisa el token y Meta Business Suite.',
    ].join('\n'));
    if (delivered) activeIncident = failure;
  } finally {
    failureNotifyInFlight = false;
  }
}

export async function reportWhatsAppApiSuccess(): Promise<void> {
  if (!activeIncident || recoveryNotifyInFlight) return;
  const resolved = activeIncident;
  recoveryNotifyInFlight = true;
  try {
    const delivered = await sendOwnerOperationalMessage([
      'WhatsApp API RECUPERADA',
      `Operacion confirmada: ${resolved.operation}`,
      'Meta acepto una nueva solicitud del bot.',
    ].join('\n'));
    if (delivered) activeIncident = null;
  } finally {
    recoveryNotifyInFlight = false;
  }
}

export async function checkWhatsAppApiHealth(): Promise<WhatsAppApiHealth> {
  const phoneUrl = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,code_verification_status`;
  let phoneLookupOk = false;
  try {
    const response = await fetch(phoneUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    });
    phoneLookupOk = response.ok;
    logger[response.ok ? 'info' : 'error'](
      { status: response.status, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID },
      response.ok ? '[DIAG] WhatsApp phone number valid' : '[DIAG] WhatsApp phone number lookup FAILED',
    );
  } catch (err) {
    logger.error({ err, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID }, '[DIAG] WhatsApp API unreachable');
  }

  const wabaUrl = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_BUSINESS_ACCOUNT_ID}/phone_numbers?fields=id`;
  let wabaLookupOk = false;
  let configuredPhoneFound = false;
  try {
    const response = await fetch(wabaUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
    });
    wabaLookupOk = response.ok;
    if (response.ok) {
      const body = await response.json() as { data?: Array<{ id?: string }> };
      configuredPhoneFound = (body.data ?? []).some(phone => phone.id === env.WHATSAPP_PHONE_NUMBER_ID);
    }
    logger[response.ok ? 'info' : 'error'](
      { status: response.status, businessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID, configuredPhoneFound },
      response.ok ? '[DIAG] WhatsApp WABA phone list valid' : '[DIAG] WhatsApp WABA phone list FAILED',
    );
  } catch (err) {
    logger.error({ err, businessAccountId: env.WHATSAPP_BUSINESS_ACCOUNT_ID }, '[DIAG] WhatsApp WABA lookup unreachable');
  }

  return { phoneLookupOk, wabaLookupOk, configuredPhoneFound };
}

export async function sendStartupStatus(params: { whatsapp: WhatsAppApiHealth; dynamicDataAvailable: boolean }): Promise<void> {
  const whatsappOk = params.whatsapp.phoneLookupOk
    && params.whatsapp.wabaLookupOk
    && params.whatsapp.configuredPhoneFound;
  const status = whatsappOk ? 'OK' : 'ERROR - revisar token, WABA o numero configurado';
  const delivered = await sendOwnerOperationalMessage([
    whatsappOk ? 'Bot iniciado correctamente' : 'Bot iniciado con alertas',
    `Version: ${env.APP_VERSION}`,
    `WhatsApp API: ${status}`,
    `Datos dinamicos: ${params.dynamicDataAvailable ? 'OK' : 'no disponibles'}`,
  ].join('\n'));

  // Seed incident after a degraded boot so the first customer send does not double-alert.
  if (delivered && !whatsappOk && !activeIncident) {
    activeIncident = { operation: 'chequeo de arranque', status: params.whatsapp.phoneLookupOk ? undefined : 401 };
  }
}

export function resetWhatsAppOperationalHealth(): void {
  activeIncident = null;
  failureNotifyInFlight = false;
  recoveryNotifyInFlight = false;
}
