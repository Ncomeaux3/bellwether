import type { DB } from '../ops/db.js';
import { finishRun, acquireRun } from '../ops/runs.js';
import { politeFetch, type FetchResult } from '../tools/fetch.js';
import { sha256 } from '../tools/hash.js';

export interface CollectOptions { limit?: number; dryRun?: boolean }

export interface CollectStats {
  attempted: number;
  stored: number;
  unchanged: number;
  failed: number;
  degraded: number;
  cleared: number;
}

export interface CollectDeps {
  fetcher?: (url: string) => Promise<FetchResult>;
  now?: () => Date;
}

interface DueSource {
  id: number;
  url: string;
  canary_string: string;
  degraded_reason: string | null;
}

/** A page with no currency-and-digit anywhere is not a pricing page any more. */
const PRICE_PATTERN = /[$€£]\s?\d/;

function healthProblem(body: string, canary: string): string | null {
  if (!body.includes(canary)) {
    return `canary string "${canary}" missing — the page may have been redesigned`;
  }
  if (!PRICE_PATTERN.test(body)) {
    return 'no price-like text found — the page may no longer publish prices';
  }
  return null;
}

/**
 * Spec 5.2: queries the DB for outstanding work rather than holding state.
 * Spec 11 and 7.2 govern what gets written; nothing here ever UPDATEs a
 * snapshot, so a failure can never overwrite a good one.
 */
export async function collect(
  db: DB,
  opts: CollectOptions = {},
  deps: CollectDeps = {}
): Promise<CollectStats> {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? ((url: string) => politeFetch(url));
  const stats: CollectStats = {
    attempted: 0, stored: 0, unchanged: 0, failed: 0, degraded: 0, cleared: 0,
  };

  const runId = acquireRun(db, 'collect', { now });

  try {
    const nowIso = now().toISOString();

    const due = db.prepare(`
      SELECT s.id, s.url, s.canary_string, s.degraded_reason
      FROM sources s
      WHERE s.active = 1
        AND NOT EXISTS (
          SELECT 1 FROM snapshots snap
          WHERE snap.source_id = s.id
            -- Both sides go through datetime() deliberately. We store ISO 8601
            -- with a 'T' and a 'Z'; SQLite's datetime() emits a space and no
            -- zone. Comparing the two as raw strings makes 'T' > ' ' decide
            -- same-day ties, so a source would look freshly fetched forever.
            AND datetime(snap.fetched_at) > datetime(?, '-' || s.cadence_hours || ' hours')
        )
      ORDER BY s.id
      ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}
    `).all(nowIso) as DueSource[];

    const insertSnapshot = db.prepare(`
      INSERT INTO snapshots
        (source_id, observed_at, fetched_at, ok, http_status, error,
         raw_content, raw_hash, normalized_hash, provenance)
      VALUES (@sourceId, @observedAt, @fetchedAt, @ok, @httpStatus, @error,
              @rawContent, @rawHash, NULL, 'live')
    `);
    const findHash = db.prepare(
      'SELECT id FROM snapshots WHERE source_id = ? AND raw_hash = ? LIMIT 1'
    );
    const setDegraded = db.prepare('UPDATE sources SET degraded_reason = ? WHERE id = ?');

    for (const source of due) {
      stats.attempted += 1;
      const result = await fetcher(source.url);
      const stamp = now().toISOString();

      if (opts.dryRun) continue;

      if (!result.ok || result.body === null) {
        stats.failed += 1;
        insertSnapshot.run({
          sourceId: source.id, observedAt: stamp, fetchedAt: stamp,
          ok: 0, httpStatus: result.httpStatus, error: result.error,
          rawContent: null, rawHash: null,
        });
        continue;
      }

      const problem = healthProblem(result.body, source.canary_string);
      if (problem) {
        stats.degraded += 1;
        setDegraded.run(problem, source.id);
      } else if (source.degraded_reason !== null) {
        stats.cleared += 1;
        setDegraded.run(null, source.id);
      }

      const rawHash = sha256(result.body);
      const seen = findHash.get(source.id, rawHash) as { id: number } | undefined;

      if (seen) stats.unchanged += 1;
      else stats.stored += 1;

      insertSnapshot.run({
        sourceId: source.id, observedAt: stamp, fetchedAt: stamp,
        ok: 1, httpStatus: result.httpStatus, error: null,
        rawContent: seen ? null : result.body, rawHash,
      });
    }

    finishRun(db, runId, true, stats);
    return stats;
  } catch (err) {
    finishRun(db, runId, false, stats, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
