import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeTranscriptExport } from '../scripts/export-transcripts.js';

describe('writeTranscriptExport', () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it('restricts the export directory and transcript file permissions', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'transcript-export-'));
    const outputDir = join(tempRoot, 'exports');
    const outputPath = writeTranscriptExport(outputDir, ['{"customer":"573***233"}'], new Date('2026-07-21T12:00:00.000Z'));

    expect(statSync(outputDir).mode & 0o777).toBe(0o700);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
  });
});
