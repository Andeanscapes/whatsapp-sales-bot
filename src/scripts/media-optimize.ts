/**
 * Convert photos in `r2-cache/whatsapp_bot/media/` to WhatsApp-ready `.jpg`
 * without uploading anything. `media:sync` and `media:push` run this first.
 *
 *   npm run media:optimize
 *   npm run media:optimize -- --dry-run
 *
 * Sources (.heic, .jpeg, .tiff, .webp) are kept; `media:sync` deletes them once
 * their `.jpg` is confirmed on R2.
 */

import { optimizeMediaCache, reportOptimize } from './lib/optimize-media.js';

const failed = reportOptimize(await optimizeMediaCache({ dryRun: process.argv.includes('--dry-run') }), 'media:optimize');
if (failed > 0) process.exit(1);
