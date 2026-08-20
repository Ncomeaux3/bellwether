import type { DB } from '../ops/db.js';
import { politeFetch, RobotsCache, type FetchResult } from '../tools/fetch.js';
import { HostRateLimiter } from '../tools/ratelimit.js';
import { normalizeAndSlice } from '../tools/normalize.js';
import { scoreCandidate } from '../tools/qualify.js';
import { CANDIDATES } from '../config/candidates.public.js';
import {
  BudgetExceededError, anthropic, assertWithinBudget, llmEnabled,
} from '../agents/_client.js';
import { extractPricing, type ExtractResult } from '../agents/extract_pricing.js';

export interface QualifyOptions {
  urls?: string[];
  all?: boolean;
  limit?: number;
}

export interface QualifyDeps {
  fetcher?: (url: string) => Promise<FetchResult>;
  now?: () => Date;
}

export interface QualifyStats {
  attempted: number;
  pass: number;
  fail: number;
  error: number;
}

/**
 * One limiter and one robots cache for the whole run — the mistake `collect`
 * still has (see backfill.ts's waybackFetcher). Screening the ~50-candidate
 * pool is many hosts, but politeFetch() with no deps builds a fresh limiter
 * per call and throttles nothing across calls, so a single host repeated
 * across the pool would still be hammered.
 */
export function qualifyFetcher(): (url: string) => Promise<FetchResult> {
  const limiter = new HostRateLimiter();
  const robots = new RobotsCache({ limiter });
  return (url: string) => politeFetch(url, { limiter, robots });
}

interface CandidateEntry { url: string; name: string; category: string }

/**
 * Spec 11.2. Fetches each unscreened candidate, scores it with the pure
 * `scoreCandidate`, and upserts the result into `candidates`. A fetch
 * failure is recorded as `verdict='error'` — an unreachable site is not a
 * qualification failure and must stay distinguishable from one.
 *
 * `opts.urls` is always (re-)screened — an explicit request overrides the
 * "unscreened only" default. `opts.all` draws from the full public pool but
 * skips any URL that already has a `candidates` row, so a routine re-run of
 * `--all` doesn't re-hit sites this run has no reason to re-screen.
 */
export async function qualifyCandidates(
  db: DB,
  opts: QualifyOptions = {},
  deps: QualifyDeps = {},
): Promise<QualifyStats> {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? qualifyFetcher();
  const stats: QualifyStats = { attempted: 0, pass: 0, fail: 0, error: 0 };

  const pool = new Map(CANDIDATES.map(c => [c.url, c] as const));
  const explicitUrls = opts.urls ?? [];
  const explicitSet = new Set(explicitUrls);

  const alreadyScreened = new Set(
    (db.prepare('SELECT url FROM candidates').all() as { url: string }[]).map(r => r.url),
  );

  let entries: CandidateEntry[] = explicitUrls.map(url => {
    const known = pool.get(url);
    return { url, name: known?.name ?? url, category: known?.category ?? 'uncategorized' };
  });

  if (opts.all) {
    for (const c of CANDIDATES) {
      if (explicitSet.has(c.url) || alreadyScreened.has(c.url)) continue;
      entries.push({ url: c.url, name: c.name, category: c.category });
    }
  }

  if (opts.limit !== undefined) entries = entries.slice(0, opts.limit);

  const upsert = db.prepare(`
    INSERT INTO candidates
      (url, name, category, verdict, reason, price_matches, tier_headings,
       proposed_canary, http_status, screened_at)
    VALUES (@url, @name, @category, @verdict, @reason, @priceMatches, @tierHeadings,
            @proposedCanary, @httpStatus, @screenedAt)
    ON CONFLICT(url) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      verdict = excluded.verdict,
      reason = excluded.reason,
      price_matches = excluded.price_matches,
      tier_headings = excluded.tier_headings,
      proposed_canary = excluded.proposed_canary,
      http_status = excluded.http_status,
      screened_at = excluded.screened_at
  `);

  for (const entry of entries) {
    stats.attempted += 1;
    const result = await fetcher(entry.url);
    const screenedAt = now().toISOString();

    if (!result.ok || result.body === null) {
      stats.error += 1;
      upsert.run({
        url: entry.url, name: entry.name, category: entry.category,
        verdict: 'error', reason: result.error ?? `HTTP ${result.httpStatus}`,
        priceMatches: 0, tierHeadings: 0, proposedCanary: null,
        httpStatus: result.httpStatus, screenedAt,
      });
      continue;
    }

    const score = scoreCandidate(result.body);
    if (score.verdict === 'pass') stats.pass += 1; else stats.fail += 1;

    upsert.run({
      url: entry.url, name: entry.name, category: entry.category,
      verdict: score.verdict, reason: score.reason,
      priceMatches: score.priceMatches, tierHeadings: score.tierHeadings,
      proposedCanary: score.proposedCanary,
      httpStatus: result.httpStatus, screenedAt,
    });
  }

  return stats;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Spec 11.2: "screening results are themselves publishable" and feed Task 2.
 * Prints one `competitors.public.ts`-shaped entry per `pass` row, with the
 * proposed canary (falling back to the existing conservative "Enterprise"
 * when a page passed but produced no digit-free heading). Task 2 decides
 * whether to adopt any of it.
 */
export function emitConfig(db: DB): string {
  const rows = db.prepare(`
    SELECT url, name, category, proposed_canary
    FROM candidates
    WHERE verdict IN ('pass', 'admit')
    ORDER BY name
  `).all() as { url: string; name: string; category: string; proposed_canary: string | null }[];

  return rows.map(r => {
    const canary = r.proposed_canary ?? 'Enterprise';
    const homepage = new URL(r.url).origin;
    return [
      '  {',
      `    slug: '${slugify(r.name)}',`,
      `    name: '${r.name}',`,
      `    homepage: '${homepage}',`,
      `    // category: ${r.category}`,
      `    sources: [{ kind: 'pricing', url: '${r.url}', canaryString: '${canary}', cadenceHours: 24 }],`,
      '  },',
    ].join('\n');
  }).join('\n');
}


// --- verify --------------------------------------------------------------

export interface VerifyOptions { limit?: number }

export interface VerifyDeps {
  fetcher?: (url: string) => Promise<FetchResult>;
  extractor?: (text: string) => Promise<ExtractResult>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export interface VerifyStats { considered: number; admitted: number; rejected: number; skipped: number }

/** ≥2 tiers with a non-null monthly_price_usd. "Contact sales" tiers (null) don't count — they demonstrate nothing about extractable prices. */
const MIN_PRICED_TIERS = 2;

/**
 * Fix round 1: the pre-filter's job shrank to "could this plausibly be a
 * pricing page" (see qualify.ts). This is the real admission gate — one
 * genuine `extractPricing` call per `pass` candidate, same machinery `extract`
 * uses every night, so a source is admitted because it demonstrably extracts,
 * not because a regex liked it. Re-fetches rather than reusing the pre-filter's
 * fetch: `candidates` never stored the HTML, only the counts.
 *
 * Gated on the kill switch and the recurring budget exactly like `extract`:
 * skips silently (no rows touched) when LLM_ENABLED isn't 'true', and stops
 * admitting new spend once the monthly cap is hit, same as extract.ts.
 *
 * Idempotent: only `verdict = 'pass'` rows are selected, and a verified row
 * moves to 'admit'/'reject', so a second run finds nothing left to redo.
 */
export async function verifyCandidates(
  db: DB,
  opts: VerifyOptions = {},
  deps: VerifyDeps = {},
): Promise<VerifyStats> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const stats: VerifyStats = { considered: 0, admitted: 0, rejected: 0, skipped: 0 };

  if (!llmEnabled(env)) return stats;

  const fetcher = deps.fetcher ?? qualifyFetcher();
  const runExtractor = deps.extractor ?? ((text: string) => extractPricing(text, { client: anthropic() as never }));

  const pending = db.prepare(`
    SELECT url FROM candidates WHERE verdict = 'pass' ORDER BY name
    ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}
  `).all() as { url: string }[];

  const update = db.prepare(`
    UPDATE candidates SET verdict = @verdict, reason = @reason, priced_tiers = @pricedTiers, verified_at = @verifiedAt
    WHERE url = @url
  `);

  let budgetExhausted = false;

  for (const row of pending) {
    stats.considered += 1;

    if (!budgetExhausted) {
      try {
        assertWithinBudget(db, { now, env });
      } catch (err) {
        if (!(err instanceof BudgetExceededError)) throw err;
        budgetExhausted = true;
      }
    }
    if (budgetExhausted) { stats.skipped += 1; continue; }

    const verifiedAt = now().toISOString();
    const fetched = await fetcher(row.url);
    if (!fetched.ok || fetched.body === null) {
      stats.rejected += 1;
      update.run({
        verdict: 'reject', reason: `re-fetch failed: ${fetched.error ?? `HTTP ${fetched.httpStatus}`}`,
        pricedTiers: null, verifiedAt, url: row.url,
      });
      continue;
    }

    const { text } = normalizeAndSlice(fetched.body);
    const result = await runExtractor(text);

    if (!result.ok) {
      stats.rejected += 1;
      update.run({
        verdict: 'reject', reason: `${result.reason}: ${result.detail}`,
        pricedTiers: null, verifiedAt, url: row.url,
      });
      continue;
    }

    const pricedTiers = result.data.tiers.filter(t => t.monthly_price_usd !== null).length;
    const admitted = pricedTiers >= MIN_PRICED_TIERS;
    if (admitted) stats.admitted += 1; else stats.rejected += 1;

    update.run({
      verdict: admitted ? 'admit' : 'reject',
      reason: `extracted ${pricedTiers} priced tier${pricedTiers === 1 ? '' : 's'}`,
      pricedTiers, verifiedAt, url: row.url,
    });
  }

  return stats;
}
