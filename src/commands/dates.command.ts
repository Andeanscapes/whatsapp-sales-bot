import { bridgeMessages } from '../services/bridge-messages.js';
import { listFutureDates, type OperatorDate } from '../services/operator-catalog.js';
import { loadOperatorCatalog, md, resolveSiteOrError, siteTitle } from './operator-views.js';
import type { CommandContext } from './index.js';

const MAX_DATE_LINES_PER_SITE = 60;

function dateLine(item: OperatorDate): string {
  const status = bridgeMessages.operatorDateStatus[item.status] ?? item.status;
  const parts = [item.date, status];
  if (item.slots !== null) parts.push(bridgeMessages.operatorDateSlots(item.slots));
  return md(parts.join(' · '));
}

export async function datesHandler(ctx: CommandContext): Promise<string> {
  const view = await loadOperatorCatalog();
  if (!view) return bridgeMessages.operatorCatalogUnavailable;

  const query = ctx.args.join(' ').trim();
  let targets = view.sites;
  if (query) {
    const site = resolveSiteOrError(view.sites, query);
    if (typeof site === 'string') return site;
    targets = [site];
  }

  const blocks = targets.map(site => {
    const title = bridgeMessages.operatorDatesTitle(siteTitle(site));
    const dates = listFutureDates(site.site);
    if (dates.length === 0) return `${title}\n${bridgeMessages.operatorNoDates(md(site.name))}`;
    const shown = dates.slice(0, MAX_DATE_LINES_PER_SITE).map(dateLine);
    if (dates.length > shown.length) shown.push(bridgeMessages.operatorMoreDates(dates.length - shown.length));
    return `${title}\n${shown.join('\n')}`;
  });

  return [...(view.stale ? [bridgeMessages.operatorCatalogStale] : []), ...blocks].join('\n\n');
}
