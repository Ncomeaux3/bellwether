import type { DB } from '../ops/db.js';
import { politeFetch, RobotsCache, type FetchResult } from '../tools/fetch.js';
import { HostRateLimiter } from '../tools/ratelimit.js';
import { scoreCandidate } from '../tools/qualify.js';
import { CANDIDATES } from '../config/candidates.public.js';

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
    WHERE verdict = 'pass'
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
