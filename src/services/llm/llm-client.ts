import { z } from 'zod';

const salesPhaseSchema = z.enum([
  'greeting', 'discovery', 'value', 'pricing', 'objection', 'closing',
]);

const actionSchema = z.enum([
  'answer', 'qualify', 'present_price', 'compare_plans', 'close', 'handoff',
]);

const leadIntentSchema = z.enum([
  'curious', 'comparing', 'qualifying', 'ready_to_book', 'objecting', 'cold',
]);

const collectedFieldsSchema = z.object({
  name: z.string().nullable().catch(null),
  plan: z.enum(['2d1n_mining', '3d2n_rural']).nullable().catch(null),
  people: z.number().int().nullable().catch(null),
  date: z.string().nullable().catch(null),
  transport_need: z.enum(['own', 'from_bogota', 'public_bus']).nullable().catch(null),
  pet: z.enum(['yes']).nullable().catch(null),
}).catch(() => ({ name: null, plan: null, people: null, date: null, transport_need: null, pet: null }));

const leadSchema = z.object({
  intent: leadIntentSchema.catch('curious'),
  buying_signals: z.array(z.string()).catch([]),
  blockers: z.array(z.string()).catch([]),
  score_delta: z.number().int().min(-10).max(40).catch(0),
  confidence: z.number().min(0).max(1).catch(0.5),
}).catch(() => ({
  intent: 'curious' as const,
  buying_signals: [] as string[],
  blockers: [] as string[],
  score_delta: 0,
  confidence: 0.5,
}));

export const llmTurnSchema = z.object({
  reply: z.string(),
  sales_phase: salesPhaseSchema.catch('discovery'),
  action: actionSchema.catch('answer'),
  collected_fields: collectedFieldsSchema,
  lead: leadSchema,
  img: z.boolean().catch(false),
});

export type LlmTurn = z.infer<typeof llmTurnSchema>;

export interface LlmResult {
  turn: LlmTurn;
  tokens: { prompt: number; completion: number };
}

export interface LlmAttempt {
  tokens: { prompt: number; completion: number };
  success: boolean;
}

export interface LlmClientInput {
  systemPrompt: string;
  /** Optional task-specific instructions appended to the system prompt (e.g. follow-up tone). */
  systemPromptSuffix?: string;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  lang?: 'es' | 'en';
  onAttempt?: (attempt: LlmAttempt) => void;
}

export interface LlmClient {
  complete(input: LlmClientInput): Promise<LlmResult | null>;
}
