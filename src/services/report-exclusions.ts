import { env } from '../config/env.js';

export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function getReportExcludedPhones(): string[] {
  const ownerPhone = normalizePhone(env.OWNER_PERSONAL_WHATSAPP_NUMBER);
  const configured = env.REPORT_EXCLUDED_PHONES
    .split(',')
    .map(p => normalizePhone(p.trim()))
    .filter(Boolean);
  const set = new Set(configured);
  set.add(ownerPhone);
  return [...set];
}

export function isReportExcludedPhone(phone: string): boolean {
  const normalized = normalizePhone(phone);
  return getReportExcludedPhones().includes(normalized);
}
