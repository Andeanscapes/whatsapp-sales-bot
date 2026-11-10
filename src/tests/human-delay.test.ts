import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTurnPacer } from '../services/human-delay.js';

// randomInt(min, max) === floor(random() * (max - min + 1)) + min
// → random() = 0 yields the minimum bound, ~1 yields the maximum bound.
const RANDOM_MIN = 0;
const RANDOM_MAX = 0.999999;

function track(promise: Promise<unknown>): { settled: () => boolean } {
  let settled = false;
  void promise.then(() => { settled = true; });
  return { settled: () => settled };
}

describe('human-delay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('first pace sends immediately, with no response delay', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MAX);
    const pacer = createTurnPacer(() => false);

    await expect(pacer.pace()).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a turn superseded by a newer inbound sends nothing, with no timer', async () => {
    const pacer = createTurnPacer(() => true);
    await expect(pacer.pace()).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('later messages of the same turn keep the 1s lower gap', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MIN);
    const pacer = createTurnPacer(() => false);
    await pacer.pace();

    const next = track(pacer.pace());
    await vi.advanceTimersByTimeAsync(999);
    expect(next.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(next.settled()).toBe(true);
  });

  it('later messages of the same turn keep the 4s upper gap', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MAX);
    const pacer = createTurnPacer(() => false);
    await pacer.pace();

    const next = track(pacer.pace());
    await vi.advanceTimersByTimeAsync(3_999);
    expect(next.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(next.settled()).toBe(true);
  });

  it('a newer inbound mid-turn skips the remaining messages, with no timer', async () => {
    let skip = false;
    const pacer = createTurnPacer(() => skip);
    await pacer.pace();

    skip = true;
    await expect(pacer.pace()).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns false when a newer inbound arrives during a gap', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MIN);
    let skip = false;
    const pacer = createTurnPacer(() => skip);
    await pacer.pace();

    const pace = pacer.pace();
    skip = true;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pace).resolves.toBe(false);
  });

  it('skipping the first pace leaves the next pace immediate (it is still the first send)', async () => {
    let skip = true;
    const pacer = createTurnPacer(() => skip);

    await expect(pacer.pace()).resolves.toBe(false);
    skip = false;
    await expect(pacer.pace()).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
