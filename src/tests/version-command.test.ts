import { describe, expect, it } from 'vitest';
import { versionHandler } from '../commands/version.command.js';
import type { CommandContext } from '../commands/index.js';

describe('version command', () => {
  it('returns Telegram Markdown-safe output', async () => {
    const reply = await versionHandler({} as CommandContext);

    expect(reply).toMatch(/^App version: /);
    expect(reply).not.toContain('_');
  });
});
