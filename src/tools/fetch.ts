import { USER_AGENT } from '../version.js';
import { HostRateLimiter } from './ratelimit.js';
import { isPathAllowed, parseRobots, type RobotsRules } from './robots.js';

export interface FetchResult {
  ok: boolean;
  httpStatus: number | null;
  body: string | null;
  error: string | null;
}

const AGENT_TOKEN = 'Bellwether';
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const MAX_REDIRECTS = 5;

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export interface RobotsCacheDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface CacheEntry { rules: RobotsRules; fetchedAt: number }

/** Spec 11: robots.txt fetched, cached 24h, honored. */
export class RobotsCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: RobotsCacheDeps = {}) {}

  async allowed(url: string): Promise<boolean> {
    const parsed = new URL(url);
    const now = (this.deps.now ?? Date.now)();
    const key = parsed.origin;

    let entry = this.cache.get(key);
    if (!entry || now - entry.fetchedAt > ROBOTS_TTL_MS) {
      entry = { rules: await this.load(parsed.origin), fetchedAt: now };
      this.cache.set(key, entry);
    }

    return isPathAllowed(entry.rules, parsed.pathname);
  }

  /** A robots.txt we cannot read is treated as permissive — the standard's default. */
  private async load(origin: string): Promise<RobotsRules> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    try {
      const res = await doFetch(`${origin}/robots.txt`, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) return { allow: [], disallow: [] };
      return parseRobots(await res.text(), AGENT_TOKEN);
    } catch {
      return { allow: [], disallow: [] };
    }
  }
}

export interface FetchDeps {
  fetchImpl?: typeof fetch;
  limiter?: HostRateLimiter;
  robots?: RobotsCache;
  sleep?: (ms: number) => Promise<void>;
  maxBytes?: number;
  retries?: number;
  timeoutMs?: number;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeded the ${maxBytes} byte cap`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Spec 11. Never throws: a failure is a FetchResult with ok=false, because the
 * caller must record the attempt either way — silence would read as stability.
 */
export async function politeFetch(url: string, deps: FetchDeps = {}): Promise<FetchResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const limiter = deps.limiter ?? new HostRateLimiter();
  const robots = deps.robots ?? new RobotsCache();
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const retries = deps.retries ?? DEFAULT_RETRIES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { ok: false, httpStatus: null, body: null, error: `Malformed URL: ${url}` };
  }

  try {
    if (!(await robots.allowed(url))) {
      return { ok: false, httpStatus: null, body: null, error: `Blocked by robots.txt: ${url}` };
    }
  } catch (err) {
    return { ok: false, httpStatus: null, body: null, error: `robots.txt check failed: ${String(err)}` };
  }

  let lastError = 'unknown error';
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) await sleep(2 ** attempt * 1000);
    await limiter.wait(host);

    try {
      const res = await doFetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = res.status;

      // 4xx other than 429 is a settled answer — retrying wastes their bandwidth.
      if (!res.ok && res.status !== 429 && res.status < 500) {
        return { ok: false, httpStatus: res.status, body: null, error: `HTTP ${res.status}` };
      }
      if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }

      const body = await readCapped(res, maxBytes);
      return { ok: true, httpStatus: res.status, body, error: null };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (/cap$/i.test(lastError) || /byte cap/i.test(lastError)) {
        return { ok: false, httpStatus: lastStatus, body: null, error: lastError };
      }
    }
  }

  return { ok: false, httpStatus: lastStatus, body: null, error: lastError };
}

export { MAX_REDIRECTS };
