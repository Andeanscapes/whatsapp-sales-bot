import type { AssembleSystemPromptInput } from './skills-prompt-assembly.js';
import { assembleSystemPrompt } from './skills-prompt-assembly.js';

/** System prompt = skills assembly (sales MD + catalog protocol + CATALOGO + DATOS). */
export function buildSystemPrompt(input: AssembleSystemPromptInput): string {
  return assembleSystemPrompt(input);
}
