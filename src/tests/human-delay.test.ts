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

  it('disabled → no timer scheduled, resolves immediately', async () => {
    const pacer = createTurnPacer(Date.now(), () => false, false);
    await expect(pacer.pace()).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disabled still suppresses a turn superseded before send', async () => {
    const pacer = createTurnPacer(Date.now(), () => true, false);
    await expect(pacer.pace()).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shouldSkip true → no timer scheduled, resolves immediately', async () => {
    const pacer = createTurnPacer(Date.now(), () => true, true);
    await pacer.pace();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('first pace sends immediately, with no artificial wait', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MAX);
    const pacer = createTurnPacer(Date.now(), () => false, true);

    await expect(pacer.pace()).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('first pace still reports a turn superseded by a newer inbound', async () => {
    const pacer = createTurnPacer(Date.now(), () => true, true);
    await expect(pacer.pace()).resolves.toBe(false);
  });

  it('burst paces use the short 1-4s window, not the first-message window', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MIN);
    const pacer = createTurnPacer(Date.now(), () => false, true);

    await pacer.pace();

    const burst = track(pacer.pace());
    await vi.advanceTimersByTimeAsync(999);
    expect(burst.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(burst.settled()).toBe(true);
  });

  it('burst pace upper bound is 4s', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MAX);
    const pacer = createTurnPacer(Date.now() - 60_000, () => false, true);

    await pacer.pace();

    const burst = track(pacer.pace());
    await vi.advanceTimersByTimeAsync(3_999);
    expect(burst.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(burst.settled()).toBe(true);
  });

  it('shouldSkip flipping true mid-turn skips remaining paces', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MIN);
    let skip = false;
    const pacer = createTurnPacer(Date.now(), () => skip, true);

    await pacer.pace();

    skip = true;
    await pacer.pace();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns false when a newer inbound arrives during a burst gap', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MIN);
    let skip = false;
    const pacer = createTurnPacer(Date.now(), () => skip, true);

    await pacer.pace();
    const pace = pacer.pace();
    skip = true;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pace).resolves.toBe(false);
  });

  it('skipping the first pace leaves the next pace immediate (it is still the first send)', async () => {
    let skip = true;
    const pacer = createTurnPacer(Date.now(), () => skip, true);

    await expect(pacer.pace()).resolves.toBe(false);
    skip = false;
    await expect(pacer.pace()).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
