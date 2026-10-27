import { bridgeMessages } from '../services/bridge-messages.js';
import { listOperatorSites, resolveOperatorSite, type OperatorSite } from '../services/operator-catalog.js';
import { getOperatorCatalog, isDynamicDataFresh, refreshSkills } from '../services/skill-loader.js';
import type { CommandContext } from './index.js';

/** Telegram caption limit. */
export const OPERATOR_CAPTION_MAX = 1024;

export interface OperatorCatalogView {
  sites: OperatorSite[];
  stale: boolean;
}

/**
 * Handler text is sent with parse_mode Markdown, so any user arg or catalog value
 * (plan names, CDN paths with `_`) must be escaped or Telegram rejects the reply.
 * Same escape as lead-format/customer/daysummary.
 */
export function md(text: string): string {
  return text.replace(/([*_`[])/g, '\\$1');
}

export async function loadOperatorCatalog(): Promise<OperatorCatalogView | null> {
  await refreshSkills();
  const raw = getOperatorCatalog();
  if (!raw) return null;
  return { sites: listOperatorSites(raw), stale: !isDynamicDataFresh() };
}

/** Escaped, comma-separated site ids with the paused tag. */
export function siteNames(sites: OperatorSite[]): string {
  return sites
    .map(s => md(s.active ? s.id : `${s.id} ${bridgeMessages.operatorPausedTag}`))
    .join(', ');
}

/** Escaped site title with the paused tag. */
export function siteTitle(site: OperatorSite): string {
  return md(site.active ? site.name : `${site.name} ${bridgeMessages.operatorPausedTag}`);
}

/**
 * Emits a photo block when the command can render media; otherwise returns the
 * escaped url for the text reply. Captions are sent without parse_mode, so they
 * stay raw.
 */
export function deliverOperatorPhoto(ctx: CommandContext, url: string, caption?: string): string | null {
  if (!ctx.emit) return md(url);
  const trimmed = caption?.slice(0, OPERATOR_CAPTION_MAX);
  ctx.emit({ kind: 'photoUrl', url, caption: trimmed || undefined });
  return null;
}

export function resolveSiteOrError(sites: OperatorSite[], query: string): OperatorSite | string {
  return resolveOperatorSite(sites, query) ?? bridgeMessages.operatorSiteUnknown(md(query), siteNames(sites));
}
