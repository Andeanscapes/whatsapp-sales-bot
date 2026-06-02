import { timingSafeEqual } from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { Repositories } from '../db/repositories/index.js';
import { getAllCommands, getCommand, registerCommand, type CommandContext } from '../commands/index.js';
import { reportHandler } from '../commands/report.command.js';
import { leadsHandler } from '../commands/leads.command.js';
import { recentHandler } from '../commands/recent.command.js';
import { customerHandler } from '../commands/customer.command.js';
import { sendHandler } from '../commands/send.command.js';
import { phasesHandler } from '../commands/phases.command.js';
import { blockHandler } from '../commands/block.command.js';
import { pauseHandler } from '../commands/pause.command.js';
import { resumeHandler } from '../commands/resume.command.js';

const ALERT_FETCH_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 5_000;

function telegramApiUrl(path: string): string {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}${path}`;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
}

export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  parseMode?: string,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const body: Record<string, unknown> = { chat_id: String(chatId), text };
  if (parseMode) body.parse_mode = parseMode;

  const response = await fetch(telegramApiUrl('/sendMessage'), {
    method: 'POST',
    signal: AbortSignal.timeout(ALERT_FETCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed: ${response.status} ${errBody}`);
  }
}

function parseCommand(text: string): { command: string; args: string[] } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(@[a-zA-Z0-9_]+)?(?:\s+(.*))?$/s);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const rest = match[3] ?? '';
  const args = rest.length > 0 ? rest.split(/\s+/) : [];

  return { command, args };
}

async function processUpdate(update: TelegramUpdate, repos: Repositories): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.text || !msg.from) return;

  const chatIdStr = String(msg.chat.id);
  if (chatIdStr !== env.TELEGRAM_CHAT_ID) return;

  const parsed = parseCommand(msg.text);
  if (!parsed) return;

  const cmd = getCommand(parsed.command);
  if (!cmd) {
    await sendTelegramMessage(msg.chat.id, 'Comando no reconocido. Usa /help para ver la lista.');
    return;
  }

  if (cmd.requiresSecret) {
    if (parsed.args.length < 1) {
      await sendTelegramMessage(msg.chat.id, 'Token de administrador requerido.');
      return;
    }
    const providedSecret = parsed.args[parsed.args.length - 1];
    const expectedBuf = Buffer.from(env.ADMIN_SECRET);
    const providedBuf = Buffer.from(providedSecret);
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      await sendTelegramMessage(msg.chat.id, 'Token de administrador invalido.');
      return;
    }
    parsed.args.pop();
  }

  const ctx: CommandContext = {
    repos,
    args: parsed.args,
    chatId: msg.chat.id,
  };

  try {
    const reply = await cmd.handler(ctx);
    await sendTelegramMessage(msg.chat.id, reply, 'Markdown');
  } catch (err) {
    logger.error({ err, command: parsed.command }, '[TELEGRAM_BOT] command handler failed');
    await sendTelegramMessage(msg.chat.id, 'Error procesando el comando.');
  }
}

function registerCommands(): void {
  registerCommand({
    name: 'report',
    description: 'Reporte diario de estadisticas',
    usage: '',
    handler: reportHandler,
  });

  registerCommand({
    name: 'leads',
    description: 'Top hot leads',
    usage: '[n]',
    handler: leadsHandler,
  });

  registerCommand({
    name: 'recent',
    description: 'Actividad reciente',
    usage: '[n]',
    handler: recentHandler,
  });

  registerCommand({
    name: 'customer',
    description: 'Perfil completo de cliente',
    usage: '<telefono> <secret>',
    requiresSecret: true,
    handler: customerHandler,
  });

  registerCommand({
    name: 'send',
    description: 'Enviar WhatsApp a cliente',
    usage: '<telefono> <mensaje> <secret>',
    requiresSecret: true,
    handler: sendHandler,
  });

  registerCommand({
    name: 'phases',
    description: 'Pipeline por fase de ventas',
    usage: '',
    handler: phasesHandler,
  });

  registerCommand({
    name: 'block',
    description: 'Bloquear numero (opt-out)',
    usage: '<telefono> <secret>',
    requiresSecret: true,
    handler: blockHandler,
  });

  registerCommand({
    name: 'pause',
    description: 'Pausar respuestas del bot a clientes',
    usage: '<secret>',
    requiresSecret: true,
    handler: pauseHandler,
  });

  registerCommand({
    name: 'resume',
    description: 'Reactivar respuestas del bot',
    usage: '<secret>',
    requiresSecret: true,
    handler: resumeHandler,
  });

  registerCommand({
    name: 'help',
    description: 'Lista de comandos disponibles',
    usage: '',
    handler: async () => {
      const commands = getAllCommands();
      const lines = ['*Comandos disponibles:*', ''];
      for (const c of commands) {
        const label = c.usage ? `/${c.name} ${c.usage}` : `/${c.name}`;
        lines.push(`${label} — ${c.description}`);
      }
      return lines.join('\n');
    },
  });
}

export async function startTelegramBot(repos: Repositories): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    logger.info('[TELEGRAM_BOT] skipping — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    return;
  }

  registerCommands();

  let lastUpdateId = 0;

  try {
    const url = telegramApiUrl(`/getUpdates?offset=-1&limit=1&timeout=5`);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const data = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
      if (data.ok && data.result.length > 0) {
        lastUpdateId = data.result[0].update_id;
      }
    }
  } catch {
    // ignore — will start from 0
  }

  logger.info({ chatId: env.TELEGRAM_CHAT_ID }, '[TELEGRAM_BOT] polling started');

  const interval = setInterval(async () => {
    try {
      const url = telegramApiUrl(`/getUpdates?offset=${lastUpdateId + 1}&timeout=5`);
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return;

      const data = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
      if (!data.ok || !Array.isArray(data.result)) return;

      for (const update of data.result) {
        lastUpdateId = update.update_id;
        await processUpdate(update, repos);
      }
    } catch (err) {
      logger.error({ err }, '[TELEGRAM_BOT] poll error');
    }
  }, POLL_INTERVAL_MS);

  process.on('SIGTERM', () => clearInterval(interval));
  process.on('SIGINT', () => clearInterval(interval));
}
