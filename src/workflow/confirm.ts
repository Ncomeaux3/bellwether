import type { DB } from '../ops/db.js';
import { PricingSnapshot, type PricingSnapshotData } from '../schema/pricing.js';
import { MATERIALITY_THRESHOLD } from '../tools/materiality.js';
import { observationsFor } from './detect.js';

export interface ConfirmStats { examined: number; confirmed: number; disputed: number; retracted: number }

interface ChangeRow {
  id: number; source_id: number; to_snapshot_id: number;
  json_path: string; before_json: string | null; after_json: string | null;
  materiality: number; state: string;
}

interface RawObservation { normalizedHash: string; confidence: string; data: PricingSnapshotData }

/** Read one JSON path out of a stored PricingSnapshot, mirroring diff.ts's path grammar. */
function valueAt(data: unknown, path: string): unknown {
  const parts = path.split('.');
  if (parts[0] !== 'tiers') {
    return parts[0] === 'notes' ? (data as { notes?: unknown }).notes : undefined;
  }
  const tiers = (data as { tiers?: Array<Record<string, unknown>> }).tiers ?? [];
  const tier = tiers.find(t => t.name === parts[1]);
  if (!tier) return undefined;
  return parts.length >= 3 ? tier[parts[2]!] : tier;
}

/**
 * The literal next valid crawl for this source after (afterObservedAt, afterId),
 * WITHOUT observationsFor's dedup collapse.
 *
 * observationsFor() collapses a run of consecutive identical hashes into a
 * single observation (spec 12.2), which is exactly the information
 * confirmation needs: "the new value was crawled a second time" IS a repeat
 * of the immediately-prior hash, so it would otherwise never appear as a
 * distinct observation at all. Confirmation reads the raw snapshot stream
 * instead so a repeat is visible.
 */
function nextRawObservation(
  db: DB, sourceId: number, afterId: number, afterObservedAt: string,
): RawObservation | undefined {
  const rows = db.prepare(`
    SELECT s.id, s.normalized_hash, e.data_json, e.extraction_confidence
    FROM snapshots s
    JOIN extractions e ON e.normalized_hash = s.normalized_hash
    WHERE s.source_id = ? AND s.ok = 1 AND s.normalized_hash IS NOT NULL
      AND e.currency = 'USD'
      AND (s.observed_at > ? OR (s.observed_at = ? AND s.id > ?))
    ORDER BY s.observed_at, s.id
  `).all(sourceId, afterObservedAt, afterObservedAt, afterId) as {
    id: number; normalized_hash: string; data_json: string; extraction_confidence: string;
  }[];

  for (const row of rows) {
    const parsed = PricingSnapshot.safeParse(JSON.parse(row.data_json));
    if (!parsed.success) continue;   // malformed stored row, skip forward (mirrors observationsFor)
    return { normalizedHash: row.normalized_hash, confidence: row.extraction_confidence, data: parsed.data };
  }
  return undefined;
}

/**
 * Spec 12.5. A candidate change is not published until its new value is
 * observed a second time.
 *
 *   value persists into the next crawl                -> confirmed
 *   value reverts to what it was before                -> retracted
 *   value moves again immediately (A->B->C)            -> disputed
 *   nothing observed after it yet                      -> stays candidate
 *
 * `disputed` exists because persistence alone produces a false negative when a
 * price moves twice running: B appears once, so a real change would be dropped.
 */
export function confirmChanges(db: DB, opts: { sourceId?: number } = {}): ConfirmStats {
  const stats: ConfirmStats = { examined: 0, confirmed: 0, disputed: 0, retracted: 0 };

  const sources = db.prepare(
    `SELECT id FROM sources WHERE active = 1 ${opts.sourceId ? 'AND id = ' + Number(opts.sourceId) : ''}`,
  ).all() as { id: number }[];

  const setState = db.prepare('UPDATE changes SET state = ? WHERE id = ?');

  db.transaction(() => {
    for (const source of sources) {
      const observations = observationsFor(db, source.id);
      const indexOf = new Map(observations.map((o, i) => [o.snapshotId, i]));

      const pending = db.prepare(`
        SELECT id, source_id, to_snapshot_id, json_path, before_json, after_json, materiality, state
        FROM changes
        WHERE source_id = ? AND state IN ('candidate', 'disputed')
        ORDER BY id
      `).all(source.id) as ChangeRow[];

      for (const change of pending) {
        stats.examined += 1;

        // Sub-threshold changes are recorded but never published (spec 10).
        if (change.materiality < MATERIALITY_THRESHOLD) continue;

        const i = indexOf.get(change.to_snapshot_id);
        if (i === undefined) continue;
        const current = observations[i]!;

        const next = nextRawObservation(db, source.id, current.snapshotId, current.observedAt);
        if (!next) continue;                       // nothing has agreed or disagreed yet

        // Either side low-confidence never leaves candidate (spec 12.5).
        if (current.confidence === 'low' || next.confidence === 'low') continue;

        const claimed = change.after_json === null ? null : JSON.parse(change.after_json);
        const actual = valueAt(next.data, change.json_path) ?? null;

        if (JSON.stringify(actual) === JSON.stringify(claimed)) {
          setState.run('confirmed', change.id);
          stats.confirmed += 1;
          continue;
        }

        const priorValue = change.before_json === null ? null : JSON.parse(change.before_json);

        if (JSON.stringify(actual) === JSON.stringify(priorValue)) {
          setState.run('retracted', change.id);    // it went straight back — a phantom
          stats.retracted += 1;
        } else if (change.state !== 'disputed') {
          setState.run('disputed', change.id);     // moved again; needs a tiebreak (spec 12.5)
          stats.disputed += 1;
        }
      }
    }
  })();

  return stats;
}
