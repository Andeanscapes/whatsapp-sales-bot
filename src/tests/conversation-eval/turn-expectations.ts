import type { EvaluationOutput, TurnRecord } from './runner.js';
import type { Scenario, ScenarioTurn } from './schema.js';

const DIRECT_KEYS = [
  'shouldSendReply', 'shouldAlertOwner', 'shouldSendImage', 'shouldSendOwnerImage',
  'shouldSendGalleryImages', 'usedAi', 'priceJustGiven', 'reservationReady',
  'salesPhase', 'intent', 'mediaPlanId', 'bookingIntent', 'handoffCreated',
  'leadLifecycle', 'suppressGenericFollowups', 'queueForReactivationAfterWindow',
  'reactivationEligible', 'reactivationSegment', 'conversationStarted',
  'meaningfulSecondInbound', 'qualified',
] as const;

function validateTurnExpectation(turn: ScenarioTurn, output: EvaluationOutput): string[] {
  const expected = turn.expect;
  if (!expected) return [];

  const errors: string[] = [];
  const expectedValues: Record<string, unknown> = { ...expected };
  const outputValues: Record<string, unknown> = { ...output };
  for (const key of DIRECT_KEYS) {
    if (expectedValues[key] !== undefined && outputValues[key] !== expectedValues[key]) {
      errors.push(`${key} expected=${String(expectedValues[key])} actual=${String(outputValues[key])}`);
    }
  }
  if (expected.sendOwnerImage !== undefined && output.shouldSendOwnerImage !== expected.sendOwnerImage) {
    errors.push(`shouldSendOwnerImage expected=${expected.sendOwnerImage} actual=${output.shouldSendOwnerImage}`);
  }
  if (expected.reply !== undefined && output.reply !== expected.reply) {
    errors.push(`reply expected=${JSON.stringify(expected.reply)} actual=${JSON.stringify(output.reply)}`);
  }
  for (const pattern of expected.replyMustContain ?? []) {
    if (!new RegExp(pattern, 'i').test(output.reply)) errors.push(`reply missing pattern=${pattern}`);
  }
  for (const pattern of expected.replyMustNotMatch ?? []) {
    if (new RegExp(pattern, 'i').test(output.reply)) errors.push(`reply matched forbidden pattern=${pattern}`);
  }
  return errors;
}

export function validateTurnExpectations(scenario: Scenario, turns: TurnRecord[]): string[] {
  return scenario.turns.flatMap((turn, index) => {
    const record = turns[index];
    if (!record) return [`[expect turn ${index + 1}] output missing`];
    return validateTurnExpectation(turn, record.processOutput)
      .map(error => `[expect turn ${index + 1}] ${error}`);
  });
}
