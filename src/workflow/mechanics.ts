import type { DB } from '../ops/db.js';
import { MATERIALITY_THRESHOLD } from '../tools/materiality.js';
import { EXTRACT_PROMPT_VERSION } from '../schema/pricing.js';
import { monthlySpendMicros } from '../agents/_client.js';
import { stateOf, type SourceState, type SourceStateFields } from './export.js';

export interface FilterGate {
  /** What this gate filters out. */
  name: string;
  /** How many candidates this gate removed from the funnel. */
  eliminated: number;
  /** How many candidates survive to the next gate. */
  remaining: number;
  note: string;
}

export interface FilterFunnel {
  total_snapshots: number;
  byte_identical_repeats: number;
  distinct_normalized_states: number;
  extractions_performed: number;
  llm_calls_avoided: number;
  /** Omitted (never 0 or Infinity) when total_snapshots is 0 — R4. */
  llm_calls_avoided_pct?: number;
  gates: FilterGate[];
}

export interface Coverage {
  first_observed_at: string | null;
  last_observed_at: string | null;
  months_covered: number;
  live_snapshots: number;
  backfilled_snapshots: number;
}

export interface SourceHealthRow {
  slug: string;
  kind: string;
  url: string;
  state: SourceState;
  last_ok_at: string | null;
  degraded_reason: string | null;
}

export interface RunHealthRow {
  kind: string;
  state: string;
  ended_at: string | null;
}

export interface Health {
  sources: SourceHealthRow[];
  runs: RunHealthRow[];
}

export interface Cost {
  cumulative_micros: number;
  month_micros: number;
  backfill_micros: number;
  /** Omitted (never 0 or Infinity) when there are no confirmed changes — R4. */
  per_confirmed_change_micros?: number;
}

export interface MechanicsPayload {
  generated_at: string;
  filter: FilterFunnel;
  coverage: Coverage;
  health: Health;
  cost: Cost;
}

/**
 * Ruling R4 (M6 plan): every number here comes from a query run at export
 * time. Nothing is hand-carried from a prior measurement, and a figure that
 * cannot be computed (a division by zero) is omitted, never estimated as 0.
 */
export function buildMechanics(db: DB, now: Date): MechanicsPayload {
  const generatedAt = now.toISOString();

  // ---- Filter hit rates ---------------------------------------------------
  // The funnel candidate pool is every successful fetch (ok = 1). A failed
  // fetch never had content to filter, so it never entered the cost-filter
  // story at all.
  const totalSnapshots = (db.prepare(
    'SELECT COUNT(*) AS n FROM snapshots WHERE ok = 1'
  ).get() as { n: number }).n;

  // Gate 1: content-addressed dedup at fetch time (collect.ts) — a byte-
  // identical repeat of a prior fetch is stored with raw_content = NULL and
  // never reaches extract.ts's candidate query at all.
  const byteIdenticalRepeats = (db.prepare(
    'SELECT COUNT(*) AS n FROM snapshots WHERE ok = 1 AND raw_content IS NULL'
  ).get() as { n: number }).n;
  const snapshotsWithContent = totalSnapshots - byteIdenticalRepeats;

  // Gate 2: normalization (tools/normalize.ts) collapses page noise — two
  // fetches with different raw bytes (a timestamp, an ad slot) but the same
  // priced content share a normalized_hash. Counted over content-bearing
  // snapshots only, so it is exactly gate 1's remainder.
  const distinctNormalizedStates = (db.prepare(`
    SELECT COUNT(DISTINCT normalized_hash) AS n FROM snapshots
    WHERE ok = 1 AND raw_content IS NOT NULL AND normalized_hash IS NOT NULL
  `).get() as { n: number }).n;

  // Gate 3: the extraction cache (extract.ts's findExtraction check) — a
  // normalized state already extracted at this prompt version needs no
  // second LLM call. Bounded to normalized_hash values a snapshot in today's
  // archive actually carries, so a stale extraction row left behind by a
  // long-since-superseded snapshot can never inflate this above what gate 2
  // produced.
  const extractionsPerformed = (db.prepare(`
    SELECT COUNT(*) AS n FROM extractions e
    WHERE e.prompt_version = @promptVersion
      AND EXISTS (
        SELECT 1 FROM snapshots s
        WHERE s.ok = 1 AND s.raw_content IS NOT NULL AND s.normalized_hash = e.normalized_hash
      )
  `).get({ promptVersion: EXTRACT_PROMPT_VERSION }) as { n: number }).n;

  const gates: FilterGate[] = [
    {
      name: 'Repeat fetch, byte-identical',
      eliminated: byteIdenticalRepeats,
      remaining: snapshotsWithContent,
      note: 'Content-addressed dedup at fetch time (collect.ts): a page identical to the last fetch is stored as a pointer, never re-examined.',
    },
    {
      name: 'Repeat page state after noise removed',
      eliminated: snapshotsWithContent - distinctNormalizedStates,
      remaining: distinctNormalizedStates,
      note: 'Normalization collapses cosmetic differences (timestamps, ad slots) that changed the bytes but not the priced content.',
    },
    {
      name: 'Already extracted at this prompt version',
      eliminated: distinctNormalizedStates - extractionsPerformed,
      remaining: extractionsPerformed,
      note: 'A normalized state already on file, or not yet due for extraction, needs no fresh model call.',
    },
  ];

  const llmCallsAvoided = totalSnapshots - extractionsPerformed;
  const filter: FilterFunnel = {
    total_snapshots: totalSnapshots,
    byte_identical_repeats: byteIdenticalRepeats,
    distinct_normalized_states: distinctNormalizedStates,
    extractions_performed: extractionsPerformed,
    llm_calls_avoided: llmCallsAvoided,
    ...(totalSnapshots > 0
      ? { llm_calls_avoided_pct: Math.round((llmCallsAvoided / totalSnapshots) * 1000) / 10 }
      : {}),
    gates,
  };

  // ---- Coverage -------------------------------------------------------------
  const span = db.prepare(
    'SELECT MIN(observed_at) AS first, MAX(observed_at) AS last FROM snapshots WHERE ok = 1'
  ).get() as { first: string | null; last: string | null };
  const monthsCovered = (db.prepare(
    "SELECT COUNT(DISTINCT substr(observed_at, 1, 7)) AS n FROM snapshots WHERE ok = 1"
  ).get() as { n: number }).n;
  const liveSnapshots = (db.prepare(
    "SELECT COUNT(*) AS n FROM snapshots WHERE ok = 1 AND provenance = 'live'"
  ).get() as { n: number }).n;
  const backfilledSnapshots = (db.prepare(
    "SELECT COUNT(*) AS n FROM snapshots WHERE ok = 1 AND provenance LIKE 'wayback:%'"
  ).get() as { n: number }).n;

  const coverage: Coverage = {
    first_observed_at: span.first,
    last_observed_at: span.last,
    months_covered: monthsCovered,
    live_snapshots: liveSnapshots,
    backfilled_snapshots: backfilledSnapshots,
  };

  // ---- Health -----------------------------------------------------------
  const sourceRows = db.prepare(`
    SELECT c.slug, s.kind, s.url, s.degraded_reason,
      (SELECT MAX(fetched_at) FROM snapshots WHERE source_id = s.id) AS last_checked_at,
      (SELECT MAX(fetched_at) FROM snapshots WHERE source_id = s.id AND ok = 1) AS last_ok_at,
      (SELECT ok FROM snapshots WHERE source_id = s.id ORDER BY fetched_at DESC, id DESC LIMIT 1) AS last_ok_flag
    FROM sources s
    JOIN competitors c ON c.id = s.competitor_id
    WHERE s.active = 1 AND c.active = 1
    ORDER BY c.name, s.kind
  `).all() as (SourceStateFields & { slug: string; kind: string; url: string; last_ok_at: string | null })[];

  const sources: SourceHealthRow[] = sourceRows.map(row => ({
    slug: row.slug,
    kind: row.kind,
    url: row.url,
    state: stateOf(row),
    last_ok_at: row.last_ok_at,
    degraded_reason: row.degraded_reason,
  }));

  // Latest COMPLETED run per kind. 'running' rows are excluded deliberately:
  // buildMechanics runs while this very export is mid-flight, and its own
  // 'export' row would otherwise always report itself as still running.
  const runs = db.prepare(`
    SELECT kind, state, ended_at FROM runs r
    WHERE state != 'running'
      AND id = (SELECT MAX(id) FROM runs r2 WHERE r2.kind = r.kind AND r2.state != 'running')
    ORDER BY kind
  `).all() as RunHealthRow[];

  const health: Health = { sources, runs };

  // ---- Cost ---------------------------------------------------------------
  const cumulativeMicros = (db.prepare(`
    SELECT COALESCE(SUM(cost_micros), 0) AS total FROM (
      SELECT cost_micros FROM extractions
      UNION ALL
      SELECT cost_micros FROM digests
    )
  `).get() as { total: number }).total;
  const monthMicros = monthlySpendMicros(db, now);
  const backfillMicros = (db.prepare(
    'SELECT COALESCE(SUM(cost_micros), 0) AS total FROM extractions WHERE is_backfill = 1'
  ).get() as { total: number }).total;
  const confirmedChanges = (db.prepare(
    'SELECT COUNT(*) AS n FROM changes WHERE state = ? AND materiality >= ?'
  ).get('confirmed', MATERIALITY_THRESHOLD) as { n: number }).n;

  const cost: Cost = {
    cumulative_micros: cumulativeMicros,
    month_micros: monthMicros,
    backfill_micros: backfillMicros,
    ...(confirmedChanges > 0
      ? { per_confirmed_change_micros: Math.round(cumulativeMicros / confirmedChanges) }
      : {}),
  };

  return { generated_at: generatedAt, filter, coverage, health, cost };
}
