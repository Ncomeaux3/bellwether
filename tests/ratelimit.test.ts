import { describe, expect, it } from 'vitest';
import { HostRateLimiter } from '../src/tools/ratelimit.js';

/** A controllable clock: `sleep` advances `now` deterministically, no real waiting. */
function fakeClock() {
  let time = 0;
  const waits: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
    waits,
  };
}

describe('HostRateLimiter', () => {
  it('makes a second call to the same host wait at least minIntervalMs', async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter(10_000, 0, {
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    });

    await limiter.wait('a.test');
    const startedAt = clock.now();
    await limiter.wait('a.test');

    expect(clock.now() - startedAt).toBeGreaterThanOrEqual(10_000);
    expect(clock.waits).toEqual([10_000]);
  });

  it('accounts for time already elapsed since the last request to that host', async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter(10_000, 0, {
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    });

    await limiter.wait('a.test');
    clock.advance(4_000);
    await limiter.wait('a.test');

    // Only the remaining 6s should be slept, not the full 10s again.
    expect(clock.waits).toEqual([6_000]);
  });

  it('does not make two different hosts block each other', async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter(10_000, 0, {
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    });

    await limiter.wait('a.test');
    await limiter.wait('b.test');

    expect(clock.waits).toEqual([]);
  });

  it('keeps the jitter contribution within [0, jitterMs] at the low end', async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter(10_000, 3_000, {
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    });

    await limiter.wait('a.test');
    await limiter.wait('a.test');

    expect(clock.waits).toEqual([10_000]);
  });

  it('keeps the jitter contribution within [0, jitterMs] at the high end', async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter(10_000, 3_000, {
      now: clock.now,
      sleep: clock.sleep,
      random: () => 1,
    });

    await limiter.wait('a.test');
    await limiter.wait('a.test');

    expect(clock.waits).toEqual([13_000]);
  });

  it('keeps a mid-range jitter draw within [minIntervalMs, minIntervalMs + jitterMs]', async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter(10_000, 3_000, {
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
    });

    await limiter.wait('a.test');
    await limiter.wait('a.test');

    expect(clock.waits[0]).toBeGreaterThanOrEqual(10_000);
    expect(clock.waits[0]).toBeLessThanOrEqual(13_000);
  });
});
