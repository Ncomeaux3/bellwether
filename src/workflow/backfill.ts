import type { DB } from '../ops/db.js';
import { politeFetch, RobotsCache, type FetchResult } from '../tools/fetch.js';
import { HostRateLimiter } from '../tools/ratelimit.js';
import { captureUrl, cdxQueryUrl, parseCdxResponse, waybackTimestampToIso } from '../tools/wayback.js';
import { sha256 } from '../tools/hash.js';
import { PRICE_PATTERN } from './collect.js';

/** Spec 12.1: Wayback is slow and answers 429 under load. One request per 4s. */
export const WAYBACK_MIN_INTERVAL_MS = 4_000;
export const WAYBACK_JITTER_MS = 1_000;
export const DEFAULT_BACKFILL_MONTHS = 18;

export interface BackfillDeps {
  fetcher?: (url: string) => Promise<FetchResult>;
  now?: () => Date;
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
