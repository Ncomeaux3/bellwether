import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { scoreCandidate, PROXIMITY_WINDOW_CHARS } from '../src/tools/qualify.js';
import { qualifyCandidates } from '../src/workflow/qualify.js';
import type { FetchResult } from '../src/tools/fetch.js';

// --- fixtures ---------------------------------------------------------
// Small, representative shapes rather than committed megabyte pages (spec
// 11.1's six were 371 KB - 2.3 MB of real markup; these reproduce the
// structural pattern that makes a page pass or fail, not the bytes).

function tierPage(tiers: { name: string; price: string }[]): string {
  const blocks = tiers.map(t =>
    `<div class="pricing-tier"><h2>${t.name}</h2><p>${t.price}</p></div>`
  ).join('\n');
  return `<html><body><main>${blocks}</main></body></html>`;
}

const LINEAR = tierPage([
  { name: 'Free', price: '$0/mo' },
  { name: 'Basic', price: '$8/user/mo' },
  { name: 'Business', price: '$14/user/mo' },
  { name: 'Enterprise', price: 'Contact us' },
]);

const NOTION = tierPage([
  { name: 'Free', price: '$0' },
  { name: 'Plus', price: '$10/mo' },
  { name: 'Business', price: '$15/mo' },
  { name: 'Enterprise', price: 'Contact sales' },
]);

const FIGMA = tierPage([
  { name: 'Starter', price: '$0' },
  { name: 'Professional', price: '$12/editor/mo' },
  { name: 'Organization', price: '$45/editor/mo' },
  { name: 'Enterprise', price: '$75/editor/mo' },
]);

const SUPABASE = tierPage([
  { name: 'Free', price: '$0' },
  { name: 'Pro', price: '$25/mo' },
  { name: 'Team', price: '$599/mo' },
  { name: 'Enterprise', price: 'Custom' },
]);

const SENTRY = tierPage([
  { name: 'Developer', price: '$0' },
  { name: 'Team', price: '$26/mo' },
  { name: 'Business', price: '$80/mo' },
]);

const POSTMAN = tierPage([
  { name: 'Free', price: '$0' },
  { name: 'Basic', price: '$14/user/mo' },
  { name: 'Professional', price: '$29/user/mo' },
  { name: 'Enterprise', price: '$49/user/mo' },
]);

const KNOWN_GOOD: Record<string, string> = {
  Linear: LINEAR, Notion: NOTION, Figma: FIGMA,
  Supabase: SUPABASE, Sentry: SENTRY, Postman: POSTMAN,
};

/** Shape of the real Vercel screening failure: a client-hydrated shell. */
const VERCEL_SHELL =
  '<html><head><script src="/_next/static/chunks/pricing-a1b2c3.js"></script></head>' +
  '<body><div id="__next"></div><noscript>You need to enable JavaScript.</noscript></body></html>';

/** A blog post about a price change: currency present, no tier structure. */
const PRICES_NO_TIERS =
  '<html><body><article><p>Today we are raising the price from $15 to $20 per ' +
  'month, effective immediately. We think $20 is worth it.</p></article></body></html>';

/** A feature-comparison page: tier headings present, nothing priced. */
const TIERS_NO_PRICES =
  '<html><body><main><h2>Free</h2><p>Basic features included</p>' +
  '<h2>Pro</h2><p>Advanced features included</p>' +
  '<h2>Enterprise</h2><p>Everything included</p></main></body></html>';

/** Prices and tier headings both present, but ~50 KB apart. */
function farApartPage(): string {
  const filler = 'x'.repeat(50_000);
  return `<html><body><main><h2>Free</h2><h2>Pro</h2><h2>Enterprise</h2>` +
    `${filler}<p>$10 $20 $99</p></main></body></html>`;
}

/** M3's Linear shape: a shadow-DOM <style> closed with trailing whitespace. */
const WHITESPACE_CLOSER_PAGE = [
  '<body><main>',
  '<span><template shadowroot="open" shadowrootmode="open"\n\t\t\t><style>',
  ':host{display:inline-block}',
  '</style\n\t\t\t><span>$</span><span>8</span></template\n\t\t></span>',
  '<h2>Basic</h2><p>$8 per user/month</p>',
  '<h2>Business</h2><p>$14 per user/month</p>',
  '<h2>Enterprise</h2><p>Custom pricing</p>',
  '</main></body>',
].join('\n');

describe('scoreCandidate — known-good pages', () => {
  for (const [name, html] of Object.entries(KNOWN_GOOD)) {
    it(`passes on the ${name}-shaped fixture`, () => {
      const result = scoreCandidate(html);
      expect(result.verdict).toBe('pass');
      expect(result.priceMatches).toBeGreaterThanOrEqual(2);
      expect(result.tierHeadings).toBeGreaterThanOrEqual(2);
    });
  }
});

describe('scoreCandidate — known qualification failures', () => {
  it('fails the Vercel-shaped shell, naming both missing signals', () => {
    const result = scoreCandidate(VERCEL_SHELL);
    expect(result.verdict).toBe('fail');
    expect(result.priceMatches).toBe(0);
    expect(result.tierHeadings).toBe(0);
    expect(result.reason).toMatch(/price/i);
    expect(result.reason).toMatch(/tier/i);
    expect(result.proposedCanary).toBeNull();
  });

  it('fails a page with prices but no tier headings, naming the missing signal', () => {
    const result = scoreCandidate(PRICES_NO_TIERS);
    expect(result.verdict).toBe('fail');
    expect(result.priceMatches).toBeGreaterThanOrEqual(2);
    expect(result.tierHeadings).toBe(0);
    expect(result.reason).toMatch(/tier/i);
    expect(result.reason).not.toMatch(/price match/i);
  });

  it('fails a page with tier headings but no prices, naming the missing signal', () => {
    const result = scoreCandidate(TIERS_NO_PRICES);
    expect(result.verdict).toBe('fail');
    expect(result.priceMatches).toBe(0);
    expect(result.tierHeadings).toBeGreaterThanOrEqual(2);
    expect(result.reason).toMatch(/price/i);
    expect(result.reason).not.toMatch(/tier-like headings \(found 0\)/i);
  });

  it('fails when prices and tier headings are present but far apart (R1 proximity)', () => {
    const result = scoreCandidate(farApartPage());
    expect(result.verdict).toBe('fail');
    expect(result.priceMatches).toBeGreaterThanOrEqual(2);
    expect(result.tierHeadings).toBeGreaterThanOrEqual(2);
    expect(result.reason).toMatch(new RegExp(`${PROXIMITY_WINDOW_CHARS} chars`));
  });
});

describe('scoreCandidate — the whitespace-closer bug (M3 Linear shape)', () => {
  it('still finds the tiers and prices a naive parse would swallow', () => {
    const result = scoreCandidate(WHITESPACE_CLOSER_PAGE);
    expect(result.verdict).toBe('pass');
    expect(result.tierHeadings).toBeGreaterThanOrEqual(2);
    expect(result.priceMatches).toBeGreaterThanOrEqual(2);
  });
});

describe('scoreCandidate — canary proposal', () => {
  it('never proposes a string containing a digit, even when digit-bearing headings exist', () => {
    const html = tierPage([
      { name: 'Starter Plan 2024', price: '$9/mo' },
      { name: 'Growth', price: '$29/mo' },
      { name: 'Enterprise', price: '$99/mo' },
    ]);
    const result = scoreCandidate(html);
    expect(result.proposedCanary).not.toBeNull();
    expect(result.proposedCanary).not.toMatch(/\d/);
  });

  it('is null when every qualifying heading contains a digit', () => {
    const html = tierPage([
      { name: 'Plan A1', price: '$9/mo' },
      { name: 'Plan B2', price: '$29/mo' },
    ]);
    const result = scoreCandidate(html);
    expect(result.proposedCanary).toBeNull();
  });

  for (const [name, html] of Object.entries(KNOWN_GOOD)) {
    it(`${name}: proposed canary (if any) contains no digit`, () => {
      const result = scoreCandidate(html);
      if (result.proposedCanary !== null) expect(result.proposedCanary).not.toMatch(/\d/);
    });
  }
});

// --- workflow -----------------------------------------------------------

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-qualify-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function ok(body: string): FetchResult {
  return { ok: true, httpStatus: 200, body, error: null };
}
function fail(status: number | null, error: string): FetchResult {
  return { ok: false, httpStatus: status, body: null, error };
}

describe('qualifyCandidates — workflow', () => {
  it('uses an injected fetcher and upserts a pass row', async () => {
    const stats = await qualifyCandidates(
      db,
      { urls: ['https://acme.test/pricing'] },
      { fetcher: async () => ok(LINEAR), now: () => new Date('2026-08-20T00:00:00.000Z') },
    );

    expect(stats.attempted).toBe(1);
    expect(stats.pass).toBe(1);

    const row = db.prepare('SELECT verdict, price_matches, tier_headings, http_status FROM candidates WHERE url = ?')
      .get('https://acme.test/pricing') as { verdict: string; price_matches: number; tier_headings: number; http_status: number };
    expect(row.verdict).toBe('pass');
    expect(row.price_matches).toBeGreaterThanOrEqual(2);
    expect(row.http_status).toBe(200);
  });

  it('records verdict=error (not fail) on a 404, distinguishing unreachable from unqualified', async () => {
    const stats = await qualifyCandidates(
      db,
      { urls: ['https://acme.test/gone'] },
      { fetcher: async () => fail(404, 'HTTP 404') },
    );

    expect(stats.attempted).toBe(1);
    expect(stats.error).toBe(1);
    expect(stats.fail).toBe(0);

    const row = db.prepare('SELECT verdict, reason, http_status FROM candidates WHERE url = ?')
      .get('https://acme.test/gone') as { verdict: string; reason: string; http_status: number | null };
    expect(row.verdict).toBe('error');
    expect(row.http_status).toBe(404);
  });

  it('is idempotent on re-run: a second screening of the same URL updates in place, not duplicates', async () => {
    const deps = { fetcher: async () => ok(LINEAR) };
    await qualifyCandidates(db, { urls: ['https://acme.test/pricing'] }, deps);
    const second = await qualifyCandidates(db, { urls: ['https://acme.test/pricing'] }, deps);

    expect(second.attempted).toBe(1);
    const rows = db.prepare('SELECT * FROM candidates WHERE url = ?').all('https://acme.test/pricing');
    expect(rows).toHaveLength(1);
  });

  it('--all skips candidates already screened, and --limit caps the rest', async () => {
    // Pre-screen one entry from the real pool so the "unscreened only" filter has something to skip.
    await qualifyCandidates(db, { urls: ['https://vercel.com/pricing'] }, { fetcher: async () => ok(VERCEL_SHELL) });

    const stats = await qualifyCandidates(db, { all: true, limit: 3 }, { fetcher: async () => ok(LINEAR) });

    expect(stats.attempted).toBe(3);
    const screenedUrls = (db.prepare('SELECT url FROM candidates').all() as { url: string }[]).map(r => r.url);
    expect(new Set(screenedUrls).size).toBe(screenedUrls.length); // no duplicates
    expect(screenedUrls.length).toBe(4); // 1 pre-screened + 3 new
  });
});
