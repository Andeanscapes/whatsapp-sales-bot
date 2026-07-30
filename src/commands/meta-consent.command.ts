import type { MetaAudienceConsentSource } from '../db/repositories/types.js';
import type { CommandContext } from './index.js';

const SOURCES: readonly MetaAudienceConsentSource[] = [
  'whatsapp_explicit_opt_in',
  'booking_checkout_opt_in',
  'documented_lawful_basis',
];

export async function metaConsentHandler(ctx: CommandContext): Promise<string> {
  const phone = ctx.args[0]?.replace(/[^0-9]/g, '') ?? '';
  const source = ctx.args[1];
  if (phone.length < 8 || !SOURCES.includes(source as MetaAudienceConsentSource)) {
    return `Uso: /metaconsent <telefono> <${SOURCES.join('|')}>`;
  }

  ctx.repos.conversation.recordMetaAudienceConsent(phone, source as MetaAudienceConsentSource);
  return `Consentimiento Meta registrado para ${phone}: ${source}.`;
}
