import { processMessage } from '../services/response-engine.js';
import { sendText } from '../services/whatsapp-client.js';
import { isWithinServiceWindow } from '../services/time-window-policy.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import type { CommandContext } from './index.js';

const usage = 'Uso: /retryflow <telefono>';

export async function retryflowHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0]?.replace(/\D/g, '');
  if (!phone) return usage;

  if (!isWithinServiceWindow(ctx.repos, phone)) return bridgeMessages.serviceWindowClosed;

  const lastInbound = ctx.repos.message.getLastInboundBody(phone);
  if (!lastInbound) return `No hay mensaje entrante para ${phone}`;

  // Idempotency guard: only replay when the customer's last message has no bot
  // reply after it. Once a reply is stored, a second /retryflow is rejected so
  // score, handoff and AI spend are never applied twice for the same turn.
  if (ctx.repos.message.getLastMessageDirection(phone) !== 'inbound') {
    return `El ultimo mensaje de ${phone} ya tuvo respuesta. Reenvio cancelado para evitar duplicar el flujo.`;
  }

  const result = await processMessage({
    repos: ctx.repos,
    customerPhone: phone,
    message: lastInbound,
    storeInbound: false,
  });

  if (!result.shouldSendReply) return `Bot no genero respuesta para ${phone}`;

  await sendText(phone, result.reply);
  ctx.repos.message.addMessage({
    customer_phone: phone,
    direction: 'outbound',
    message_type: 'text',
    body: result.reply,
    created_at: new Date().toISOString(),
  });

  return `Reenviado a flujo bot para ${phone}`;
}
