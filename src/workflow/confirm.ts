import type { DB } from '../ops/db.js';
import { EXTRACT_PROMPT_VERSION, PricingSnapshot, type PricingSnapshotData } from '../schema/pricing.js';
import { MATERIALITY_THRESHOLD } from '../tools/materiality.js';
import { observationsFor } from './detect.js';

export interface ConfirmStats { examined: number; confirmed: number; disputed: number; retracted: number }

interface ChangeRow {
  id: number; source_id: number; to_snapshot_id: number;
  change_type: string;
  json_path: string; before_json: string | null; after_json: string | null;
  materiality: number; state: string;
}

interface RawObservation { normalizedHash: string; confidence: string; data: PricingSnapshotData }

/**
 * A path we cannot evaluate at all: an unknown container, or the wrong
 * number of segments for the container it names. Distinct from a genuine
 * `null` — "the array exists but the key isn't in it" (a removed usage
 * rate, a removed tier) IS a real value worth comparing, not an unknown.
 * Conflating the two inverts confirm/retract in opposite directions
 * depending on which way the conflation goes — see task-7-report.md,
 * code-review findings across both rounds.
 */
const NOT_FOUND = Symbol('valueAt/not-found');

/**
 * The only field names diff.ts ever appends after a tier name (plus the
 * synthetic 'flags'). Used to tell "this is a field access" apart from "this
 * is a whole-tier path whose dotted name got split" — see valueAt below.
 */
const TIER_FIELDS = new Set([
  'monthly_price_usd', 'annual_price_usd', 'billing_unit',
  'included_seats', 'headline_features', 'flags',
]);

/**
 * Read one JSON path out of a stored PricingSnapshot, mirroring diff.ts's
 * path grammar (diff.ts is not changed — this parses its existing format).
 *
 * Tier names are joined into the path with no escaping, so a name containing
 * '.' (e.g. "Team 2.0") splits into multiple parts. Parsed positionally:
 * `tiers.<name>` is the whole tier (tier_added/removed/renamed);
 * `tiers.<name...>.<field>` has a field access when the LAST part is a known
 * Tier field name — the name is everything between, rejoined with '.'. A
 * last part that ISN'T a known field (e.g. the "0" a dotted name like
 * "Team 2.0" splits off) means there is no field: the whole remainder is
 * the name. This disambiguation is what keeps a dotted-name whole-tier path
 * from being misread as an unmatchable field access.
 *
 * Structural rule: container missing / path malformed -> NOT_FOUND (can't
 * evaluate). Container present but the key absent -> `null` (the thing is
 * genuinely not there, which is a real value to compare).
 */
function valueAt(data: unknown, path: string): unknown {
  const parts = path.split('.');
  const container = parts[0];

  if (container === 'notes') {
    return parts.length === 1 ? (data as { notes?: unknown }).notes : NOT_FOUND;
  }

  if (container === 'usage_rates') {
    if (parts.length < 2) return NOT_FOUND;
    const metric = parts.slice(1).join('.');
    const rate = ((data as { usage_rates?: Array<{ metric: string; unit_price_usd: number }> })
      .usage_rates ?? []).find(r => r.metric === metric);
    return rate ? rate.unit_price_usd : null;   // metric genuinely absent — a real value
  }

  if (container === 'tiers') {
    if (parts.length < 2) return NOT_FOUND;
    const lastPart = parts[parts.length - 1]!;
    const hasField = parts.length > 2 && TIER_FIELDS.has(lastPart);
    const name = hasField ? parts.slice(1, -1).join('.') : parts.slice(1).join('.');
    const field = hasField ? lastPart : undefined;

    const tiers = (data as { tiers?: Array<Record<string, unknown>> }).tiers ?? [];
    const tier = tiers.find(t => t.name === name);
    if (!tier) return null;   // tier genuinely absent — a real value (matches tier_removed's after_json)
    if (!hasField) return tier;
    if (field === 'flags') return { is_free: tier.is_free, is_enterprise: tier.is_enterprise };
    return field! in tier ? tier[field!] : NOT_FOUND;
  }

  return NOT_FOUND;
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
    WHERE s.source_id = ? AND s.ok = 1 AND s.normalized_hash IS NOT NULL AND s.error IS NULL
      AND e.currency = 'USD' AND e.prompt_version = ?
      AND (s.observed_at > ? OR (s.observed_at = ? AND s.id > ?))
    ORDER BY s.observed_at, s.id
  `).all(sourceId, EXTRACT_PROMPT_VERSION, afterObservedAt, afterObservedAt, afterId) as {
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
        SELECT id, source_id, to_snapshot_id, change_type, json_path, before_json, after_json, materiality, state
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

        const actual = valueAt(next.data, change.json_path);
        if (actual === NOT_FOUND) continue;   // path doesn't resolve — can't judge, stay put

        const claimed = change.after_json === null ? null : JSON.parse(change.after_json);

        // A tier appearing or disappearing is a claim about EXISTENCE, not
        // about content. Deep-comparing the whole tier object also compares
        // `headline_features` — marketing copy that churns between captures —
        // so a removal (compared against a stable null) confirms easily while
        // an addition almost never can. That asymmetry published Postman's
        // April 2026 restructure as "Basic removed, Professional removed" with
        // no mention of the Solo and Team tiers that replaced them: a real
        // event told as a misleading half-story. Judge these on presence.
        if (change.change_type === 'tier_added' || change.change_type === 'tier_removed') {
          if ((actual !== null) === (claimed !== null)) {
            setState.run('confirmed', change.id);
            stats.confirmed += 1;
          } else {
            setState.run('retracted', change.id);
            stats.retracted += 1;
          }
          continue;
        }

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
