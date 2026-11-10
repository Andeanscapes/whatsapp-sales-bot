import { describe, expect, it } from 'vitest';
import { partitionLiveScenarios } from './scenario-loader.js';
import { scenarioSchema } from './schema.js';
import { validateTurnExpectations } from './turn-expectations.js';
import { loadScenarios } from './scenario-loader.js';
import { evaluateScenario } from './evaluate-scenario.js';
import { fileURLToPath } from 'node:url';
import type { TurnRecord } from './runner.js';
import { detectLanguageOrNull } from '../../services/language-service.js';

function scenario(runner: 'message' | 'lifecycle' = 'message', tags?: string[]) {
  return scenarioSchema.parse({
    id: `test-${runner}${tags?.length ? `-${tags.join('-')}` : ''}`,
    runner,
    ...(tags ? { tags } : {}),
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

describe('English curated pack integrity', () => {
  const spanish = loadScenarios(fileURLToPath(new URL('./scenarios', import.meta.url)));
  const english = loadScenarios(fileURLToPath(new URL('./scenarios-en', import.meta.url)));

  it.each(english.map(item => [item.id, item] as const))('%s is a live-consistent English twin', (id, item) => {
    const twin = spanish.find(candidate => candidate.id === id);
    expect(twin, `Spanish twin of ${id}`).toBeDefined();
    expect(item.lang).toBe('en');
    expect(twin!.lang).toBe('es');
    expect(item.tags?.includes('live') ?? false).toBe(twin!.tags?.includes('live') ?? false);
  });

  it.each(english.map(item => [item.id, item] as const))('%s opens in English so the bot replies in English', (_id, item) => {
    expect(detectLanguageOrNull(item.turns[0].user)).toBe('en');
  });
});

describe('conversation eval integrity', () => {
  it.each([
    ['¿Vienen en pareja, solos o en grupo?', true],
    ['¿La experiencia sería para ti solo, en pareja o para un grupo?', true],
    ['¿Qué les atrae más: la intensidad de la mina o un ritmo con naturaleza y actividades?', false],
    ['La experiencia es para parejas y grupos. ¿Te cuento más?', false],
    ['Somos un grupo pequeño. ¿Te cuento más?', false],
  ])('checks the H01 group question inside its question: %s', (reply, passed) => {
    const h01 = loadScenarios(fileURLToPath(new URL('./scenarios', import.meta.url)))
      .find(item => item.id === 'entry-funnel-H01')!;
    const record = { ...turn(false), reply };
    expect(evaluateScenario(h01, [record]).criteria.find(item => item.id === 'asks-group')?.passed)
      .toBe(passed);
  });
  it.each([2, 4, undefined])('rejects criteria targeting replay turn %s', checkedTurn => {
    expect(() => scenarioSchema.parse({
      id: 'replay-validation',
      turns: [1, 2, 3, 4].map(n => ({ user: `turn ${n}`, mockReply: 'reply', replay: n === 2 || n === 4 })),
      criteria: [{ id: 'reply', rule: 'reply_must_match', patterns: ['reply'], turn: checkedTurn }],
    })).toThrow('checks a replay turn');
  });
  it('validates reply patterns and real output flags without mutating output', () => {
    const record = turn(true);
    expect(validateTurnExpectations(scenario(), [record])).toEqual([]);
    expect(record.processOutput.shouldSendGalleryImages).toBe(true);

    record.processOutput.shouldSendGalleryImages = false;
    expect(validateTurnExpectations(scenario(), [record])).toContain(
      '[expect turn 1] shouldSendGalleryImages expected=true actual=false',
    );
  });

  // The production defect was a marker that resolved to zero photos while the copy
  // still promised them, so the count must be assertable on its own.
  it('counts the photos a turn actually ships, not just the flag', () => {
    const record = turn(true);
    const expectOne = scenarioSchema.parse({
      id: 'test-requested-count',
      turns: [{ user: 'Fotos de la mina', mockReply: 'Claro', expect: { requestedGalleryImagesCount: 1 } }],
      criteria: [{ id: 'reply', rule: 'reply_must_match', patterns: ['claro'] }],
    });

    expect(validateTurnExpectations(expectOne, [record])).toContain(
      '[expect turn 1] requestedGalleryImages count expected=1 actual=0',
    );

    record.processOutput.requestedGalleryImages = ['https://cdn.example.com/exp_01.jpg'];
    expect(validateTurnExpectations(expectOne, [record])).toEqual([]);
  });

  it('excludes synthetic runners from live scenarios', () => {
    const scenarios = [scenario(), scenario('lifecycle')];
    const result = partitionLiveScenarios(scenarios);
    expect(result.supported.map(item => item.runner)).toEqual(['message']);
    expect(result.skipped.map(item => item.runner)).toEqual(['lifecycle']);
    expect(result.deselected).toEqual([]);
  });

  // Live runs cost provider tokens: the `live` tag must actually bound the subset.
  it('sends only live-tagged message scenarios by default', () => {
    const tagged = scenario('message', ['opening', 'live']);
    const untagged = scenario('message', ['objection']);
    const result = partitionLiveScenarios([tagged, untagged, scenario('lifecycle')]);

    expect(result.supported.map(item => item.id)).toEqual([tagged.id]);
    expect(result.deselected.map(item => item.id)).toEqual([untagged.id]);
    expect(result.skipped.map(item => item.runner)).toEqual(['lifecycle']);
  });

  it('includes every message scenario when includeAll is requested', () => {
    const tagged = scenario('message', ['live']);
    const untagged = scenario('message', ['objection']);
    const result = partitionLiveScenarios([tagged, untagged], { includeAll: true });

    expect(result.supported.map(item => item.id)).toEqual([tagged.id, untagged.id]);
    expect(result.deselected).toEqual([]);
  });

  it('falls back to all message scenarios when no scenario is tagged live', () => {
    const result = partitionLiveScenarios([scenario('message', ['opening'])]);
    expect(result.supported).toHaveLength(1);
    expect(result.deselected).toEqual([]);
  });
});
