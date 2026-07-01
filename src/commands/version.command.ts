import { env } from '../config/env.js';
import type { CommandContext } from './index.js';

export async function versionHandler(_ctx: CommandContext): Promise<string> {
  return `App version: ${env.APP_VERSION}`;
}
