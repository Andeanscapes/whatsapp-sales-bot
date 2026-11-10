import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadSkills } from '../services/skill-loader.js';
import { assembleSystemPrompt } from '../services/skills-prompt-assembly.js';

// Retired catalog values seen in old replies (export 2026-11-07). They must never come
// back through the catalog fixture, and the ad opener must never carry a price anchor.
const fixture = readFileSync(new URL('../../scripts/bot-dynamic.ci.json', import.meta.url), 'utf8');

describe('retired prices and the ad opener', () => {
  it('the catalog fixture carries no retired price, deposit or duration', () => {
    const catalog = JSON.parse(fixture) as {
      payments: { deposit: { value: number } };
      experiences: Record<string, { sites: Record<string, { plans: Record<string, { duration?: string; depositPercentage?: number; pricing?: { individual?: number; couple?: number } }> }> }>;
    };
    expect(catalog.payments.deposit.value).not.toBe(15);
    const plans = Object.values(catalog.experiences)
      .flatMap(experience => Object.values(experience.sites))
      .flatMap(site => Object.values(site.plans));
    for (const plan of plans) {
      expect(plan.duration).not.toMatch(/3D\/2N/i);
      expect(plan.depositPercentage ?? 25).not.toBe(15);
      expect([550_000, 670_000]).not.toContain(plan.pricing?.individual);
      expect(plan.pricing?.couple).not.toBe(1_000_000);
    }
  });

  it('the first-turn ad prompt has no "desde" anchor and no computed per-person price', () => {
    const prompt = assembleSystemPrompt({
      skills: loadSkills(),
      lang: 'es',
      entryMarker: { code: 'C01', temperature: 'cold' },
      entryOpeningTurn: true,
      adOpeningTurn: true,
      collectedFields: { site: 'chivor' },
    });
    const runtime = prompt.slice(prompt.indexOf('Language:'));
    expect(runtime).not.toMatch(/PRECIO DESDE|PRICE ANCHOR|desde \$|starting at \$/i);
    expect(runtime).not.toMatch(/370\.000/);
  });
});
