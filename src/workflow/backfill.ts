import type { DB } from '../ops/db.js';
import { politeFetch, RobotsCache, type FetchResult } from '../tools/fetch.js';
import { HostRateLimiter } from '../tools/ratelimit.js';
import { captureUrl, cdxQueryUrl, parseCdxResponse, waybackTimestampToIso } from '../tools/wayback.js';
import { sha256 } from '../tools/hash.js';
import { PRICE_PATTERN } from './collect.js';
import { acquireRun, finishRun } from '../ops/runs.js';
import { detect } from './detect.js';
import { extract } from './extract.js';
import { EXTRACT_PROMPT_VERSION } from '../schema/pricing.js';
import type { ExtractResult } from '../agents/extract_pricing.js';

/** Spec 12.1: Wayback is slow and answers 429 under load. One request per 4s. */
export const WAYBACK_MIN_INTERVAL_MS = 4_000;
export const WAYBACK_JITTER_MS = 1_000;
export const DEFAULT_BACKFILL_MONTHS = 18;

export interface BackfillDeps {
  fetcher?: (url: string) => Promise<FetchResult>;
  now?: () => Date;
  /** Test seam: forwarded to extract() so a test can count/stub LLM calls. */
  extractor?: (text: string) => Promise<ExtractResult>;
  /** Test seam: forwarded to extract() instead of mutating process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface DiscoverOptions { months?: number; sourceId?: number }

export interface DiscoverStats {
  sources: number; found: number; enqueued: number; duplicate: number; failed: number;
}

interface SourceRow { id: number; url: string }

/**
 * One limiter and one robots cache for the whole run.
 *
 * politeFetch() with no deps builds a FRESH HostRateLimiter per call, which
 * throttles nothing between calls. Live collection survives that because its
 * six sources are six hosts; backfill sends every request of the run to
 * web.archive.org, so a per-call limiter would hammer one host at full speed
 * and earn a 429 storm. Build this once and thread it through everything.
 */
export function waybackFetcher(): (url: string) => Promise<FetchResult> {
  const limiter = new HostRateLimiter(WAYBACK_MIN_INTERVAL_MS, WAYBACK_JITTER_MS);
  const robots = new RobotsCache({ limiter });
  return (url: string) => politeFetch(url, { limiter, robots });
}

/** CDX wants YYYYMMDD. */
function stamp(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

/**
 * Spec 12.1. Fills `backfill_queue` from the CDX timeline; never fetches a
 * capture itself. Safe to run repeatedly — the UNIQUE (source_id, wayback_ts)
 * constraint makes re-discovery a no-op, which is what keeps a half-finished
 * backfill resumable without losing the rows already drained.
 */
export async function discoverCaptures(
  db: DB,
  opts: DiscoverOptions = {},
  deps: BackfillDeps = {},
): Promise<DiscoverStats> {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? waybackFetcher();
  const months = opts.months ?? DEFAULT_BACKFILL_MONTHS;

  const stats: DiscoverStats = { sources: 0, found: 0, enqueued: 0, duplicate: 0, failed: 0 };

  const to = now();
  const from = new Date(to);
  from.setUTCMonth(from.getUTCMonth() - months);

  const sources = db.prepare(
    `SELECT id, url FROM sources WHERE active = 1 ${opts.sourceId ? 'AND id = ' + Number(opts.sourceId) : ''} ORDER BY id`,
  ).all() as SourceRow[];

  const enqueue = db.prepare(`
    INSERT INTO backfill_queue (source_id, wayback_ts, target_url, state, attempts, updated_at)
    VALUES (?, ?, ?, 'pending', 0, ?)
    ON CONFLICT (source_id, wayback_ts) DO NOTHING
  `);

  for (const source of sources) {
    stats.sources += 1;

    const result = await fetcher(cdxQueryUrl(source.url, { from: stamp(from), to: stamp(to) }));
    if (!result.ok || result.body === null) {
      // A CDX outage is not a reason to abandon the other five sources, and it
      // is not a reason to fail the run: discovery is idempotent, so the next
      // invocation picks up whatever was missed.
      stats.failed += 1;
      continue;
    }

    const captures = parseCdxResponse(result.body);
    stats.found += captures.length;

    for (const capture of captures) {
      const info = enqueue.run(
        source.id, capture.timestamp,
        captureUrl(capture.timestamp, source.url),
        now().toISOString(),
      );
      if (info.changes > 0) stats.enqueued += 1;
      else stats.duplicate += 1;
    }
  }

  return stats;
}

/**
 * politeFetch already retries 3x with backoff inside one call, so this is the
 * across-run allowance: how many separate `bellwether backfill` invocations may
 * keep trying a capture the Archive will not serve.
 */
export const MAX_CAPTURE_ATTEMPTS = 3;

export interface DrainOptions { limit?: number }

export interface DrainStats {
  claimed: number; stored: number; deduped: number; skipped: number; failed: number;
}

interface QueueRow { id: number; source_id: number; wayback_ts: string; target_url: string; attempts: number }

/**
 * Spec 12.1. Fetches queued captures one at a time and writes them as snapshots
 * dated to the capture, then leaves normalize/extract/detect to the existing
 * pipeline. Restartable: the work list is re-read from `backfill_queue` on
 * every invocation, so an interrupted run resumes exactly where it stopped.
 *
 * Deliberately does NOT touch `sources.degraded_reason` on any path (ruling
 * R3) — nothing an 18-month-old capture does is a health signal about the
 * source today.
 */
export async function drainQueue(
  db: DB,
  opts: DrainOptions = {},
  deps: BackfillDeps = {},
): Promise<DrainStats> {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? waybackFetcher();
  const stats: DrainStats = { claimed: 0, stored: 0, deduped: 0, skipped: 0, failed: 0 };

  // The whole work list is read up front rather than re-querying for "the next
  // pending row" each iteration: a failed row stays `pending` so a later run can
  // retry it, and re-querying would hand back the row we just failed, forever.
  const queue = db.prepare(`
    SELECT id, source_id, wayback_ts, target_url, attempts
    FROM backfill_queue
    WHERE state = 'pending' AND attempts < ?
    ORDER BY wayback_ts, id
    ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}
  `).all(MAX_CAPTURE_ATTEMPTS) as QueueRow[];

  const setState = db.prepare(
    'UPDATE backfill_queue SET state = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?',
  );
  const insertSnapshot = db.prepare(`
    INSERT INTO snapshots
      (source_id, observed_at, fetched_at, ok, http_status, error,
       raw_content, raw_hash, normalized_hash, provenance)
    VALUES (@sourceId, @observedAt, @fetchedAt, 1, 200, NULL,
            @rawContent, @rawHash, NULL, @provenance)
  `);
  const findHash = db.prepare(
    'SELECT id FROM snapshots WHERE source_id = ? AND raw_hash = ? LIMIT 1',
  );

  for (const row of queue) {
    stats.claimed += 1;
    const stampedAt = now().toISOString();

    const observedAt = waybackTimestampToIso(row.wayback_ts);
    if (observedAt === null) {
      // Spec 12.1's one unrecoverable mistake is dating history to today. A
      // stamp we cannot parse is dropped outright rather than guessed at.
      stats.skipped += 1;
      setState.run('skipped', row.attempts, `unparseable wayback timestamp "${row.wayback_ts}"`, stampedAt, row.id);
      continue;
    }

    const result = await fetcher(row.target_url);

    if (!result.ok || result.body === null) {
      stats.failed += 1;
      const attempts = row.attempts + 1;
      // Ruling R6: an Archive outage is evidence about the Archive, not about
      // the source. It never becomes an ok=0 snapshot.
      setState.run(
        attempts >= MAX_CAPTURE_ATTEMPTS ? 'failed' : 'pending',
        attempts, result.error ?? `HTTP ${result.httpStatus}`, stampedAt, row.id,
      );
      continue;
    }

    // Ruling R7: the Archive serves soft-404s, consent walls, and "cannot be
    // crawled" placeholders as HTTP 200. Extracting one yields an empty tier
    // list, which diff reads as every tier removed — a maximum-materiality
    // phantom. Admission gate, same test collect uses on live pages.
    if (!PRICE_PATTERN.test(result.body)) {
      stats.skipped += 1;
      setState.run('skipped', row.attempts, 'no price-like text in the capture', stampedAt, row.id);
      continue;
    }

    const rawHash = sha256(result.body);
    const seen = findHash.get(row.source_id, rawHash) as { id: number } | undefined;
    if (seen) stats.deduped += 1;
    else stats.stored += 1;

    // The insert and the queue-row update must land together: if the process
    // dies or hits SQLITE_BUSY between them, a `pending` row with unchanged
    // attempts gets re-fetched next run and a second snapshot is inserted for
    // the same capture. confirmChanges reads the non-collapsing observation
    // stream, so that duplicate reads as "observed again" and would promote a
    // change to confirmed off a single real observation.
    db.transaction(() => {
      insertSnapshot.run({
        sourceId: row.source_id,
        // Spec 12.1: the capture time, or eighteen months of history lands on
        // today's date. fetched_at matches it deliberately (ruling R5) so
        // collect's cadence gate and export's freshness queries stay correct
        // without either of them learning about provenance.
        observedAt,
        fetchedAt: observedAt,
        rawContent: seen ? null : result.body,
        rawHash,
        provenance: `wayback:${row.wayback_ts}`,
      });

      setState.run('fetched', row.attempts, null, stampedAt, row.id);
    })();
  }

  return stats;
}

/**
 * Measured 2026-08-18: six live pricing pages cost $0.0579 to extract, i.e.
 * $0.00965 each. Rounded up, and used only until the extractions table has
 * real numbers of its own.
 */
export const FALLBACK_COST_MICROS_PER_EXTRACTION = 10_000;
export const DEFAULT_BACKFILL_BUDGET_USD = 10;

export interface BackfillEstimate {
  pending: number;
  meanCostMicros: number;
  estimateMicros: number;
  budgetMicros: number;
  withinBudget: boolean;
  maxCalls: number;
}

/**
 * Spec 12.1: the corpus is costed before any of it is submitted.
 *
 * Deliberately a worst case — it assumes every queued capture is a distinct
 * page state, when content-addressed dedup (spec 7.1) means many share a hash
 * and cost nothing. `maxCalls` turns the dollar figure into a hard ceiling that
 * `extract`'s existing --limit enforces, so no new spend-guard code exists.
 *
 * `pending` means "extractions this run could have to pay for", not "queue
 * rows": it is capped by `limit` (a sliced run only drains `limit` captures)
 * and it also counts snapshots that are already drained but not yet
 * extracted — the routine backlog a sliced run leaves behind, which `extract`
 * will bill on the very next call if this estimate ignores it.
 */
export function estimateBackfill(db: DB, budgetUsd: number, limit?: number): BackfillEstimate {
  const queued = (db.prepare(
    "SELECT COUNT(*) AS n FROM backfill_queue WHERE state = 'pending' AND attempts < ?",
  ).get(MAX_CAPTURE_ATTEMPTS) as { n: number }).n;
  const queueWork = limit === undefined ? queued : Math.min(queued, limit);

  const unextracted = (db.prepare(`
    SELECT COUNT(*) AS n FROM snapshots s
    WHERE s.ok = 1 AND s.raw_content IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM extractions e
        WHERE e.normalized_hash = s.normalized_hash AND e.prompt_version = ?)
  `).get(EXTRACT_PROMPT_VERSION) as { n: number }).n;

  const pending = queueWork + unextracted;

  const measured = (db.prepare(
    'SELECT AVG(cost_micros) AS mean FROM extractions WHERE cost_micros IS NOT NULL',
  ).get() as { mean: number | null }).mean;

  const meanCostMicros = measured && measured > 0
    ? Math.round(measured)
    : FALLBACK_COST_MICROS_PER_EXTRACTION;

  const budgetMicros = Math.round(budgetUsd * 1e6);
  const estimateMicros = pending * meanCostMicros;

  return {
    pending,
    meanCostMicros,
    estimateMicros,
    budgetMicros,
    withinBudget: estimateMicros <= budgetMicros,
    maxCalls: Math.floor(budgetMicros / meanCostMicros),
  };
}

export interface RunBackfillOptions {
  months?: number;
  sourceId?: number;
  budgetUsd?: number;
  limit?: number;
  discoverOnly?: boolean;
  /** Test seam: false skips extraction entirely so no key or network is needed. */
  llmEnabled?: boolean;
}

export interface BackfillStats {
  discover: DiscoverStats;
  drain: DrainStats;
  estimate: BackfillEstimate;
  extracted: number;
  changes: number;
  confirmed: number;
}

/**
 * The whole one-shot: discover, cost, drain, extract, rebuild detection.
 *
 * Holds a single `backfill` run lock. extract and detect take their own locks
 * under different kinds, so they nest without contending. Spec 12.2 requires
 * the rebuild: backfill inserts snapshots whose observed_at falls before
 * existing live ones, so pairs that used to be adjacent no longer are and every
 * change row spanning newly-inserted history is now wrong. Re-deriving is free
 * because extractions are content-addressed.
 */
export async function runBackfill(
  db: DB,
  opts: RunBackfillOptions = {},
  deps: BackfillDeps = {},
): Promise<BackfillStats> {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? waybackFetcher();
  const budgetUsd = opts.budgetUsd ?? DEFAULT_BACKFILL_BUDGET_USD;

  const runId = acquireRun(db, 'backfill', { now });
  let stats: BackfillStats = {
    discover: { sources: 0, found: 0, enqueued: 0, duplicate: 0, failed: 0 },
    drain: { claimed: 0, stored: 0, deduped: 0, skipped: 0, failed: 0 },
    estimate: {
      pending: 0, meanCostMicros: 0, estimateMicros: 0,
      budgetMicros: 0, withinBudget: true, maxCalls: 0,
    },
    extracted: 0, changes: 0, confirmed: 0,
  };

  try {
    stats.discover = await discoverCaptures(
      db, { months: opts.months, sourceId: opts.sourceId }, { fetcher, now },
    );
    stats.estimate = estimateBackfill(db, budgetUsd, opts.limit);

    if (opts.discoverOnly) {
      finishRun(db, runId, true, stats);
      return stats;
    }

    // Refuse rather than half-spend. Discovery has already run, so raising the
    // budget and re-running costs nothing extra at the CDX layer.
    if (!stats.estimate.withinBudget) {
      finishRun(db, runId, true, stats);
      return stats;
    }

    stats.drain = await drainQueue(db, { limit: opts.limit }, { fetcher, now });

    if (opts.llmEnabled !== false) {
      const extracted = await extract(db, { limit: stats.estimate.maxCalls }, { now, env: deps.env, extractor: deps.extractor });
      stats.extracted = extracted.extracted;
    }

    const detected = detect(db, { rebuild: true, sourceId: opts.sourceId }, { now });
    stats.changes = detected.created;
    stats.confirmed = detected.confirmed;

    finishRun(db, runId, true, stats);
    return stats;
  } catch (err) {
    finishRun(db, runId, false, stats, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
