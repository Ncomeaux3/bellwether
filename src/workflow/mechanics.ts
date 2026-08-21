import type { DB } from '../ops/db.js';
import { MATERIALITY_THRESHOLD } from '../tools/materiality.js';
import { EXTRACT_PROMPT_VERSION } from '../schema/pricing.js';
import { monthlySpendMicros } from '../agents/_client.js';
import { stateOf, type SourceState, type SourceStateFields } from './export.js';

export interface FilterGate {
  /** This terminal category's name — every snapshot row lands in exactly one. */
  name: string;
  /** Rows classified into this category. */
  eliminated: number;
  /** Rows not yet classified after this row of the table — 0 after the last one. */
  remaining: number;
  note: string;
}

export interface FilterFunnel {
  total_snapshots: number;
  /** Real, billed model calls whose answer was recorded (category 4 below). */
  extractions_performed: number;
  llm_calls_avoided: number;
  /** Omitted (never 0 or Infinity) when total_snapshots is 0 — R4. */
  llm_calls_avoided_pct?: number;
  /**
   * Fix round 2: five mutually exclusive, collectively exhaustive terminal
   * states — every ok=1 snapshot row lands in exactly one, never two, never
   * zero. gates[].eliminated sums to total_snapshots exactly (asserted in
   * tests/mechanics.test.ts) — a page that publishes its own numbers has no
   * business showing a total that does not add up.
   */
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

export interface ScreeningCandidate {
  name: string;
  category: string;
  reason: string;
}

export interface ScreeningCategoryGroup {
  category: string;
  count: number;
  companies: string[];
}

export interface ScreeningRejectionKind {
  kind: string;
  note: string;
  count: number;
  companies: ScreeningCandidate[];
}

/**
 * Spec 11.2/14.5: the screening pool (`candidates`, M3.5) that produced the
 * watch list is itself publishable — a boundary named is a boundary the
 * reader can check. Distinct from `filter`/`coverage`/`cost` above: those
 * describe the 27 admitted sources' ongoing operation, this describes the
 * 51-company pool that was screened to find them.
 */
export interface Screening {
  total_screened: number;
  admitted: number;
  rejected: number;
  failed: number;
  errored: number;
  pass_rate_pct: number;
  admitted_by_category: ScreeningCategoryGroup[];
  rejected_by_kind: ScreeningRejectionKind[];
  failed_companies: ScreeningCandidate[];
}

export interface MechanicsPayload {
  generated_at: string;
  filter: FilterFunnel;
  coverage: Coverage;
  health: Health;
  cost: Cost;
  /** Omitted (never rendered with zeros) when `candidates` is empty — R4. */
  screening?: Screening;
}

/**
 * Ruling R4 (M6 plan): every number here comes from a query run at export
 * time. Nothing is hand-carried from a prior measurement, and a figure that
 * cannot be computed (a division by zero) is omitted, never estimated as 0.
 */
export function buildMechanics(db: DB, now: Date): MechanicsPayload {
  const generatedAt = now.toISOString();

  // ---- Filter hit rates ---------------------------------------------------
  // Fix round 2: every ok=1 snapshot row is classified into exactly one of
  // five terminal categories below — a true partition, not a funnel with
  // gates that quietly double-count or drop rows. This replaces round 1's
  // fix, which corrected the headline number but left round 1's own
  // "repeat page state" count still crediting a cache saving to rows that
  // were, in fact, independently billed (see category 5).
  const totalSnapshots = (db.prepare(
    'SELECT COUNT(*) AS n FROM snapshots WHERE ok = 1'
  ).get() as { n: number }).n;

  // Category 1 — byte-identical repeat. Content-addressed dedup at fetch
  // time (collect.ts): a page identical to the last fetch is stored as a
  // pointer (raw_content = NULL) and never reaches extract.ts's candidate
  // query at all.
  const byteIdenticalRepeats = (db.prepare(
    'SELECT COUNT(*) AS n FROM snapshots WHERE ok = 1 AND raw_content IS NULL'
  ).get() as { n: number }).n;

  // Category 5 — called and permanently rejected. extract.ts's
  // markUnextractable records `error = "extraction ${reason}: ${detail}"`
  // on the snapshot and never inserts an extractions row — the same trace
  // a call that was never made would leave (round 1's overclaim). There is
  // no cache for a failure (findExtraction only ever caches a success), so
  // unlike every other category this one is NOT collapsed by normalized
  // state: every row here, even a repeat of the same state, was its own
  // independently billed call, and must be counted as snapshot rows, never
  // distinct states. Split by reason (src/agents/extract_pricing.ts): a
  // schema-mismatch 'invalid' and 'ungrounded' only happen AFTER at least
  // one real request; the empty-slice 'invalid' is refused BEFORE any
  // request and belongs in category 3 instead. Its detail is a fixed
  // string, so excluding it by exact prefix is precise, not a heuristic.
  // error IS NOT NULL is explicit and load-bearing: `error LIKE ...` on a
  // NULL error evaluates to SQL NULL, not FALSE, and NOT (NULL) is NULL
  // too — a bare NOT REJECTED_CONDITION would then silently exclude
  // every untouched row instead of keeping it, understating every category
  // downstream of this one.
  const REJECTED_CONDITION = `(
    error IS NOT NULL AND (
      error LIKE 'extraction ungrounded:%'
      OR (error LIKE 'extraction invalid:%'
          AND error NOT LIKE 'extraction invalid: normalized slice is empty%')
    )
  )`;
  const calledAndRejected = (db.prepare(
    `SELECT COUNT(*) AS n FROM snapshots WHERE ok = 1 AND raw_content IS NOT NULL AND ${REJECTED_CONDITION}`
  ).get() as { n: number }).n;

  // Categories 2 and 4 — every remaining content-bearing row either shares
  // a normalized state with a successful extraction at the current prompt
  // version (a cache hit: category 2, genuinely free) or IS one of the rows
  // that state's one real, billed call ran against (category 4). Manual
  // curation (`error = 'curated: ...'`, a data-quality exclusion from the
  // published timeline, unrelated to cost) does not change which of these
  // a row is, so it is deliberately not filtered out here.
  const extracted = db.prepare(`
    SELECT COUNT(*) AS rows, COUNT(DISTINCT normalized_hash) AS states
    FROM snapshots s
    WHERE s.ok = 1 AND s.raw_content IS NOT NULL AND NOT ${REJECTED_CONDITION}
      AND EXISTS (
        SELECT 1 FROM extractions e
        WHERE e.prompt_version = @promptVersion AND e.normalized_hash = s.normalized_hash
      )
  `).get({ promptVersion: EXTRACT_PROMPT_VERSION }) as { rows: number; states: number };
  const calledAndSucceeded = extracted.states;                    // category 4
  const repeatAlreadyExtracted = extracted.rows - extracted.states; // category 2

  // Category 3 — short-circuited before any request, or not yet due.
  // Everything left over once the other four are accounted for: refused
  // pre-call (token budget exceeded, or no extractable text) or a state
  // extract.ts has not reached yet. Both spent nothing.
  const shortCircuitedOrPending =
    totalSnapshots - byteIdenticalRepeats - calledAndRejected - extracted.rows;

  let remainingAfter = totalSnapshots;
  const gate = (name: string, eliminated: number, note: string): FilterGate => {
    remainingAfter -= eliminated;
    return { name, eliminated, remaining: remainingAfter, note };
  };

  const gates: FilterGate[] = [
    gate(
      'Repeat fetch, byte-identical', byteIdenticalRepeats,
      'Content-addressed dedup at fetch time (collect.ts): a page identical to the last fetch is stored as a pointer, never re-examined.',
    ),
    gate(
      'Repeat page state, already extracted', repeatAlreadyExtracted,
      "Normalization collapsed this onto a state with a successful extraction already on file (extract.ts's cache) — no second call.",
    ),
    gate(
      'Short-circuited before any request', shortCircuitedOrPending,
      'Refused before a request was sent (token budget exceeded, or no extractable text), or not yet due for extraction — zero spend either way.',
    ),
    gate(
      'Called and succeeded', calledAndSucceeded,
      "A real model call ran and its answer was recorded — the archive's actual, billed extractions.",
    ),
    gate(
      'Called and rejected', calledAndRejected,
      'A real model call ran and failed grounding or schema validation, so the state was retired. There is no cache for a failure, so every row here — even a repeat of the same state — was its own separate paid call. Spend, not savings.',
    ),
  ];

  // Categories 1-3 are the only genuine savings — 4 and 5 are both real,
  // billed calls (one recorded, one not). remainingAfter is 0 here by
  // construction (asserted in tests/mechanics.test.ts): the five categories
  // partition every row exactly once.
  const llmCallsAvoided = byteIdenticalRepeats + repeatAlreadyExtracted + shortCircuitedOrPending;
  const filter: FilterFunnel = {
    total_snapshots: totalSnapshots,
    extractions_performed: calledAndSucceeded,
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

  // ---- Screening (M3.5 task 4) -------------------------------------------
  // The 51-company screening pool that produced the 27-source watch list —
  // separate from `sources`/`competitors` above, which cover only the
  // admitted set. Omitted entirely, not rendered with zeros, when the pool
  // is empty (R4): a page that has never run `qualify` has nothing to say
  // about a boundary yet, and 0/0 is not a screening result.
  const verdictCounts = db.prepare(
    'SELECT verdict, COUNT(*) AS n FROM candidates GROUP BY verdict'
  ).all() as { verdict: string; n: number }[];
  const totalScreened = verdictCounts.reduce((sum, r) => sum + r.n, 0);

  let screening: Screening | undefined;
  if (totalScreened > 0) {
    const countOf = (v: string) => verdictCounts.find(r => r.verdict === v)?.n ?? 0;
    const admitted = countOf('admit');
    const rejected = countOf('reject');
    const failed = countOf('fail');
    const errored = countOf('error');

    const admittedRows = db.prepare(
      "SELECT name, category FROM candidates WHERE verdict = 'admit' ORDER BY category, name"
    ).all() as { name: string; category: string }[];
    const categoryOrder: string[] = [];
    const byCategory = new Map<string, string[]>();
    for (const row of admittedRows) {
      if (!byCategory.has(row.category)) { byCategory.set(row.category, []); categoryOrder.push(row.category); }
      byCategory.get(row.category)!.push(row.name);
    }
    const admittedByCategory: ScreeningCategoryGroup[] = categoryOrder.map(category => ({
      category, count: byCategory.get(category)!.length, companies: byCategory.get(category)!,
    }));

    // Two kinds of rejection are actually recorded by qualify.ts's --verify
    // (src/workflow/qualify.ts): the two extraction attempts didn't
    // reproduce a plausible tier count, or at least one attempt failed
    // grounding or schema validation outright. A third kind — a fixed
    // reason string for two attempts exactly agreeing above
    // MAX_ADMIT_TIERS (a per-product/unit price list, not a plan table) —
    // is included even though it has not fired on this pool: both attempts
    // must agree exactly on a count above 8, and the closest case here
    // (Datadog: 27 vs 26 tiers) didn't. 0 is a real queried count, not a
    // placeholder, so the bucket stays rather than being hand-removed.
    const REJECTION_KINDS: { kind: string; note: string; where: string }[] = [
      {
        kind: 'Prices per product or unit, not per plan',
        note: 'Two attempts agreed, but on a count above a plausible plan table — a usage or per-product price list, not tiers.',
        where: "reason LIKE 'prices per product or unit rather than per plan%'",
      },
      {
        kind: 'Extraction failed grounding or schema',
        note: 'At least one attempt returned a price the page text did not contain, or output that failed schema validation.',
        where: "reason LIKE '%failed:%'",
      },
      {
        kind: 'Attempts did not reproduce a plausible tier count',
        note: 'Both attempts completed, but disagreed on the tier count, or agreed on a count too low to admit.',
        where: "reason LIKE 'attempt 1 extracted%attempt 2 extracted%' AND reason NOT LIKE '%failed:%'",
      },
    ];

    const rejectedByKind: ScreeningRejectionKind[] = REJECTION_KINDS.map(({ kind, note, where }) => {
      const companies = db.prepare(
        `SELECT name, category, reason FROM candidates WHERE verdict = 'reject' AND (${where}) ORDER BY name`
      ).all() as ScreeningCandidate[];
      return { kind, note, count: companies.length, companies };
    });

    const failedCompanies = db.prepare(
      "SELECT name, category, reason FROM candidates WHERE verdict = 'fail' ORDER BY name"
    ).all() as ScreeningCandidate[];

    screening = {
      total_screened: totalScreened,
      admitted, rejected, failed, errored,
      pass_rate_pct: Math.round((admitted / totalScreened) * 1000) / 10,
      admitted_by_category: admittedByCategory,
      rejected_by_kind: rejectedByKind,
      failed_companies: failedCompanies,
    };
  }

  return { generated_at: generatedAt, filter, coverage, health, cost, ...(screening ? { screening } : {}) };
}
