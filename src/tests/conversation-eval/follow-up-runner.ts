import { env } from '../../config/env.js';
import { runFollowUps } from '../../services/follow-up-service.js';
import type { ProcessMessageOutput } from '../../services/response-engine.js';
import type { Scenario } from './schema.js';
import type { RunContext, TurnRecord } from './runner.js';

function output(reply: string, shouldSendReply = true): ProcessMessageOutput {
  return {
    reply,
    shouldSendReply,
    leadScore: 0,
    usedAi: shouldSendReply,
    shouldAlertOwner: false,
    shouldSendImage: false,
    shouldSendOwnerImage: false,
    shouldSendGalleryImages: false,
    priceJustGiven: false,
  };
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export async function runFollowUpScenario(ctx: RunContext, scenario: Scenario): Promise<TurnRecord[]> {
  const now = Date.now();
  const previousHours = env.TIME_FOLLOW_HOURS;
  const previousAiEnabled = env.AI_ENABLED;
  const originalFetch = globalThis.fetch;
  const turns: TurnRecord[] = [];

  ctx.repos.conversation.upsert(ctx.customerPhone, { language: scenario.lang });
  for (let index = 0; index < scenario.turns.length; index++) {
    const turn = scenario.turns[index];
    const inboundAt = new Date(now - (5 * 60 * 60 * 1000) + index * 60_000).toISOString();
    const outboundAt = new Date(now - (4 * 60 * 60 * 1000) + index * 60_000).toISOString();
    ctx.repos.message.addMessage({ customer_phone: ctx.customerPhone, direction: 'inbound', message_type: 'text', body: turn.user, created_at: inboundAt });
    ctx.repos.message.addMessage({ customer_phone: ctx.customerPhone, direction: 'outbound', message_type: 'text', body: turn.mockReply, created_at: outboundAt });
    turns.push({ turnNumber: index + 1, user: turn.user, reply: turn.mockReply, processOutput: output(turn.mockReply) });
  }

  const seededLastReply = scenario.turns.at(-1)?.mockReply ?? '';
  globalThis.fetch = async (input, init) => {
    if (urlOf(input).includes('graph.facebook.com')) {
      return new Response(JSON.stringify({ messages: [{ id: 'eval-follow-up' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };

  env.TIME_FOLLOW_HOURS = 3;
  env.AI_ENABLED = true;
  try {
    await runFollowUps(ctx.repos);
  } finally {
    globalThis.fetch = originalFetch;
    env.TIME_FOLLOW_HOURS = previousHours;
    env.AI_ENABLED = previousAiEnabled;
  }

  const latestReply = ctx.repos.message.getLastOutboundBody(ctx.customerPhone) ?? '';
  const followUpReply = latestReply === seededLastReply ? '' : latestReply;
  turns.push({
    turnNumber: turns.length + 1,
    user: '[automated follow-up]',
    reply: followUpReply,
    processOutput: output(followUpReply, followUpReply.length > 0),
  });
  return turns;
}
