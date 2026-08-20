import type { DB } from '../ops/db.js';
import { politeFetch, RobotsCache, type FetchResult } from '../tools/fetch.js';
import { HostRateLimiter } from '../tools/ratelimit.js';
import { normalizeAndSlice } from '../tools/normalize.js';
import { scoreCandidate } from '../tools/qualify.js';
import { CANDIDATES } from '../config/candidates.public.js';
import { anthropic, EXTRACT_MODEL, llmEnabled } from '../agents/_client.js';
import { extractPricing, type ExtractResult } from '../agents/extract_pricing.js';
import { EXTRACT_PROMPT_VERSION } from '../schema/pricing.js';
import { FALLBACK_COST_MICROS_PER_EXTRACTION } from './backfill.js';

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

export interface VerifyOptions { limit?: number; budgetUsd?: number }

export interface VerifyDeps {
  fetcher?: (url: string) => Promise<FetchResult>;
  extractor?: (text: string) => Promise<ExtractResult>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

/** ≥2 tiers with a non-null monthly_price_usd. "Contact sales" tiers (null) don't count — they demonstrate nothing about extractable prices. */
const MIN_PRICED_TIERS = 2;

/** Mirrors backfill.ts's DEFAULT_BACKFILL_BUDGET_USD shape: verification is deliberate one-time operator spend, budgeted separately from the recurring cap. */
export const DEFAULT_VERIFY_BUDGET_USD = 3.0;

export interface VerifyEstimate {
  pending: number;
  meanCostMicros: number;
  estimateMicros: number;
  budgetMicros: number;
  withinBudget: boolean;
}

/**
 * Fix round 3: mirrors backfill.ts's estimateBackfill exactly — same mean-cost
 * measurement, same shape — except the multiplier is x2 attempts (fix round
 * 2's two-observation admission), not x1.
 */
export function estimateVerify(db: DB, budgetUsd: number, limit?: number): VerifyEstimate {
  const pendingCount = (
    db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE verdict = 'pass'").get() as { n: number }
  ).n;
  const pending = limit === undefined ? pendingCount : Math.min(pendingCount, limit);

  const measured = (db.prepare(
    'SELECT AVG(cost_micros) AS mean FROM extractions WHERE cost_micros IS NOT NULL',
  ).get() as { mean: number | null }).mean;
  const meanCostMicros = measured && measured > 0 ? Math.round(measured) : FALLBACK_COST_MICROS_PER_EXTRACTION;

  const budgetMicros = Math.round(budgetUsd * 1e6);
  const estimateMicros = pending * meanCostMicros * 2;

  return { pending, meanCostMicros, estimateMicros, budgetMicros, withinBudget: estimateMicros <= budgetMicros };
}

export interface VerifyStats {
  considered: number; admitted: number; rejected: number; skipped: number; cached: number;
  estimate: VerifyEstimate; actualMicros: number;
}

type Attempt =
  | { ok: true; pricedTiers: number; confidence: string; costMicros: number }
  | { ok: false; reason: string };

/**
 * Runs one extraction and, on success, persists it exactly as extract.ts
 * does — content-addressed by (normalized_hash, prompt_version) — so a
 * future collect()+extract() of this now-admitted source is a free cache hit
 * if the page hasn't changed. `is_backfill = 1`: verification is deliberate
 * one-time operator spend (spec 15.2), never the recurring allowance.
 *
 * `ON CONFLICT DO NOTHING`, unlike extract.ts's insert: extract.ts only ever
 * inserts after its own cache check finds nothing, so it never collides. This
 * function is deliberately called twice against the SAME hash (the
 * reproducibility check), so the second successful attempt's insert must
 * no-op rather than violate the UNIQUE constraint extract.ts relies on.
 */
async function runAttempt(
  text: string,
  normalizedHash: string,
  runExtractor: (text: string) => Promise<ExtractResult>,
  insertExtraction: ReturnType<DB['prepare']>,
  now: () => Date,
): Promise<Attempt> {
  const result = await runExtractor(text);
  if (!result.ok) return { ok: false, reason: `${result.reason}: ${result.detail}` };

  insertExtraction.run({
    hash: normalizedHash,
    data: JSON.stringify(result.data),
    confidence: result.data.extraction_confidence,
    currency: result.data.currency,
    model: EXTRACT_MODEL,
    promptVersion: EXTRACT_PROMPT_VERSION,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costMicros: result.costMicros,
    createdAt: now().toISOString(),
  });

  return {
    ok: true,
    pricedTiers: result.data.tiers.filter(t => t.monthly_price_usd !== null).length,
    confidence: result.data.extraction_confidence,
    costMicros: result.costMicros,
  };
}

function describeAttempt(a: Attempt): string {
  if (!a.ok) return `failed: ${a.reason}`;
  const low = a.confidence === 'low' ? ' (low confidence)' : '';
  return `extracted ${a.pricedTiers} priced tier${a.pricedTiers === 1 ? '' : 's'}${low}`;
}

function pricedTiersFromDataJson(dataJson: string): number {
  const data = JSON.parse(dataJson) as { tiers: { monthly_price_usd: number | null }[] };
  return data.tiers.filter(t => t.monthly_price_usd !== null).length;
}

/**
 * Fix round 1: the pre-filter's job shrank to "could this plausibly be a
 * pricing page" (see qualify.ts). This is the real admission gate — genuine
 * `extractPricing` calls against a `pass` candidate's normalized text, the
 * same machinery `extract` uses every night, so a source is admitted because
 * it demonstrably extracts, not because a regex liked it. Re-fetches rather
 * than reusing the pre-filter's fetch: `candidates` never stored the HTML.
 *
 * Fix round 2: live evidence caught Vercel admitted on one extraction, then
 * failing outright on a second run against the same page — it extracts
 * inconsistently. Spec 12.5's two-observation rule ("a real price change
 * stays changed; a hallucination almost never reproduces") is the exact
 * principle that catches this, so admission runs the extraction TWICE
 * against the same normalized text and admits only when both attempts
 * succeed, both clear MIN_PRICED_TIERS, both agree on the count, and neither
 * self-reports low confidence. Any disagreement rejects, naming both
 * attempts, so the recorded reason shows exactly what didn't reproduce.
 *
 * Fix round 3: `--verify` now gets its own budget (`DEFAULT_VERIFY_BUDGET_USD`,
 * mirroring backfill's own one-time budget), estimated up front exactly as
 * `estimateBackfill` does and refused before any spend if the pool would
 * exceed it, then re-checked against accumulating actual spend before every
 * individual attempt so a run stops cleanly at the ceiling instead of
 * overshooting it. The recurring `assertWithinBudget` check is dropped from
 * this path entirely — every row this function writes is `is_backfill = 1`,
 * which is already invisible to `monthlySpendMicros` (see extract.ts), so
 * gating on it too would just be a second, unrelated budget system able to
 * block a run its own spend can never trip.
 *
 * A candidate whose content hash already has a cached extraction (from a
 * prior verify, or from ordinary `extract`) is resolved straight from that
 * cache — zero further LLM calls — since a successful cached extraction is
 * already proof the content extracts.
 *
 * Gated on the kill switch: skips silently (no rows touched) when
 * LLM_ENABLED isn't 'true'.
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
  const budgetUsd = opts.budgetUsd ?? DEFAULT_VERIFY_BUDGET_USD;

  const estimate = estimateVerify(db, budgetUsd, opts.limit);
  const stats: VerifyStats = {
    considered: 0, admitted: 0, rejected: 0, skipped: 0, cached: 0,
    estimate, actualMicros: 0,
  };

  if (!llmEnabled(env)) return stats;
  if (!estimate.withinBudget) return stats;

  const fetcher = deps.fetcher ?? qualifyFetcher();
  const runExtractor = deps.extractor ?? ((text: string) => extractPricing(text, { client: anthropic() as never }));

  const pending = db.prepare(`
    SELECT url FROM candidates WHERE verdict = 'pass' ORDER BY name
    ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}
  `).all() as { url: string }[];

  const findExtraction = db.prepare(
    'SELECT data_json FROM extractions WHERE normalized_hash = ? AND prompt_version = ?',
  );
  const insertExtraction = db.prepare(`
    INSERT INTO extractions
      (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
       is_backfill, model, prompt_version, input_tokens, output_tokens, cost_micros, created_at)
    VALUES (@hash, 'pricing', @data, @confidence, @currency, 1,
            1, @model, @promptVersion, @inputTokens, @outputTokens, @costMicros, @createdAt)
    ON CONFLICT (normalized_hash, prompt_version) DO NOTHING
  `);
  const update = db.prepare(`
    UPDATE candidates SET verdict = @verdict, reason = @reason, priced_tiers = @pricedTiers, verified_at = @verifiedAt
    WHERE url = @url
  `);

  const budgetMicros = estimate.budgetMicros;
  let actualMicros = 0;
  let budgetStopped = false;

  for (const row of pending) {
    stats.considered += 1;

    if (budgetStopped) { stats.skipped += 1; continue; }

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

    const { text, normalizedHash } = normalizeAndSlice(fetched.body);

    const cachedRow = findExtraction.get(normalizedHash, EXTRACT_PROMPT_VERSION) as { data_json: string } | undefined;
    if (cachedRow) {
      stats.cached += 1;
      const pricedTiers = pricedTiersFromDataJson(cachedRow.data_json);
      const admitted = pricedTiers >= MIN_PRICED_TIERS;
      if (admitted) stats.admitted += 1; else stats.rejected += 1;
      update.run({
        verdict: admitted ? 'admit' : 'reject',
        reason: `already extracted (cached): ${pricedTiers} priced tier${pricedTiers === 1 ? '' : 's'}`,
        pricedTiers: admitted ? pricedTiers : null, verifiedAt, url: row.url,
      });
      continue;
    }

    if (actualMicros >= budgetMicros) { budgetStopped = true; stats.skipped += 1; continue; }
    const attempt1 = await runAttempt(text, normalizedHash, runExtractor, insertExtraction, now);
    if (attempt1.ok) actualMicros += attempt1.costMicros;

    if (actualMicros >= budgetMicros) {
      // Can't afford the second observation — leave this candidate at
      // 'pass' (unresolved) rather than admit on a single unreplicated
      // attempt. A future budgeted run starts its two attempts fresh.
      budgetStopped = true;
      stats.skipped += 1;
      continue;
    }
    const attempt2 = await runAttempt(text, normalizedHash, runExtractor, insertExtraction, now);
    if (attempt2.ok) actualMicros += attempt2.costMicros;

    const reproduced =
      attempt1.ok && attempt2.ok &&
      attempt1.confidence !== 'low' && attempt2.confidence !== 'low' &&
      attempt1.pricedTiers === attempt2.pricedTiers &&
      attempt1.pricedTiers >= MIN_PRICED_TIERS;

    if (reproduced && attempt1.ok) {
      stats.admitted += 1;
      update.run({
        verdict: 'admit',
        reason: `both attempts agreed on ${attempt1.pricedTiers} priced tier${attempt1.pricedTiers === 1 ? '' : 's'}`,
        pricedTiers: attempt1.pricedTiers, verifiedAt, url: row.url,
      });
      continue;
    }

    stats.rejected += 1;
    update.run({
      verdict: 'reject',
      reason: `attempt 1 ${describeAttempt(attempt1)}, attempt 2 ${describeAttempt(attempt2)}`,
      pricedTiers: null, verifiedAt, url: row.url,
    });
  }

  stats.actualMicros = actualMicros;
  return stats;
}
