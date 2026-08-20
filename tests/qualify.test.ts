import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { scoreCandidate } from '../src/tools/qualify.js';
import { qualifyCandidates, verifyCandidates } from '../src/workflow/qualify.js';
import type { FetchResult } from '../src/tools/fetch.js';
import type { ExtractResult } from '../src/agents/extract_pricing.js';
import type { TierData } from '../src/schema/pricing.js';

// --- fixtures ---------------------------------------------------------
// Small, representative shapes rather than committed megabyte pages.

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

/**
 * Shape of the real Vercel screening failure: a big <script> price blob
 * (stripped by normalizeAndSlice, mirroring vercel.com/pricing's 117-of-177
 * raw matches living in <script>) plus a handful of real feature-line-item
 * prices in the body — present, but never text-adjacent to a capitalized
 * label the way a real tier name is.
 */
function vercelShapedPage(): string {
  const scriptPrices = Array.from({ length: 100 }, (_, i) => `$${i + 1}`).join(',');
  const scriptTag = `<script>window.__DATA__={prices:[${scriptPrices}]};</script>`;
  const featureLines = Array.from({ length: 10 }, (_, i) => `<p>Feature ${i} — $${i + 10}/month</p>`).join('');
  return `<html><head>${scriptTag}</head><body><main>${featureLines}</main></body></html>`;
}

/**
 * Fix round 2's regression case: the real figma.com/pricing markup has
 * whitespace/formatting between a tier's name and its price element (a
 * realistic source-formatted page, not our minified `tierPage()` helper),
 * which normalizeAndSlice collapses to a single space rather than nothing —
 * that space breaks the round-1 zero-separator adjacency heuristic entirely
 * (0 headings found), exactly as live evidence showed. A direct extraction
 * against this same text returns four priced tiers at high confidence, so a
 * pre-filter rejection here would silently and permanently exclude a source
 * that works. Fix round 2 makes the gate price-count-only so this passes.
 */
const FIGMA_LIVE_SHAPE = `
<html><body><main>
  <div class="pricing-card">
    <h3 class="tier-name">Starter</h3>
    <div class="price">$0</div>
  </div>
  <div class="pricing-card">
    <h3 class="tier-name">Professional</h3>
    <div class="price">$16</div>
  </div>
  <div class="pricing-card">
    <h3 class="tier-name">Organization</h3>
    <div class="price">$55</div>
  </div>
  <div class="pricing-card">
    <h3 class="tier-name">Enterprise</h3>
    <div class="price">$90</div>
  </div>
</main></body></html>`;

/** A blog post about a price change: currency present, no tier structure. */
const PRICES_NO_TIERS =
  '<html><body><article><p>Today we are raising the price from $15 to $20 per ' +
  'month, effective immediately. We think $20 is worth it.</p></article></body></html>';

/** No prices anywhere — the one thing the round-2 pre-filter must still reject. */
const TIERS_NO_PRICES =
  '<html><body><main><h2>Free</h2><p>Basic features included</p>' +
  '<h2>Pro</h2><p>Advanced features included</p>' +
  '<h2>Enterprise</h2><p>Everything included</p></main></body></html>';

/** Tier names and prices both present, but never text-adjacent (unrelated copy between them). */
const NAME_FAR_FROM_PRICE =
  '<html><body><main>' +
  '<h2>Free</h2><p>Our most popular plan for individuals getting started.</p><p>$0/mo</p>' +
  '<h2>Pro</h2><p>Built for growing teams who need more.</p><p>$29/mo</p>' +
  '<h2>Enterprise</h2><p>Custom contracts for large organizations.</p><p>$99/mo</p>' +
  '</main></body></html>';

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
    });
  }
});

describe('scoreCandidate — fix round 1: counts run on normalized text, not raw HTML', () => {
  it('counts the Vercel-shaped page from normalized text (10), not the raw <script> blob (110+)', () => {
    const html = vercelShapedPage();
    const rawMatches = (html.match(/[$€£]\s?\d/g) ?? []).length;

    const result = scoreCandidate(html);

    // Sanity: raw HTML materially overcounts (script-blob prices included).
    expect(rawMatches).toBeGreaterThan(50);
    // The scorer's count is the smaller, normalized-text figure — script stripped.
    expect(result.priceMatches).toBe(10);
    expect(result.priceMatches).toBeLessThan(rawMatches);
  });

  it('fails a page with no prices anywhere, regardless of heading-shaped elements', () => {
    const result = scoreCandidate(TIERS_NO_PRICES);
    expect(result.verdict).toBe('fail');
    expect(result.priceMatches).toBe(0);
    expect(result.reason).toMatch(/price/i);
  });
});

describe('scoreCandidate — fix round 2: the pre-filter gates on price matches alone', () => {
  // Live evidence: Figma FAILED the round-1 pre-filter (0 tier headings found)
  // while a direct extraction against the same text returned four priced
  // tiers at high confidence. A pre-filter rejection means --verify never
  // runs — silently and permanently excluding a working source, the worst
  // failure mode this tool has. The heading count is still computed and
  // returned as signal, but no longer blocks a pass.

  it('passes the Vercel-shaped page too — tier headings are recorded but no longer gate', () => {
    const result = scoreCandidate(vercelShapedPage());
    expect(result.verdict).toBe('pass');
    expect(result.tierHeadings).toBe(0); // recorded signal: real tier names are genuinely absent
  });

  it('passes on the Figma-live shape even though the adjacency heuristic finds 0 headings (the regression this round exists to prevent)', () => {
    const result = scoreCandidate(FIGMA_LIVE_SHAPE);
    expect(result.tierHeadings).toBe(0); // reproduces the reported false negative
    expect(result.priceMatches).toBeGreaterThanOrEqual(4);
    expect(result.verdict).toBe('pass');
  });

  it('passes a page with prices but no tier headings (heading signal recorded, not gating)', () => {
    const result = scoreCandidate(PRICES_NO_TIERS);
    expect(result.verdict).toBe('pass');
    expect(result.priceMatches).toBeGreaterThanOrEqual(2);
    expect(result.tierHeadings).toBe(0);
  });

  it('records tierHeadings=0 when a name and its price are not text-adjacent, but still passes on price count', () => {
    const result = scoreCandidate(NAME_FAR_FROM_PRICE);
    expect(result.verdict).toBe('pass');
    expect(result.priceMatches).toBeGreaterThanOrEqual(2);
    expect(result.tierHeadings).toBe(0);
  });
});

describe('scoreCandidate — the whitespace-closer bug (M3 Linear shape)', () => {
  it('still finds the prices a naive parse would swallow', () => {
    const result = scoreCandidate(WHITESPACE_CLOSER_PAGE);
    expect(result.verdict).toBe('pass');
    expect(result.priceMatches).toBeGreaterThanOrEqual(2);
  });
});

describe('scoreCandidate — canary proposal', () => {
  it('never proposes a string containing a digit', () => {
    const html = tierPage([
      { name: 'Growth', price: '$29/mo' },
      { name: 'Enterprise', price: '$99/mo' },
    ]);
    const result = scoreCandidate(html);
    expect(result.proposedCanary).not.toBeNull();
    expect(result.proposedCanary).not.toMatch(/\d/);
  });

  it('is null when no heading qualifies at all', () => {
    const result = scoreCandidate(PRICES_NO_TIERS);
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
    await qualifyCandidates(db, { urls: ['https://acme.test/no-prices'] }, { fetcher: async () => ok(TIERS_NO_PRICES) });

    const stats = await qualifyCandidates(db, { all: true, limit: 3 }, { fetcher: async () => ok(LINEAR) });

    expect(stats.attempted).toBe(3);
    const screenedUrls = (db.prepare('SELECT url FROM candidates').all() as { url: string }[]).map(r => r.url);
    expect(new Set(screenedUrls).size).toBe(screenedUrls.length); // no duplicates
    expect(screenedUrls.length).toBe(4); // 1 pre-screened + 3 new
  });
});

// --- verify ---------------------------------------------------------------

function insertPassCandidate(url: string, name = 'Acme'): void {
  db.prepare(`
    INSERT INTO candidates (url, name, category, verdict, reason, price_matches, tier_headings, proposed_canary, http_status, screened_at)
    VALUES (?, ?, 'hosting', 'pass', 'test fixture', 3, 0, NULL, 200, '2026-08-20T00:00:00.000Z')
  `).run(url, name);
}

function tier(name: string, monthlyPriceUsd: number | null): TierData {
  return {
    name, monthly_price_usd: monthlyPriceUsd, annual_price_usd: null,
    billing_unit: 'flat', included_seats: null,
    is_free: monthlyPriceUsd === 0, is_enterprise: false, headline_features: [],
  };
}

function extractOk(tiers: TierData[], confidence: 'high' | 'medium' | 'low' = 'high'): ExtractResult {
  return {
    ok: true,
    data: { currency: 'USD', tiers, usage_rates: [], notes: null, extraction_confidence: confidence },
    inputTokens: 100, outputTokens: 50, costMicros: 350, attempts: 1,
  };
}

function extractFail(reason: 'oversized' | 'invalid' | 'ungrounded', detail: string): ExtractResult {
  return { ok: false, reason, detail };
}

/** Returns a different ExtractResult on each successive call — models the two `--verify` attempts. */
function sequence(...results: ExtractResult[]): () => Promise<ExtractResult> {
  let i = 0;
  return async () => {
    const r = results[Math.min(i, results.length - 1)]!;
    i += 1;
    return r;
  };
}

const ENABLED = { LLM_ENABLED: 'true' } as NodeJS.ProcessEnv;

describe('verifyCandidates — workflow (two-observation admission, spec 12.5)', () => {
  it('admits when both attempts agree on >=2 priced tiers', async () => {
    insertPassCandidate('https://acme.test/pricing');
    const tiers = [tier('Free', 0), tier('Pro', 29), tier('Enterprise', null)];

    const stats = await verifyCandidates(db, {}, {
      env: ENABLED,
      fetcher: async () => ok(LINEAR),
      extractor: sequence(extractOk(tiers), extractOk(tiers)),
    });

    expect(stats.admitted).toBe(1);
    expect(stats.rejected).toBe(0);

    const row = db.prepare('SELECT verdict, priced_tiers, verified_at, reason FROM candidates WHERE url = ?')
      .get('https://acme.test/pricing') as { verdict: string; priced_tiers: number; verified_at: string | null; reason: string };
    expect(row.verdict).toBe('admit');
    expect(row.priced_tiers).toBe(2); // Free ($0) and Pro ($29) — Enterprise is null, not priced
    expect(row.verified_at).not.toBeNull();
    expect(row.reason).toMatch(/both attempts agreed on 2/);
  });

  it('rejects when attempt 2 fails, naming it', async () => {
    insertPassCandidate('https://acme.test/pricing');
    const tiers = [tier('Free', 0), tier('Pro', 29)];

    const stats = await verifyCandidates(db, {}, {
      env: ENABLED,
      fetcher: async () => ok(LINEAR),
      extractor: sequence(extractOk(tiers), extractFail('invalid', 'schema parse error')),
    });

    expect(stats.rejected).toBe(1);
    expect(stats.admitted).toBe(0);

    const row = db.prepare('SELECT verdict, priced_tiers, reason FROM candidates WHERE url = ?')
      .get('https://acme.test/pricing') as { verdict: string; priced_tiers: number | null; reason: string };
    expect(row.verdict).toBe('reject');
    expect(row.priced_tiers).toBeNull();
    expect(row.reason).toMatch(/attempt 1 extracted 2 priced tiers/);
    expect(row.reason).toMatch(/attempt 2 failed: invalid: schema parse error/);
  });

  it('rejects when the two attempts disagree on the priced-tier count, naming both', async () => {
    insertPassCandidate('https://acme.test/pricing');
    const four = [tier('Free', 0), tier('Basic', 8), tier('Team', 14), tier('Business', 26)];
    const two = [tier('Free', 0), tier('Basic', 8)];

    const stats = await verifyCandidates(db, {}, {
      env: ENABLED,
      fetcher: async () => ok(LINEAR),
      extractor: sequence(extractOk(four), extractOk(two)),
    });

    expect(stats.rejected).toBe(1);

    const row = db.prepare('SELECT verdict, reason FROM candidates WHERE url = ?')
      .get('https://acme.test/pricing') as { verdict: string; reason: string };
    expect(row.verdict).toBe('reject');
    expect(row.reason).toMatch(/attempt 1 extracted 4 priced tiers/);
    expect(row.reason).toMatch(/attempt 2 extracted 2 priced tiers/);
  });

  it('rejects when either attempt self-reports low confidence, even if the counts agree', async () => {
    insertPassCandidate('https://acme.test/pricing');
    const tiers = [tier('Free', 0), tier('Pro', 29)];

    const stats = await verifyCandidates(db, {}, {
      env: ENABLED,
      fetcher: async () => ok(LINEAR),
      extractor: sequence(extractOk(tiers, 'low'), extractOk(tiers, 'high')),
    });

    expect(stats.rejected).toBe(1);
    expect(stats.admitted).toBe(0);

    const row = db.prepare('SELECT verdict, reason FROM candidates WHERE url = ?')
      .get('https://acme.test/pricing') as { verdict: string; reason: string };
    expect(row.verdict).toBe('reject');
    expect(row.reason).toMatch(/low confidence/);
  });

  it('makes no LLM call when LLM_ENABLED is not true, and touches no rows', async () => {
    insertPassCandidate('https://acme.test/pricing');
    let extractorCalled = false;

    const stats = await verifyCandidates(db, {}, {
      env: { LLM_ENABLED: 'false' } as NodeJS.ProcessEnv,
      fetcher: async () => ok(LINEAR),
      extractor: async () => { extractorCalled = true; return extractOk([tier('Free', 0), tier('Pro', 29)]); },
    });

    expect(extractorCalled).toBe(false);
    expect(stats.considered).toBe(0);

    const row = db.prepare('SELECT verdict FROM candidates WHERE url = ?').get('https://acme.test/pricing') as { verdict: string };
    expect(row.verdict).toBe('pass');
  });

  it('is idempotent: a re-run does not re-extract an already-verified candidate', async () => {
    insertPassCandidate('https://acme.test/pricing');
    let calls = 0;
    const tiers = [tier('Free', 0), tier('Pro', 29)];
    const deps = {
      env: ENABLED,
      fetcher: async () => ok(LINEAR),
      extractor: async () => { calls += 1; return extractOk(tiers); },
    };

    const first = await verifyCandidates(db, {}, deps);
    const second = await verifyCandidates(db, {}, deps);

    expect(first.admitted).toBe(1);
    expect(second.considered).toBe(0); // nothing left at verdict='pass'
    expect(calls).toBe(2); // one candidate, two attempts, zero on the second run
  });
});
