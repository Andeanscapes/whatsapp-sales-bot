/** Digits-only phone normalization shared by Telegram command handlers. */
export function normalizeCommandPhone(value: string | undefined): string | null {
  if (!value) return null;
  const phone = value.replace(/[^0-9]/g, '');
  return phone.length >= 8 ? phone : null;
}
