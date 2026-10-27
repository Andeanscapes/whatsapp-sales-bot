import { bridgeMessages } from '../services/bridge-messages.js';
import { listPlanCards, type OperatorPlanCard, type OperatorSite } from '../services/operator-catalog.js';
import { formatCop } from '../services/pricing-calculator.js';
import { deliverOperatorPhoto, loadOperatorCatalog, md, resolveSiteOrError, siteNames, siteTitle } from './operator-views.js';
import type { CommandContext } from './index.js';

function formatPrice(value: number | null): string {
  return value === null ? bridgeMessages.operatorNoPrice : `$${formatCop(value)} COP`;
}

/** Photo caption: sent without parse_mode, so it stays unescaped. */
function planCaption(plan: OperatorPlanCard, site: OperatorSite): string {
  const title = plan.tier ? `${plan.name} (${plan.tier})` : plan.name;
  return [
    title,
    bridgeMessages.operatorPlanIndividual(formatPrice(plan.individual)),
    bridgeMessages.operatorPlanCouple(formatPrice(plan.couple)),
    plan.active ? null : bridgeMessages.operatorPlanInactive,
    site.active ? null : bridgeMessages.operatorSitePaused,
  ].filter((line): line is string => line !== null).join('\n');
}

export async function plansHandler(ctx: CommandContext): Promise<string> {
  const view = await loadOperatorCatalog();
  if (!view) return bridgeMessages.operatorCatalogUnavailable;

  const query = ctx.args.join(' ').trim();
  if (!query) return `${bridgeMessages.plansUsage}\n${bridgeMessages.operatorSitesList(siteNames(view.sites))}`;

  const site = resolveSiteOrError(view.sites, query);
  if (typeof site === 'string') return site;

  const lines: string[] = [bridgeMessages.operatorPlansTitle(siteTitle(site))];
  if (view.stale) lines.push(bridgeMessages.operatorCatalogStale);

  for (const plan of listPlanCards(site.site)) {
    if (!plan.card) {
      lines.push(bridgeMessages.operatorNoCard(md(plan.name)));
      continue;
    }
    const textFallback = deliverOperatorPhoto(ctx, plan.card.url, planCaption(plan, site));
    if (textFallback) lines.push(`${md(plan.name)}: ${textFallback}`);
  }
  return lines.join('\n');
}
