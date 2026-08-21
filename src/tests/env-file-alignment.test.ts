import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { envSchema } from '../config/env.js';

/**
 * Drift guard for the untracked env files.
 *
 * `.env.dev` and `.env.prod` are gitignored (`.gitignore`: `.env.*`), so they have no
 * version history and a silently deleted switch is invisible to code review. That is
 * exactly how `ALLOW_FOLLOWUP_TEMPLATE` went missing from BOTH files: the stage defaulted
 * to `false` and the one-shot post-24h template never ran in dev or prod, with no error.
 *
 * `.env.example` is the tracked source of truth for the key SET. Values legitimately
 * differ per environment; the key set must not.
 *
 * Each file is skipped when absent, so CI (which has neither) stays green. That also means
 * these assertions are LOCAL-ONLY: they protect a developer running `npm test`, not the CI
 * runner. Run them before a release. Only `the tracked template` case below runs everywhere.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLE = join(ROOT, '.env.example');

function parseEnvFile(path: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of readFileSync(path, 'utf-8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return entries;
}

describe('env file alignment', () => {
  const example = parseEnvFile(EXAMPLE);
  const followupKeys = [...example.keys()].filter(key => key.startsWith('FOLLOWUP_') || key === 'ALLOW_FOLLOWUP_TEMPLATE');
  // Keys that are infra-only, not in the app schema (e.g., Cloudflare tunnel token).
  const infraOnlyAllowlist = new Set(['CLOUDFLARE_TUNNEL_TOKEN']);

  it('the tracked template declares every follow-up switch', () => {
    // Sanity check on the guard itself: if .env.example stopped listing these, the
    // per-file assertions below would pass vacuously.
    expect(followupKeys).toEqual(expect.arrayContaining([
      'ALLOW_FOLLOWUP_TEMPLATE',
      'FOLLOWUP_CONSENT_ASK_ENABLED',
      'FOLLOWUP_RECURRING_ENABLED',
      'FOLLOWUP_HOURS_AFTER_INBOUND',
      'FOLLOWUP_CONSENT_HOURS_AFTER_INBOUND',
      'FOLLOWUP_RECURRING_INTERVAL_MONTHS',
      'FOLLOWUP_RECURRING_MIN_SILENCE_HOURS',
      'FOLLOWUP_MAX_RECURRING_SENDS',
      'FOLLOWUP_TEMPLATE_NAME',
      'FOLLOWUP_RECURRING_TEMPLATE_NAME',
    ]));
  });

  for (const fileName of ['.env.dev', '.env.prod']) {
    const path = join(ROOT, fileName);

    describe(fileName, () => {
      it.runIf(existsSync(path))('declares every key from .env.example (except infra-only)', () => {
        const actual = parseEnvFile(path);
        const exampleKeys = [...example.keys()].filter(key => !infraOnlyAllowlist.has(key));
        const missing = exampleKeys.filter(key => !actual.has(key));
        expect(missing, `${fileName} is missing keys that .env.example declares`).toEqual([]);
      });

      it.runIf(existsSync(path))('declares no key that .env.example does not (except infra-only)', () => {
        const actual = parseEnvFile(path);
        const unknown = [...actual.keys()]
          .filter(key => !infraOnlyAllowlist.has(key))
          .filter(key => !example.has(key));
        expect(unknown, `${fileName} declares keys absent from .env.example`).toEqual([]);
      });
    });
  }

  const prodPath = join(ROOT, '.env.prod');

  it.runIf(existsSync(prodPath))('.env.prod passes the production schema', () => {
    const parsed = parseEnvFile(prodPath);
    // The dev accelerators and the recurring-template requirement are enforced by
    // `envSchema`'s superRefine; parsing the real file is what proves the deployed
    // combination actually boots instead of failing on the box.
    const result = envSchema.safeParse(Object.fromEntries(parsed));
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 1)).toBe(true);
  });

  it.runIf(existsSync(prodPath))('.env.prod keeps the production follow-up timing rules', () => {
    const env = envSchema.parse(Object.fromEntries(parseEnvFile(prodPath)));

    // Real timings: no accelerator may survive a copy from .env.dev.
    expect(env.FOLLOWUP_DEV_MINUTES).toBe(0);
    expect(env.FOLLOWUP_DEV_CONSENT_SECONDS).toBe(0);
    expect(env.FOLLOWUP_DEV_RECURRING_SECONDS).toBe(0);
    expect(env.FOLLOWUP_DEV_RECURRING_MIN_SILENCE_SECONDS).toBe(0);
    expect(env.FOLLOWUP_DEV_ALLOWLIST_PHONES.trim()).toBe('');

    // One-shot: outside Meta's free-form window, and far enough from the consent ask
    // that the two are not two touches in the same day. Asserted as a floor rather
    // than the exact business value, which is a config choice (currently one week).
    expect(env.FOLLOWUP_HOURS_AFTER_INBOUND).toBeGreaterThanOrEqual(24);
    expect(env.FOLLOWUP_HOURS_AFTER_INBOUND)
      .toBeGreaterThan(env.FOLLOWUP_CONSENT_HOURS_AFTER_INBOUND);
    expect(env.FOLLOWUP_CONSENT_HOURS_AFTER_INBOUND).toBeLessThanOrEqual(23);

    // Recurring: first gap of one month, then the ×3 exponential (1, 3, 9, 27…).
    expect(env.FOLLOWUP_RECURRING_INTERVAL_MONTHS).toBe(1);
    expect(env.FOLLOWUP_RECURRING_MIN_SILENCE_HOURS).toBeGreaterThanOrEqual(24);

    // A required image header with no resolvable image skips every send, so an enabled
    // template must name a template.
    if (env.ALLOW_FOLLOWUP_TEMPLATE) expect(env.FOLLOWUP_TEMPLATE_NAME.trim()).not.toBe('');
    if (env.FOLLOWUP_RECURRING_ENABLED) expect(env.FOLLOWUP_RECURRING_TEMPLATE_NAME.trim()).not.toBe('');
  });
});
