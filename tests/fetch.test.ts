import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HostRateLimiter } from '../src/tools/ratelimit.js';
import { RobotsCache, isBlockedDestination, politeFetch } from '../src/tools/fetch.js';

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
  servers = [];
});

interface Routes { [path: string]: (req: any, res: any) => void }

function routeHandler(routes: Routes) {
  return (req: any, res: any) => {
    const handler = routes[req.url ?? '/'];
    if (!handler) { res.writeHead(404); res.end('not found'); return; }
    handler(req, res);
  };
}

/** Binds to 127.0.0.1 — used as the initial (trusted, caller-supplied) URL. */
async function start(routes: Routes): Promise<string> {
  const srv = createServer(routeHandler(routes));
  servers.push(srv);
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  return `http://127.0.0.1:${addr.port}`;
}

/**
 * Binds without a literal-IP host and is addressed as "localhost" — a DNS
 * name, not an IP literal — so it can stand in for a redirect *target*
 * without tripping the blocked-destination guard (which only inspects
 * literal IPs; see src/tools/fetch.ts). Used only where a test needs a
 * second hop to land somewhere other than the loopback literal.
 */
async function startAsRedirectTarget(routes: Routes): Promise<string> {
  const srv = createServer(routeHandler(routes));
  servers.push(srv);
  await new Promise<void>(r => srv.listen(0, r));
  const addr = srv.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  return `http://localhost:${addr.port}`;
}

/** No real waiting in tests. */
function fastDeps() {
  const limiter = new HostRateLimiter(0, 0, { sleep: async () => {} });
  return {
    limiter,
    robots: new RobotsCache({ limiter }),
    sleep: async () => {},
  };
}

describe('politeFetch', () => {
  it('returns the body on 200 and sends the identifying User-Agent', async () => {
    let seenUA = '';
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nAllow: /\n'); },
      '/pricing': (req, res) => {
        seenUA = String(req.headers['user-agent'] ?? '');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>Pro $20</html>');
      },
    });

    const result = await politeFetch(`${base}/pricing`, fastDeps());

    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.body).toContain('Pro $20');
    expect(seenUA).toContain('Bellwether');
  });

  it('refuses a path robots.txt disallows, without requesting it', async () => {
    let hits = 0;
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nDisallow: /pricing\n'); },
      '/pricing': (_q, res) => { hits += 1; res.writeHead(200); res.end('nope'); },
    });

    const result = await politeFetch(`${base}/pricing`, fastDeps());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/robots/i);
    expect(hits).toBe(0);
  });

  it('treats a missing robots.txt as permissive', async () => {
    const base = await start({
      '/pricing': (_q, res) => { res.writeHead(200); res.end('ok'); },
    });

    const result = await politeFetch(`${base}/pricing`, fastDeps());
    expect(result.ok).toBe(true);
  });

  it('retries a 500 and succeeds when the server recovers', async () => {
    let calls = 0;
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end(''); },
      '/pricing': (_q, res) => {
        calls += 1;
        if (calls < 3) { res.writeHead(500); res.end('boom'); return; }
        res.writeHead(200); res.end('recovered');
      },
    });

    const result = await politeFetch(`${base}/pricing`, fastDeps());

    expect(result.ok).toBe(true);
    expect(result.body).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('does not retry a 404', async () => {
    let calls = 0;
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end(''); },
      '/gone': (_q, res) => { calls += 1; res.writeHead(404); res.end('missing'); },
    });

    const result = await politeFetch(`${base}/gone`, fastDeps());

    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(404);
    expect(calls).toBe(1);
  });

  it('rejects a body larger than the cap instead of buffering it', async () => {
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end(''); },
      '/huge': (_q, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        for (let i = 0; i < 40; i += 1) res.write('x'.repeat(200_000));
        res.end();
      },
    });

    const result = await politeFetch(`${base}/huge`, { ...fastDeps(), maxBytes: 1_000_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cap/i);
  });

  it('reports a connection failure as an error rather than throwing', async () => {
    const result = await politeFetch('http://127.0.0.1:1/pricing', fastDeps());
    expect(result.ok).toBe(false);
    expect(result.body).toBeNull();
    expect(result.error).toBeTruthy();
  });
});

describe('politeFetch politeness invariants', () => {
  it('rate-limits the robots.txt fetch itself, not just the page fetch (finding 1)', async () => {
    const waits: number[] = [];
    const limiter = new HostRateLimiter(10_000, 0, {
      sleep: async (ms: number) => { waits.push(ms); },
    });
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nAllow: /\n'); },
      '/pricing': (_q, res) => { res.writeHead(200); res.end('ok'); },
    });

    const result = await politeFetch(`${base}/pricing`, {
      limiter,
      robots: new RobotsCache({ limiter }),
      sleep: async () => {},
    });

    expect(result.ok).toBe(true);
    // The robots.txt fetch and the page fetch hit the same host back to back;
    // with a shared limiter the second of the two must wait out the min interval.
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits.some(ms => ms > 9_000)).toBe(true);
  });

  it('never throws when the injected sleep rejects (finding 2)', async () => {
    let calls = 0;
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end(''); },
      '/pricing': (_q, res) => { calls += 1; res.writeHead(500); res.end('boom'); },
    });

    const result = await politeFetch(`${base}/pricing`, {
      ...fastDeps(),
      sleep: async () => { throw new Error('sleep exploded'); },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(calls).toBeGreaterThan(0);
  });

  it('never throws when the injected rate limiter rejects (finding 2)', async () => {
    const base = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end(''); },
      '/pricing': (_q, res) => { res.writeHead(200); res.end('ok'); },
    });

    const explodingLimiter = new HostRateLimiter(0, 0, { sleep: async () => {} });
    explodingLimiter.wait = async () => { throw new Error('limiter exploded'); };

    const result = await politeFetch(`${base}/pricing`, {
      limiter: explodingLimiter,
      robots: new RobotsCache(),
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('politeFetch redirect handling', () => {
  it('stops after the redirect cap instead of following forever', async () => {
    let hits = 0;
    const base = await startAsRedirectTarget({
      '/loop': (_q, res) => {
        hits += 1;
        res.writeHead(302, { location: `${base}/loop` });
        res.end();
      },
    });

    const result = await politeFetch(`${base}/loop`, fastDeps());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeded.*5.*redirect/i);
    // 1 original request + 5 followed redirects = 6 requests; the 6th
    // response is itself a redirect but is not followed.
    expect(hits).toBe(6);
  });

  it('follows a cross-origin redirect, re-checking robots and rate-limiting the new host', async () => {
    const baseB = await startAsRedirectTarget({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nAllow: /\n'); },
      '/dest': (_q, res) => { res.writeHead(200); res.end('from B'); },
    });

    const baseA = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nAllow: /\n'); },
      '/redirect': (_q, res) => {
        res.writeHead(302, { location: `${baseB}/dest` });
        res.end();
      },
    });

    const result = await politeFetch(`${baseA}/redirect`, fastDeps());

    expect(result.ok).toBe(true);
    expect(result.body).toBe('from B');
  });

  it('blocks a redirect into a path robots.txt disallows on the new origin', async () => {
    const baseB = await startAsRedirectTarget({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nDisallow: /dest\n'); },
      '/dest': (_q, res) => { res.writeHead(200); res.end('should not be reached'); },
    });

    const baseA = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nAllow: /\n'); },
      '/redirect': (_q, res) => {
        res.writeHead(302, { location: `${baseB}/dest` });
        res.end();
      },
    });

    const result = await politeFetch(`${baseA}/redirect`, fastDeps());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/robots/i);
  });

  it('blocks a redirect to a host whose robots.txt cannot be reached', async () => {
    const baseA = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nAllow: /\n'); },
      '/redirect': (_q, res) => {
        // Nothing listens on this port — robots.txt for the redirect target is unreachable.
        res.writeHead(302, { location: 'http://localhost:1/dest' });
        res.end();
      },
    });

    const result = await politeFetch(`${baseA}/redirect`, fastDeps());

    expect(result.ok).toBe(false);
  });

  it('rejects a redirect to a non-http(s) scheme', async () => {
    const baseA = await start({
      '/robots.txt': (_q, res) => { res.writeHead(200); res.end('User-agent: *\nAllow: /\n'); },
      '/redirect': (_q, res) => {
        res.writeHead(302, { location: 'ftp://example.test/dest' });
        res.end();
      },
    });

    const result = await politeFetch(`${baseA}/redirect`, fastDeps());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/scheme/i);
  });
});

describe('isBlockedDestination', () => {
  const blocked = [
    'http://127.0.0.1/',
    'http://127.55.0.9/',
    'http://169.254.169.254/', // cloud metadata
    'http://169.254.1.1/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
  ];

  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(isBlockedDestination(new URL(url))).toBe(true);
    });
  }

  const allowed = [
    'http://8.8.8.8/',
    'http://93.184.216.34/',
    'http://example.test/',
    'http://localhost/', // a DNS name, not a literal IP -- not resolved by this check
    'http://172.32.0.1/', // just outside 172.16/12
    'http://172.15.255.255/', // just outside 172.16/12
  ];

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(isBlockedDestination(new URL(url))).toBe(false);
    });
  }
});
