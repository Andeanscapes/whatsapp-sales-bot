import { sendText } from '../services/whatsapp-client.js';
import type { CommandContext } from './index.js';

export async function sendHandler(ctx: CommandContext): Promise<string> {
  const args = ctx.args;
  if (args.length < 2) return 'Uso: /send <telefono> <mensaje>';

  const phone = args[0];
  const message = args.slice(1).join(' ');

  try {
    await sendText(phone, message);
    return `✅ Mensaje enviado a ${phone}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `❌ Error al enviar: ${msg}`;
  }
}
