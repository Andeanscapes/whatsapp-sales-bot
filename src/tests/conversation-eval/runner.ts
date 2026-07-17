import Database from 'better-sqlite3';
import { migrate } from '../../db/migrate.js';
import { createRepositories } from '../../db/repositories/index.js';
import { processMessage } from '../../services/response-engine.js';
import type { ProcessMessageOutput, ProcessMessageInput } from '../../services/response-engine.js';
import type { Repositories } from '../../db/repositories/index.js';
import type { LlmResult, LlmTurn } from '../../services/llm/llm-client.js';
import type { LlmClientInput } from '../../services/llm/llm-client.js';
import type { ScenarioTurn } from './schema.js';
import { recordGalleryNudge } from '../../services/media-service.js';

export interface TurnRecord {
  turnNumber: number;
  user: string;
  reply: string;
  processOutput: ProcessMessageOutput;
}

export interface RunContext {
  repos: Repositories;
  db: Database.Database;
  customerPhone: string;
  turns: TurnRecord[];
  destroy: () => void;
}

export function defaultMockResult(reply: string, overrides?: Partial<LlmTurn>): LlmResult | null {
  if (!reply) return null;
  const turn: LlmTurn = {
    reply,
    sales_phase: overrides?.sales_phase ?? 'discovery',
    action: overrides?.action ?? 'answer',
    collected_fields: overrides?.collected_fields ?? {
      name: null, plan: null, people: null, date: null, transport_need: null, pet: null,
    },
    lead: overrides?.lead ?? {
      intent: 'curious', buying_signals: [], blockers: [], score_delta: 0, confidence: 0.5,
    },
    img: overrides?.img ?? false,
  };
  return { turn, tokens: { prompt: 100, completion: 20 } };
}

export type MockLlmFunction = (input: LlmClientInput) => Promise<LlmResult | null>;

export interface RunOptions {
  customerPhone?: string;
  phoneSuffix?: number;
}

export function createRunContext(options: RunOptions): RunContext {
  const db = new Database(':memory:');
  migrate(db);
  const repos = createRepositories(db);

  const phone = options.customerPhone ?? `57300${String(options.phoneSuffix ?? 0).padStart(7, '0')}`;

  return {
    repos,
    db,
    customerPhone: phone,
    turns: [],
    destroy: () => db.close(),
  };
}

export async function runTurn(
  ctx: RunContext,
  turnDef: ScenarioTurn,
  turnNumber: number,
): Promise<TurnRecord> {
  if (turnDef.seedPriceGiven) ctx.repos.conversation.setPriceGiven(ctx.customerPhone);
  if (turnDef.seedGalleryNudge) recordGalleryNudge(ctx.repos, ctx.customerPhone);
  if (turnDef.seedLeadScore !== undefined) ctx.repos.conversation.updateLeadScore(ctx.customerPhone, turnDef.seedLeadScore);
  if (turnDef.seedQualification) {
    ctx.repos.conversation.upsert(ctx.customerPhone, {
      collected_name: turnDef.seedQualification.name,
      collected_people: turnDef.seedQualification.people,
      collected_date: turnDef.seedQualification.date,
      collected_transport_need: turnDef.seedQualification.transport,
      collected_plan: turnDef.seedQualification.plan,
    });
  }
  const input: ProcessMessageInput = {
    repos: ctx.repos,
    customerPhone: ctx.customerPhone,
    message: turnDef.user.slice(0, 1500),
    messageId: `sim_${Date.now()}_${turnNumber}`,
  };

  const output = await processMessage(input);

  if (output.shouldSendReply && output.reply) {
    ctx.repos.message.addMessage({
      customer_phone: ctx.customerPhone,
      direction: 'outbound',
      message_type: 'text',
      body: output.reply,
      created_at: new Date().toISOString(),
    });
  }

  return {
    turnNumber,
    user: turnDef.user,
    reply: output.reply,
    processOutput: output,
  };
}
