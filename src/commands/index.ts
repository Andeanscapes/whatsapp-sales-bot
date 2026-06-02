import type { Repositories } from '../db/repositories/index.js';

export interface CommandContext {
  repos: Repositories;
  args: string[];
  chatId: number;
}

export interface BotCommand {
  name: string;
  description: string;
  usage?: string;
  requiresSecret?: boolean;
  handler: (ctx: CommandContext) => Promise<string>;
}

const registry = new Map<string, BotCommand>();

export function registerCommand(cmd: BotCommand): void {
  registry.set(cmd.name, cmd);
}

export function getCommand(name: string): BotCommand | undefined {
  return registry.get(name);
}

export function getAllCommands(): BotCommand[] {
  return Array.from(registry.values());
}
