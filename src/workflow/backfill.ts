import type { DB } from '../ops/db.js';
import { politeFetch, RobotsCache, type FetchResult } from '../tools/fetch.js';
import { HostRateLimiter } from '../tools/ratelimit.js';
import { captureUrl, cdxQueryUrl, parseCdxResponse } from '../tools/wayback.js';

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
