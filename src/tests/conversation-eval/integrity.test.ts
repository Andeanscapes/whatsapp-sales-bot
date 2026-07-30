import { describe, expect, it } from 'vitest';
import { partitionLiveScenarios } from './scenario-loader.js';
import { scenarioSchema } from './schema.js';
import { validateTurnExpectations } from './turn-expectations.js';
import type { TurnRecord } from './runner.js';

function scenario(runner: 'message' | 'follow_up' | 'lifecycle' = 'message') {
  return scenarioSchema.parse({
    id: `test-${runner}`,
    runner,
    turns: [{
      user: 'Fotos de la mina',
      mockReply: 'Claro',
      expect: {
        shouldSendGalleryImages: true,
        replyMustContain: ['claro'],
        replyMustNotMatch: ['despues'],
      },
    }],
    criteria: [{ id: 'reply', rule: 'reply_must_match', patterns: ['claro'] }],
  });
}

function turn(shouldSendGalleryImages: boolean): TurnRecord {
  return {
    turnNumber: 1,
    user: 'Fotos de la mina',
    reply: 'Claro',
    processOutput: {
      reply: 'Claro',
      shouldSendReply: true,
      leadScore: 0,
      usedAi: false,
      shouldAlertOwner: false,
      shouldSendImage: false,
      shouldSendOwnerImage: false,
      shouldSendGalleryImages,
      priceJustGiven: false,
    },
  };
}

describe('conversation eval integrity', () => {
  it('validates reply patterns and real output flags without mutating output', () => {
    const record = turn(true);
    expect(validateTurnExpectations(scenario(), [record])).toEqual([]);
    expect(record.processOutput.shouldSendGalleryImages).toBe(true);

    record.processOutput.shouldSendGalleryImages = false;
    expect(validateTurnExpectations(scenario(), [record])).toContain(
      '[expect turn 1] shouldSendGalleryImages expected=true actual=false',
    );
  });

  it('excludes synthetic runners from live scenarios', () => {
    const scenarios = [scenario(), scenario('follow_up'), scenario('lifecycle')];
    const result = partitionLiveScenarios(scenarios);
    expect(result.supported.map(item => item.runner)).toEqual(['message']);
    expect(result.skipped.map(item => item.runner)).toEqual(['follow_up', 'lifecycle']);
  });
});
