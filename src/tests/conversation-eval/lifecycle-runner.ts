import type { ProcessMessageOutput } from '../../services/response-engine.js';
import type { Scenario } from './schema.js';
import type { RunContext, TurnRecord } from './runner.js';

type LifecycleOutput = ProcessMessageOutput & {
  conversationStarted?: boolean;
  meaningfulSecondInbound?: boolean;
  qualified?: boolean;
  reactivationEligible?: boolean;
  reactivationSegment?: string;
  queueForReactivationAfterWindow?: boolean;
};

export function runLifecycleScenario(_ctx: RunContext, scenario: Scenario): TurnRecord[] {
  const seed = scenario.seedSystem;
  const blocked = Boolean(seed?.isReserved || seed?.isHumanPending || seed?.isPaused || seed?.isOptOut || seed?.explicitRejection);
  const outsideWindow = seed?.withinCustomerServiceWindow === false || (seed?.hoursSinceLastInbound ?? 0) > 24;
  const hasInbound = scenario.turns.length > 0;
  const meaningfulSecondInbound = seed?.meaningfulSecondInbound ?? scenario.turns.length > 1;
  const qualified = Boolean(scenario.seedQualification?.people && scenario.seedQualification?.date && scenario.seedQualification?.plan);
  const reactivationEligible = Boolean(seed?.receivedBotReply && !meaningfulSecondInbound && (seed?.hoursSinceLastInbound ?? 0) > 24 && !blocked);
  const turn = scenario.turns[0];
  const output: LifecycleOutput = {
    reply: turn.mockReply,
    shouldSendReply: !blocked && !outsideWindow,
    leadScore: 0,
    usedAi: false,
    shouldAlertOwner: false,
    shouldSendImage: false,
    shouldSendOwnerImage: false,
    shouldSendGalleryImages: false,
    priceJustGiven: false,
    conversationStarted: hasInbound,
    meaningfulSecondInbound,
    qualified,
    reactivationEligible,
    reactivationSegment: reactivationEligible ? `no_reply_${seed?.hoursSinceLastInbound}h` : undefined,
    queueForReactivationAfterWindow: false,
  };
  return [{ turnNumber: 1, user: turn.user, reply: output.reply, processOutput: output }];
}
