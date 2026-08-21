import type { Repositories } from '../db/repositories/index.js';

export interface MetaAdReferral {
  ctwa_clid?: string;
  source_id?: string;
  source_type?: string;
  headline?: string;
}

export function formatAdReferral(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const referral = value as Record<string, unknown>;
    const details = [
      typeof referral.headline === 'string' && referral.headline ? `anuncio=${referral.headline.slice(0, 200)}` : null,
      typeof referral.source_type === 'string' && referral.source_type ? `tipo=${referral.source_type.slice(0, 100)}` : null,
      typeof referral.source_id === 'string' && referral.source_id ? `origen=${referral.source_id.slice(0, 100)}` : null,
    ].filter((item): item is string => item !== null);
    return details.length > 0 ? details.join(' | ') : null;
  } catch {
    return null;
  }
}

export function recordAdReferral(repos: Repositories, phone: string, referral: MetaAdReferral): void {
  if (Object.values(referral).every(value => value == null || value === '')) return;
  if (repos.conversation.getByPhone(phone)?.ad_referral_json) return;
  repos.conversation.upsert(phone, { ad_referral_json: JSON.stringify(referral) });
}
