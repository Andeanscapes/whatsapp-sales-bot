import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, statSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Guard against committing a real Colombian mobile number.
 *
 * The operator's own number (which is also the Nequi payment channel) was committed
 * in six files — ironically including the payment-leak guard tests, whose assertions
 * work identically with a placeholder. `secretlint`'s recommended preset has no rule
 * for a national-format phone number, so nothing caught it.
 *
 * The convention this enforces: every fake CO mobile in the repo uses the `300`
 * operator prefix. Real numbers in use start with other prefixes (`319`, `310`, `320`…),
 * so a non-`300` prefix is the signal. This is deliberately a repo-shape rule rather
 * than a secret scanner: a bare 10-digit match flags timestamps, ids and the
 * placeholders themselves, which is why the `@secretlint` pattern rule was rejected.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Prefix reserved for fixtures and documentation. */
const PLACEHOLDER_PREFIX = '300';

/** Binary or vendored content where a digit run carries no phone meaning. */
const SKIPPED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.woff', '.woff2', '.ttf', '.eot', '.zip', '.gz', '.sqlite',
]);

const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

/** Optional `57` country code, then a 10-digit mobile starting with 3. */
const CO_MOBILE = /(?<![0-9])(?:57)?(3[0-9]{2})[0-9]{7}(?![0-9])/g;

function trackedFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf-8' });
  return output.split('\0').filter(entry => entry !== '');
}

describe('no real phone numbers in tracked files', () => {
  it('every Colombian mobile uses the placeholder prefix', () => {
    const offenders: string[] = [];
    let scannedFiles = 0;
    let matches = 0;

    for (const relativePath of trackedFiles()) {
      if (SKIPPED_EXTENSIONS.has(extname(relativePath).toLowerCase())) continue;

      const absolutePath = join(ROOT, relativePath);
      let contents: string;
      try {
        if (statSync(absolutePath).size > MAX_SCANNED_BYTES) continue;
        contents = readFileSync(absolutePath, 'utf-8');
      } catch {
        // Deleted-but-still-indexed or unreadable: not this guard's business.
        continue;
      }
      scannedFiles += 1;

      const lines = contents.split('\n');
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(CO_MOBILE)) {
          matches += 1;
          if (match[1] === PLACEHOLDER_PREFIX) continue;
          // Report the location and the prefix only — never the full number.
          offenders.push(`${relativePath}:${index + 1} (prefix ${match[1]}…)`);
        }
      }
    }

    // Sanity check on the guard itself: a regex that matches nothing, or a file
    // walk that reads nothing, would make this test pass vacuously.
    expect(scannedFiles).toBeGreaterThan(50);
    expect(matches).toBeGreaterThan(0);

    expect(
      offenders,
      `Non-placeholder Colombian mobile found. Use the ${PLACEHOLDER_PREFIX} prefix (e.g. ${PLACEHOLDER_PREFIX}9900001) in fixtures and docs.`,
    ).toEqual([]);
  });
});
