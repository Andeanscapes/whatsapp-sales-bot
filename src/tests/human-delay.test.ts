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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

  it('first pace waits the 10s lower bound', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MIN);
    const pacer = createTurnPacer(Date.now(), () => false, true);

    const tracked = track(pacer.pace());
    await vi.advanceTimersByTimeAsync(9_999);
    expect(tracked.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(tracked.settled()).toBe(true);
  });

  it('first pace waits the 40s upper bound', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MAX);
    const pacer = createTurnPacer(Date.now(), () => false, true);

    const tracked = track(pacer.pace());
    await vi.advanceTimersByTimeAsync(39_999);
    expect(tracked.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(tracked.settled()).toBe(true);
  });

  it('first pace subtracts time already spent processing', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MIN);
    // Turn began 4s ago (e.g. LLM call), so only 6s of the 10s target remain.
    const pacer = createTurnPacer(Date.now() - 4_000, () => false, true);

    const tracked = track(pacer.pace());
    await vi.advanceTimersByTimeAsync(5_999);
    expect(tracked.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(tracked.settled()).toBe(true);
  });

  it('first pace clamps to zero when processing already exceeded the target', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MAX);
    const pacer = createTurnPacer(Date.now() - 50_000, () => false, true);

    await pacer.pace();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('burst paces use the short 1-4s window, not the first-message window', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MIN);
    const pacer = createTurnPacer(Date.now(), () => false, true);

    const first = track(pacer.pace());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.settled()).toBe(true);

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

    const first = track(pacer.pace());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.settled()).toBe(true);

    skip = true;
    await pacer.pace();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns false when a newer inbound arrives during the delay', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MIN);
    let skip = false;
    const pacer = createTurnPacer(Date.now(), () => skip, true);

    const pace = pacer.pace();
    skip = true;
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pace).resolves.toBe(false);
  });

  it('skipping the first pace still leaves later paces on the burst window', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(RANDOM_MIN);
    let skip = true;
    const pacer = createTurnPacer(Date.now(), () => skip, true);

    await pacer.pace();
    expect(vi.getTimerCount()).toBe(0);

    skip = false;
    const next = track(pacer.pace());
    await flush();
    // First pace was skipped before consuming the first-message window, so this
    // call is still treated as the first message of the turn.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(next.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(next.settled()).toBe(true);
  });
});
