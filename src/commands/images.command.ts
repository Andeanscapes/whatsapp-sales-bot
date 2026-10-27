import { bridgeMessages } from '../services/bridge-messages.js';
import { listGalleryPhotos, listGalleryThemes, normalizeLabel, type OperatorPhoto, type OperatorSite } from '../services/operator-catalog.js';
import { deliverOperatorPhoto, loadOperatorCatalog, md, resolveSiteOrError } from './operator-views.js';
import type { CommandContext } from './index.js';

/** Keeps one command under the dispatcher's block cap (40) with room for text. */
const MAX_OPERATOR_PHOTOS = 20;

function themesLine(sites: OperatorSite[]): string {
  return sites
    .map(s => `${md(s.name)}: ${md(listGalleryThemes(s.site).join(', ')) || bridgeMessages.operatorNoThemes}`)
    .join('\n');
}

export async function imagesHandler(ctx: CommandContext): Promise<string> {
  const view = await loadOperatorCatalog();
  if (!view) return bridgeMessages.operatorCatalogUnavailable;

  const [themeArg, ...siteArgs] = ctx.args;
  if (!themeArg) return `${bridgeMessages.imagesUsage}\n${themesLine(view.sites)}`;

  const siteQuery = siteArgs.join(' ').trim();
  let targets = view.sites;
  if (siteQuery) {
    const site = resolveSiteOrError(view.sites, siteQuery);
    if (typeof site === 'string') return site;
    targets = [site];
  }

  const theme = normalizeLabel(themeArg);
  const bySite = targets
    .map(site => ({ site, photos: listGalleryPhotos(site.site, theme) }))
    .filter((group): group is { site: OperatorSite; photos: OperatorPhoto[] } => group.photos.length > 0);
  const totalMatches = bySite.reduce((sum, group) => sum + group.photos.length, 0);
  if (totalMatches === 0) return `${bridgeMessages.operatorNoPhotos(md(themeArg))}\n${themesLine(targets)}`;

  const lines: string[] = view.stale ? [bridgeMessages.operatorCatalogStale] : [];
  let shown = 0;
  for (const { site, photos } of bySite) {
    const batch = photos.slice(0, MAX_OPERATOR_PHOTOS - shown);
    if (batch.length === 0) break;
    // Only the last photo of a site is captioned: a captioned photo closes the
    // album run (planSendUnits), so captioning every photo would send them one by one.
    const label = `${site.name}${site.active ? '' : ` ${bridgeMessages.operatorPausedTag}`} · ${theme}`;
    batch.forEach((photo, index) => {
      const caption = index === batch.length - 1 ? label : undefined;
      const textFallback = deliverOperatorPhoto(ctx, photo.url, caption);
      if (textFallback) lines.push(textFallback);
    });
    shown += batch.length;
  }

  if (totalMatches > shown) lines.push(bridgeMessages.operatorPhotoLimit(shown, totalMatches));
  return lines.join('\n');
}
