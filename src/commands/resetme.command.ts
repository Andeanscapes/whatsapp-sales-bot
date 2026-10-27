import { env } from '../config/env.js';
import { bridgeMessages } from '../services/bridge-messages.js';
import { normalizeCommandPhone } from './phone.js';
import type { CommandContext } from './index.js';

export async function resetmeHandler(ctx: CommandContext): Promise<string> {
  const phone = normalizeCommandPhone(env.OWNER_PERSONAL_WHATSAPP_NUMBER);
  if (!phone) return bridgeMessages.resetmeMissingNumber;

  const deleted = ctx.repos.customerData.deleteCustomer(phone);
  return bridgeMessages.deleteDone({ phone, ...deleted });
}
