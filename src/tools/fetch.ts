import { isIP } from 'node:net';
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
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Sentinel error class so the byte-cap check is control flow, not error-message parsing. */
export class ByteCapExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Response exceeded the ${maxBytes} byte cap`);
    this.name = 'ByteCapExceededError';
  }
}

// --- SSRF-adjacent destination guard -------------------------------------
//
// Blocks a redirect that points at a loopback, link-local, private, or
// reserved address. Only literal IP hostnames are checked: net.isIP() tells
// us whether the hostname is already an IP literal, and we never resolve a
// bare DNS name ourselves. Resolving it here would add a second DNS lookup
// racing the one fetch() performs internally (TOCTOU: the name could
// resolve to a different, private address by the time the real connection
// is made), which is a class of bug this check is not equipped to close.
// A literal-IP hostname in a blocked range is refused; a bare DNS name
// passes this check and is trusted to fetch() + the OS resolver.

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function ipv4InRange(ip: string, base: string, prefixBits: number): boolean {
  const mask = prefixBits === 0 ? 0 : (~0 << (32 - prefixBits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function isBlockedIPv4(ip: string): boolean {
  return (
    ipv4InRange(ip, '127.0.0.0', 8) || // loopback
    ipv4InRange(ip, '169.254.0.0', 16) || // link-local, incl. cloud metadata 169.254.169.254
    ipv4InRange(ip, '10.0.0.0', 8) || // private
    ipv4InRange(ip, '172.16.0.0', 12) || // private
    ipv4InRange(ip, '192.168.0.0', 16) // private
  );
}

function hexGroupToOctets(hex: string): [number, number] {
  const value = Number.parseInt(hex, 16);
  return [(value >> 8) & 0xff, value & 0xff];
}

function isBlockedIPv6(rawIp: string): boolean {
  const ip = rawIp.toLowerCase();
  if (ip === '::1') return true; // loopback

  // IPv4-mapped (::ffff:0:0/96). The WHATWG URL parser canonicalizes
  // "::ffff:127.0.0.1" to "::ffff:7f00:1" (hex groups, not dotted-decimal),
  // so unmap it back to an IPv4 address before re-checking.
  const mapped = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const g1 = mapped[1];
    const g2 = mapped[2];
    if (g1 && g2) {
      const [a, b] = hexGroupToOctets(g1);
      const [c, d] = hexGroupToOctets(g2);
      return isBlockedIPv4(`${a}.${b}.${c}.${d}`);
    }
  }

  const firstGroup = ip.split(':')[0];
  if (firstGroup && /^[0-9a-f]{1,4}$/.test(firstGroup)) {
    const value = Number.parseInt(firstGroup, 16);
    if (value >= 0xfc00 && value <= 0xfdff) return true; // unique-local fc00::/7
    if (value >= 0xfe80 && value <= 0xfebf) return true; // link-local fe80::/10
  }

  return false;
}

/** Refuses a literal loopback/link-local/private/reserved IP. Bare DNS names pass unchecked — see note above. */
export function isBlockedDestination(url: URL): boolean {
  let hostname = url.hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  const kind = isIP(hostname);
  if (kind === 4) return isBlockedIPv4(hostname);
  if (kind === 6) return isBlockedIPv6(hostname);
  return false;
}

// --- robots.txt cache -------------------------------------------------------

export interface RobotsCacheDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limiter?: HostRateLimiter;
}

export interface RobotsAllowedOptions {
  /**
   * Policy when we cannot even reach the host to check robots.txt.
   * 'permissive' (default) is the standard's convention for the original,
   * caller-supplied URL. 'blocked' is used for redirect targets: we have
   * zero information about a host we followed a Location header into, so
   * we fail closed rather than open.
   */
  onUnverifiable?: 'permissive' | 'blocked';
}

interface CacheEntry { rules: RobotsRules; fetchedAt: number; verified: boolean }

/** Spec 11: robots.txt fetched, cached 24h, honored. */
export class RobotsCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: RobotsCacheDeps = {}) {}

  async allowed(url: string, options?: RobotsAllowedOptions): Promise<boolean> {
    const parsed = new URL(url);
    const now = (this.deps.now ?? Date.now)();
    const key = parsed.origin;

    let entry = this.cache.get(key);
    if (!entry || now - entry.fetchedAt > ROBOTS_TTL_MS) {
      const loaded = await this.load(parsed.origin);
      entry = { rules: loaded.rules, fetchedAt: now, verified: loaded.verified };
      this.cache.set(key, entry);
    }

    if (!entry.verified && options?.onUnverifiable === 'blocked') return false;
    return isPathAllowed(entry.rules, parsed.pathname);
  }

  /**
   * A robots.txt we cannot read is treated as permissive — the standard's default.
   * "verified" means we got a response from the host at all (even a 4xx/5xx one);
   * it is false only when we could not reach the host in the first place.
   */
  private async load(origin: string): Promise<{ rules: RobotsRules; verified: boolean }> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    try {
      if (this.deps.limiter) await this.deps.limiter.wait(new URL(origin).host);
      const res = await doFetch(`${origin}/robots.txt`, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) return { rules: { allow: [], disallow: [] }, verified: true };
      return { rules: parseRobots(await res.text(), AGENT_TOKEN), verified: true };
    } catch {
      return { rules: { allow: [], disallow: [] }, verified: false };
    }
  }
}

// --- politeFetch --------------------------------------------------------

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
      throw new ByteCapExceededError(maxBytes);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}

interface AttemptContext {
  doFetch: typeof fetch;
  limiter: HostRateLimiter;
  robots: RobotsCache;
  maxBytes: number;
  timeoutMs: number;
}

type AttemptOutcome =
  | { terminal: true; result: FetchResult }
  | { terminal: false; status: number | null; error: string };

function terminalError(error: string, httpStatus: number | null = null): AttemptOutcome {
  return { terminal: true, result: { ok: false, httpStatus, body: null, error } };
}

/**
 * Runs one full request, following redirects (manually, so every hop gets its
 * own robots/rate-limit/SSRF checks) up to MAX_REDIRECTS. Returns a terminal
 * FetchResult (success or a failure that should not be retried) or a
 * retryable outcome (network error, 5xx, 429) for the caller's retry loop.
 * Never throws — every failure path here is caught and converted.
 */
async function runAttempt(startUrl: string, ctx: AttemptContext): Promise<AttemptOutcome> {
  let currentUrl = startUrl;
  let redirectsFollowed = 0;

  for (;;) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return terminalError(`Malformed URL: ${currentUrl}`);
    }

    if (redirectsFollowed > 0) {
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return terminalError(`Redirect used a disallowed scheme: ${parsed.protocol}`);
      }
      if (isBlockedDestination(parsed)) {
        return terminalError(`Redirect target is a private or reserved address: ${parsed.hostname}`);
      }
    }

    try {
      const allowed = await ctx.robots.allowed(
        currentUrl,
        redirectsFollowed > 0 ? { onUnverifiable: 'blocked' } : undefined
      );
      if (!allowed) return terminalError(`Blocked by robots.txt: ${currentUrl}`);
    } catch (err) {
      return terminalError(`robots.txt check failed: ${String(err)}`);
    }

    await ctx.limiter.wait(parsed.host);

    let res: Response;
    try {
      res = await ctx.doFetch(currentUrl, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
        signal: AbortSignal.timeout(ctx.timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { terminal: false, status: null, error: message };
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      if (!location) {
        return terminalError(`Redirect ${res.status} with no Location header`, res.status);
      }
      if (redirectsFollowed >= MAX_REDIRECTS) {
        return terminalError(`Exceeded ${MAX_REDIRECTS} redirects`, res.status);
      }
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return terminalError(`Malformed redirect location: ${location}`, res.status);
      }
      redirectsFollowed += 1;
      continue;
    }

    // 4xx other than 429 is a settled answer — retrying wastes their bandwidth.
    if (!res.ok && res.status !== 429 && res.status < 500) {
      return terminalError(`HTTP ${res.status}`, res.status);
    }
    if (!res.ok) {
      return { terminal: false, status: res.status, error: `HTTP ${res.status}` };
    }

    try {
      const body = await readCapped(res, ctx.maxBytes);
      return { terminal: true, result: { ok: true, httpStatus: res.status, body, error: null } };
    } catch (err) {
      if (err instanceof ByteCapExceededError) {
        return terminalError(err.message, res.status);
      }
      throw err;
    }
  }
}

/**
 * Spec 11. Never throws: a failure is a FetchResult with ok=false, because the
 * caller must record the attempt either way — silence would read as stability.
 * Everything that could reject — sleep, the rate limiter, the fetch chain
 * itself — runs inside the retry loop's try/catch, so an injected dependency
 * that rejects degrades to a retry/failure instead of an uncaught rejection.
 */
export async function politeFetch(url: string, deps: FetchDeps = {}): Promise<FetchResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const limiter = deps.limiter ?? new HostRateLimiter();
  const robots = deps.robots ?? new RobotsCache({ limiter });
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const retries = deps.retries ?? DEFAULT_RETRIES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const ctx: AttemptContext = { doFetch, limiter, robots, maxBytes, timeoutMs };

  let lastError = 'unknown error';
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      if (attempt > 0) await sleep(2 ** attempt * 1000);

      const outcome = await runAttempt(url, ctx);
      if (outcome.terminal) return outcome.result;

      lastError = outcome.error;
      lastStatus = outcome.status;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { ok: false, httpStatus: lastStatus, body: null, error: lastError };
}

export { MAX_REDIRECTS };
