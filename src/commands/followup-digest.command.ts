import {
  bogotaDayWindow,
  buildFollowupDigest,
  previousBogotaDayWindow,
  renderFollowupDigest,
} from '../services/followup-digest.js';
import type { CommandContext } from './index.js';

/**
 * On-demand follow-up digest, so the 08:00 report can be verified without waiting
 * for the trigger hour (and without the dev force flag, which fires once at boot).
 *
 * Read-only: `buildFollowupDigest` calls the same pure candidate queries the sender
 * uses, so running this can never dispatch anything.
 */
export async function followupDigestHandler(ctx: CommandContext): Promise<string> {
  const period = (ctx.args[0] ?? 'hoy').toLowerCase();
  if (period !== 'hoy' && period !== 'ayer') {
    return 'Uso: /followupdigest [hoy|ayer]';
  }

  const now = new Date();
  const window = period === 'ayer' ? previousBogotaDayWindow(now) : bogotaDayWindow(now);
  // `ayer` is therefore a retrospective: a finished day has nothing left to
  // schedule, so only its sent section carries information.
  return renderFollowupDigest(buildFollowupDigest(ctx.repos, window, now));
}
