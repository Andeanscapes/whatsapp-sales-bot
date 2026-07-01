import { env } from '../config/env.js';

export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function getReportExcludedPhones(): string[] {
  return env.REPORT_EXCLUDED_PHONES
    .split(',')
    .map(p => normalizePhone(p.trim()))
    .filter(Boolean);
}

export function isReportExcludedPhone(phone: string): boolean {
  const normalized = normalizePhone(phone);
  return getReportExcludedPhones().includes(normalized);
}
