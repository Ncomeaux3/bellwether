import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HostRateLimiter } from '../src/tools/ratelimit.js';
import { RobotsCache, politeFetch } from '../src/tools/fetch.js';

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()));
  server = undefined;
});

interface Routes { [path: string]: (req: any, res: any) => void }

async function start(routes: Routes): Promise<string> {
  server = createServer((req, res) => {
    const handler = routes[req.url ?? '/'];
    if (!handler) { res.writeHead(404); res.end('not found'); return; }
    handler(req, res);
  });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  return `http://127.0.0.1:${addr.port}`;
}

/** No real waiting in tests. */
function fastDeps() {
  return {
    limiter: new HostRateLimiter(0, 0, { sleep: async () => {} }),
    robots: new RobotsCache({ sleep: async () => {} }),
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
