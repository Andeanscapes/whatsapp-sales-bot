import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { isDynamicDataFresh } from './skill-loader.js';

const DIAG_TIMEOUT_MS = 10_000;
const OPS_MONITOR_MS = 15 * 60 * 1000;
const ONCE_COOLDOWN_MS = 60 * 60 * 1000;
const PLACEHOLDER_PUBLIC_BASE_URL = 'https://bot.yourdomain.com';

type OpsKind = 'whatsapp' | 'deepseek' | 'dynamic' | 'webhook' | 'system';
type ServiceStatus = 'OK' | 'ERROR' | 'deshabilitado' | 'no configurado';

interface WhatsAppApiHealth {
  phoneLookupOk: boolean;
  wabaLookupOk: boolean;
  configuredPhoneFound: boolean;
}

interface WhatsAppApiFailure {
  operation: string;
  status?: number;
}

interface ActiveIncident {
  detail: string;
}

const activeIncidents = new Map<OpsKind, ActiveIncident>();
const failureInFlight = new Set<OpsKind>();
const recoveryInFlight = new Set<OpsKind>();
const onceCooldownUntil = new Map<string, number>();

/**
 * Only infra/auth outages page the owner. Per-message client errors (400 bad
 * recipient, outside 24h window, invalid payload) are expected and must not flap
 * ERROR ↔ RECUPERADA alerts when other sends succeed.
 */
export function isOperationalWhatsAppFailure(status?: number): boolean {
  if (status === undefined) return true;
  if (status === 401 || status === 403 || status === 429) return true;
  if (status >= 500) return true;
  return false;
}

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
    // Dynamic import avoids load-time cycle:
    // operational-health → telegram-bot → commands → response-engine → deepseek → operational-health
    const { sendTelegramMessage } = await import('./telegram-bot.js');
    await sendTelegramMessage(env.TELEGRAM_CHAT_ID, message);
    return true;
  } catch (err) {
    logger.warn({ err }, '[OPS] Telegram operational notification failed');
    return false;
  }
}

async function openIncident(kind: OpsKind, message: string, detail: string): Promise<void> {
  if (activeIncidents.has(kind) || failureInFlight.has(kind)) return;
  failureInFlight.add(kind);
  try {
    const delivered = await sendOwnerOperationalMessage(message);
    if (delivered) activeIncidents.set(kind, { detail });
  } finally {
    failureInFlight.delete(kind);
  }
}

async function closeIncident(kind: OpsKind, message: string): Promise<void> {
  if (!activeIncidents.has(kind) || recoveryInFlight.has(kind)) return;
  recoveryInFlight.add(kind);
  try {
    const delivered = await sendOwnerOperationalMessage(message);
    if (delivered) activeIncidents.delete(kind);
  } finally {
    recoveryInFlight.delete(kind);
  }
}

async function reportOnce(key: string, message: string): Promise<void> {
  const until = onceCooldownUntil.get(key) ?? 0;
  if (Date.now() < until) return;
  // Reserve slot immediately so concurrent callers do not double-send.
  onceCooldownUntil.set(key, Date.now() + ONCE_COOLDOWN_MS);
  const delivered = await sendOwnerOperationalMessage(message);
  if (!delivered) onceCooldownUntil.delete(key);
}

export async function reportWhatsAppApiFailure(failure: WhatsAppApiFailure): Promise<void> {
  if (!isOperationalWhatsAppFailure(failure.status)) {
    logger.info(
      { status: failure.status, operation: failure.operation },
      '[OPS] WhatsApp client error ignored for owner alert',
    );
    return;
  }
  await openIncident(
    'whatsapp',
    [
      '❌ WhatsApp API ERROR',
      `Estado: ${failureLabel(failure)}`,
      `Operacion: ${failure.operation}`,
      'Mensajes al cliente pueden no estar siendo enviados. Revisa el token y Meta Business Suite.',
    ].join('\n'),
    failure.operation,
  );
}

export async function reportWhatsAppApiSuccess(): Promise<void> {
  const current = activeIncidents.get('whatsapp');
  if (!current) return;
  await closeIncident(
    'whatsapp',
    [
      '✅ WhatsApp API RECUPERADA',
      `Operacion confirmada: ${current.detail}`,
      'Meta acepto una nueva solicitud del bot.',
    ].join('\n'),
  );
}

export async function reportDeepSeekFailure(detail: string): Promise<void> {
  if (!env.AI_ENABLED) return;
  await openIncident(
    'deepseek',
    [
      '❌ DeepSeek LLM ERROR',
      `Detalle: ${detail}`,
      'El bot usara respuestas de respaldo hasta que la API responda de nuevo.',
    ].join('\n'),
    detail,
  );
}

export async function reportDeepSeekSuccess(): Promise<void> {
  await closeIncident(
    'deepseek',
    [
      '✅ DeepSeek LLM RECUPERADO',
      'La API de DeepSeek acepto una nueva solicitud.',
    ].join('\n'),
  );
}

export async function reportAiBudgetBlocked(reason: string): Promise<void> {
  // AI intentionally off is a config choice, not a budget incident — never page.
  if (reason === 'ai_disabled') return;
  const day = new Date().toISOString().slice(0, 10);
  await reportOnce(
    `budget:${day}`,
    [
      '💰 AI budget agotado',
      `Motivo: ${reason}`,
      `Dia: ${day}`,
      'El bot usara respuestas de respaldo. Revisa DAILY/MONTHLY_AI_BUDGET_USD y limites de llamadas.',
    ].join('\n'),
  );
}

export async function reportCriticalSystemError(type: string, message: string): Promise<void> {
  const safeType = type.slice(0, 80);
  const safeMessage = message.slice(0, 300);
  await reportOnce(
    `system:${safeType}`,
    [
      '🚨 Error critico del sistema',
      `Tipo: ${safeType}`,
      `Detalle: ${safeMessage}`,
      'Revisa logs del bot / system_errors en SQLite.',
    ].join('\n'),
  );
}

async function reportDynamicDataFailure(): Promise<void> {
  await openIncident(
    'dynamic',
    [
      '❌ Datos dinamicos ERROR',
      'No se pudo refrescar precios/disponibilidad desde DYNAMIC_SKILL_URL.',
      'Consultas de precio/fecha pediran confirmacion al equipo.',
    ].join('\n'),
    'dynamic_stale',
  );
}

async function reportDynamicDataRecovery(): Promise<void> {
  await closeIncident(
    'dynamic',
    [
      '✅ Datos dinamicos RECUPERADOS',
      'El JSON dinamico volvio a estar disponible.',
    ].join('\n'),
  );
}

async function reportWebhookFailure(): Promise<void> {
  await openIncident(
    'webhook',
    [
      '❌ Webhook publico ERROR',
      `URL: ${env.PUBLIC_BASE_URL}/health`,
      'El tunnel o DNS puede estar caido. Meta no podra entregar webhooks.',
    ].join('\n'),
    'webhook_down',
  );
}

async function reportWebhookRecovery(): Promise<void> {
  await closeIncident(
    'webhook',
    [
      '✅ Webhook publico RECUPERADO',
      `${env.PUBLIC_BASE_URL}/health responde OK.`,
    ].join('\n'),
  );
}

export async function checkWhatsAppApiHealth(): Promise<WhatsAppApiHealth> {
  const phoneUrl = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,code_verification_status`;
  let phoneLookupOk = false;
  try {
    const response = await fetch(phoneUrl, {
      signal: AbortSignal.timeout(DIAG_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(DIAG_TIMEOUT_MS),
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

export async function checkDeepSeekHealth(): Promise<ServiceStatus> {
  if (!env.AI_ENABLED) return 'deshabilitado';
  try {
    const response = await fetch(`${env.DEEPSEEK_BASE_URL}/models`, {
      signal: AbortSignal.timeout(DIAG_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    });
    logger[response.ok ? 'info' : 'error'](
      { status: response.status },
      response.ok ? '[DIAG] DeepSeek API valid' : '[DIAG] DeepSeek API FAILED',
    );
    return response.ok ? 'OK' : 'ERROR';
  } catch (err) {
    logger.error({ err }, '[DIAG] DeepSeek API unreachable');
    return 'ERROR';
  }
}

export async function checkTelegramApiHealth(): Promise<ServiceStatus> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return 'no configurado';
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(DIAG_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.error({ status: response.status }, '[DIAG] Telegram getMe FAILED');
      return 'ERROR';
    }
    const body = await response.json() as { ok?: boolean };
    const ok = body.ok === true;
    logger[ok ? 'info' : 'error']({ ok }, ok ? '[DIAG] Telegram API valid' : '[DIAG] Telegram getMe invalid body');
    return ok ? 'OK' : 'ERROR';
  } catch (err) {
    logger.error({ err }, '[DIAG] Telegram API unreachable');
    return 'ERROR';
  }
}

export async function checkPublicWebhookHealth(): Promise<ServiceStatus> {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (!base || base === PLACEHOLDER_PUBLIC_BASE_URL) return 'no configurado';
  try {
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(DIAG_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.error({ status: response.status, base }, '[DIAG] public webhook /health FAILED');
      return 'ERROR';
    }
    const body = await response.json() as { ok?: boolean };
    const ok = body.ok === true;
    logger[ok ? 'info' : 'error']({ base, ok }, ok ? '[DIAG] public webhook reachable' : '[DIAG] public webhook invalid body');
    return ok ? 'OK' : 'ERROR';
  } catch (err) {
    logger.error({ err, base }, '[DIAG] public webhook unreachable (tunnel/DNS?)');
    return 'ERROR';
  }
}

function dynamicDataStatus(available: boolean): ServiceStatus {
  if (!env.DYNAMIC_SKILL_URL) return 'no configurado';
  return available ? 'OK' : 'ERROR';
}

function isCriticalOk(status: ServiceStatus): boolean {
  return status === 'OK' || status === 'deshabilitado' || status === 'no configurado';
}

function statusIcon(status: ServiceStatus): string {
  if (status === 'OK') return '✅';
  if (status === 'ERROR') return '❌';
  if (status === 'deshabilitado') return '⏸️';
  return '⚪';
}

function formatStatusLine(label: string, status: ServiceStatus, detail?: string): string {
  const text = detail ?? status;
  return `${statusIcon(status)} ${label}: ${text}`;
}

export async function sendStartupStatus(params: { whatsapp: WhatsAppApiHealth; dynamicDataAvailable: boolean }): Promise<void> {
  const whatsappOk = params.whatsapp.phoneLookupOk
    && params.whatsapp.wabaLookupOk
    && params.whatsapp.configuredPhoneFound;
  const whatsappStatus: ServiceStatus = whatsappOk ? 'OK' : 'ERROR';

  const [deepseek, telegram, webhook] = await Promise.all([
    checkDeepSeekHealth(),
    checkTelegramApiHealth(),
    checkPublicWebhookHealth(),
  ]);
  const dynamic = dynamicDataStatus(params.dynamicDataAvailable);

  const healthy = whatsappOk
    && isCriticalOk(deepseek)
    && isCriticalOk(telegram)
    && isCriticalOk(dynamic)
    && isCriticalOk(webhook);

  const whatsappDetail = whatsappOk ? 'OK' : 'ERROR - revisar token, WABA o numero configurado';
  const delivered = await sendOwnerOperationalMessage([
    healthy ? '🚀 Bot iniciado correctamente' : '⚠️ Bot iniciado con alertas',
    `📦 Version: ${env.APP_VERSION}`,
    `🌐 Entorno: ${env.NODE_ENV}`,
    '',
    formatStatusLine('WhatsApp API', whatsappStatus, whatsappDetail),
    formatStatusLine('DeepSeek LLM', deepseek),
    formatStatusLine('Datos dinamicos', dynamic),
    formatStatusLine('Telegram API', telegram),
    formatStatusLine('Webhook publico (tunnel)', webhook),
  ].join('\n'));

  // Seed incidents after a degraded boot so the first runtime signal does not double-alert.
  if (delivered) {
    const degraded: Array<[OpsKind, boolean]> = [
      ['whatsapp', !whatsappOk],
      ['deepseek', deepseek === 'ERROR'],
      ['dynamic', dynamic === 'ERROR'],
      ['webhook', webhook === 'ERROR'],
    ];
    for (const [kind, isDegraded] of degraded) {
      if (isDegraded && !activeIncidents.has(kind)) {
        activeIncidents.set(kind, { detail: 'chequeo de arranque' });
      }
    }
  }
}

/** Periodic runtime probe for services that may die without a customer message. */
export async function runPeriodicOperationalChecks(): Promise<void> {
  if (env.AI_ENABLED) {
    const deepseek = await checkDeepSeekHealth();
    if (deepseek === 'ERROR') {
      await reportDeepSeekFailure('chequeo periodico /models');
    } else if (deepseek === 'OK') {
      await reportDeepSeekSuccess();
    }
  }

  if (env.DYNAMIC_SKILL_URL) {
    if (isDynamicDataFresh()) {
      await reportDynamicDataRecovery();
    } else {
      await reportDynamicDataFailure();
    }
  }

  const webhook = await checkPublicWebhookHealth();
  if (webhook === 'ERROR') {
    await reportWebhookFailure();
  } else if (webhook === 'OK') {
    await reportWebhookRecovery();
  }
}

export function startOperationalHealthMonitor(): ReturnType<typeof setInterval> | undefined {
  if (env.NODE_ENV !== 'production' && !env.STARTUP_DIAGNOSTICS_ENABLED) {
    return undefined;
  }
  logger.info({ everyMs: OPS_MONITOR_MS }, '[OPS] periodic health monitor started');
  return setInterval(() => {
    void runPeriodicOperationalChecks();
  }, OPS_MONITOR_MS);
}

export function resetWhatsAppOperationalHealth(): void {
  activeIncidents.clear();
  failureInFlight.clear();
  recoveryInFlight.clear();
  onceCooldownUntil.clear();
}
