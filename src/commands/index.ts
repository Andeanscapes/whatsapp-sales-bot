import type { Repositories } from '../db/repositories/index.js';

export type OutputBlock =
  | { kind: 'text'; text: string; parseMode?: string }
  | { kind: 'photoUrl'; url: string; caption?: string }
  | { kind: 'photoBuffer'; buffer: Buffer; mimeType: string; caption?: string }
  | { kind: 'document'; buffer: Buffer; filename: string; caption?: string };

export interface CommandContext {
  repos: Repositories;
  args: string[];
  chatId: number;
  emit?: (block: OutputBlock) => void;
}

export interface BotCommand {
  name: string;
  description: string;
  usage?: string;
  ownerOnly?: boolean;
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
