import type { DB } from '../ops/db.js';
import { acquireRun, finishRun } from '../ops/runs.js';
import { PricingSnapshot, type PricingSnapshotData } from '../schema/pricing.js';
import { diffPricing } from '../tools/diff.js';
import { MATERIALITY_THRESHOLD, scoreMateriality } from '../tools/materiality.js';

export interface DetectOptions { rebuild?: boolean; sourceId?: number }

export interface DetectStats {
  sources: number; pairs: number; created: number;
  confirmed: number; disputed: number; retracted: number;
}

export interface DetectDeps { now?: () => Date }

/** One observation of a distinct page state, with its parsed extraction. */
export interface Observation {
  snapshotId: number;
  observedAt: string;
  normalizedHash: string;
  confidence: string;
  data: PricingSnapshotData;
}

/**
 * Spec 12.2 pairing rule. Only ok=1 rows with a normalized_hash; each *distinct*
 * consecutive hash pairs with the next; repeated hashes collapse to one state,
 * and the state is dated to the FIRST snapshot exhibiting it.
 *
 * Only USD extractions participate (spec 12.4) — a geo-served EUR page is a
 * collection anomaly, not a pricing event.
 */
export function observationsFor(db: DB, sourceId: number): Observation[] {
  const rows = db.prepare(`
    SELECT s.id, s.observed_at, s.normalized_hash,
           e.data_json, e.extraction_confidence, e.currency
    FROM snapshots s
    JOIN extractions e ON e.normalized_hash = s.normalized_hash
    WHERE s.source_id = ? AND s.ok = 1 AND s.normalized_hash IS NOT NULL
      AND e.currency = 'USD'
    ORDER BY s.observed_at, s.id
  `).all(sourceId) as {
    id: number; observed_at: string; normalized_hash: string;
    data_json: string; extraction_confidence: string;
  }[];

  const observations: Observation[] = [];
  for (const row of rows) {
    const previous = observations[observations.length - 1];
    if (previous?.normalizedHash === row.normalized_hash) continue;   // collapse repeats

    const parsed = PricingSnapshot.safeParse(JSON.parse(row.data_json));
    if (!parsed.success) continue;   // a malformed stored row is skipped, never guessed at

    observations.push({
      snapshotId: row.id,
      observedAt: row.observed_at,
      normalizedHash: row.normalized_hash,
      confidence: row.extraction_confidence,
      data: parsed.data,
    });
  }
  return observations;
}

export function detect(db: DB, opts: DetectOptions = {}, deps: DetectDeps = {}): DetectStats {
  const now = deps.now ?? (() => new Date());
  const stats: DetectStats = { sources: 0, pairs: 0, created: 0, confirmed: 0, disputed: 0, retracted: 0 };
  const runId = acquireRun(db, 'detect', { now });

  try {
    const sources = db.prepare(
      `SELECT id FROM sources WHERE active = 1 ${opts.sourceId ? 'AND id = ' + Number(opts.sourceId) : ''}`,
    ).all() as { id: number }[];

    const wipe = db.prepare('DELETE FROM changes WHERE source_id = ?');
    const insert = db.prepare(`
      INSERT INTO changes
        (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
         before_json, after_json, materiality, state, observed_at)
      VALUES (@sourceId, @from, @to, @type, @path, @before, @after, @materiality, 'candidate', @observedAt)
      ON CONFLICT (source_id, from_snapshot_id, to_snapshot_id, json_path) DO NOTHING
    `);

    db.transaction(() => {
      for (const source of sources) {
        stats.sources += 1;
        // Spec 12.2: backfill invalidates prior detection, so rebuild re-derives
        // from scratch. Free, because extractions are content-addressed.
        if (opts.rebuild) wipe.run(source.id);

        const observations = observationsFor(db, source.id);
        for (let i = 1; i < observations.length; i += 1) {
          const before = observations[i - 1]!;
          const after = observations[i]!;
          stats.pairs += 1;

          for (const change of diffPricing(before.data, after.data)) {
            const info = insert.run({
              sourceId: source.id,
              from: before.snapshotId,
              to: after.snapshotId,
              type: change.change_type,
              path: change.json_path,
              before: change.before_json,
              after: change.after_json,
              materiality: scoreMateriality(change),
              observedAt: after.observedAt,
            });
            if (info.changes > 0) stats.created += 1;
          }
        }
      }
    })();

    // Confirmation (spec 12.5) is wired in by Task 7; until then these stay 0.

    finishRun(db, runId, true, stats);
    return stats;
  } catch (err) {
    finishRun(db, runId, false, stats, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export { MATERIALITY_THRESHOLD };
