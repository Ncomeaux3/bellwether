import { defaultSleep } from './sleep.js';

export interface RateLimiterDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Spec 11: minimum 10s between requests to the same host, jittered.
 * Per-host, so six competitors on six hosts never wait on each other.
 */
export class HostRateLimiter {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly minIntervalMs = 10_000,
    private readonly jitterMs = 3_000,
    private readonly deps: RateLimiterDeps = {}
  ) {}

  async wait(host: string): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? defaultSleep;
    const random = this.deps.random ?? Math.random;

    const previous = this.last.get(host);
    if (previous !== undefined) {
      const target = previous + this.minIntervalMs + random() * this.jitterMs;
      const delay = target - now();
      if (delay > 0) await sleep(delay);
    }
    this.last.set(host, now());
  }
}
