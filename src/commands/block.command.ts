import type { CommandContext } from './index.js';

export async function blockHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0];
  if (!phone) return 'Uso: /block <telefono>';

  const conv = ctx.repos.conversation.getByPhone(phone);
  if (conv && conv.opt_out_at) return `🔄 ${phone} ya estaba bloqueado.`;

  ctx.repos.optOut.setOptOut(phone);
  return `🚫 ${phone} bloqueado (opt-out).`;
}
