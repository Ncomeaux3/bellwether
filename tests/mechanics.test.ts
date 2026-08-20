import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { buildMechanics } from '../src/workflow/mechanics.js';
import { EXTRACT_PROMPT_VERSION } from '../src/schema/pricing.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let db: DB;

const CONFIG: CompetitorConfig[] = [
  { slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
    sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }] },
];

const NOW = new Date('2026-08-19T12:00:00.000Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-mechanics-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function insertSnapshot(row: {
  observedAt: string; fetchedAt?: string; ok?: 0 | 1; rawContent: string | null;
  rawHash: string | null; normalizedHash: string | null; provenance?: string; error?: string;
}) {
  db.prepare(`
    INSERT INTO snapshots
      (source_id, observed_at, fetched_at, ok, http_status, error, raw_content, raw_hash, normalized_hash, provenance)
    VALUES (1, @observedAt, @fetchedAt, @ok, 200, @error, @rawContent, @rawHash, @normalizedHash, @provenance)
  `).run({
    observedAt: row.observedAt,
    fetchedAt: row.fetchedAt ?? row.observedAt,
    ok: row.ok ?? 1,
    error: row.error ?? null,
    rawContent: row.rawContent,
    rawHash: row.rawHash,
    normalizedHash: row.normalizedHash,
    provenance: row.provenance ?? 'live',
  });
}

function insertExtraction(normalizedHash: string, costMicros: number, opts: {
  promptVersion?: string; isBackfill?: 0 | 1; createdAt?: string;
} = {}) {
  db.prepare(`
    INSERT INTO extractions
      (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
       is_backfill, model, prompt_version, cost_micros, created_at)
    VALUES (?, 'pricing', '{}', 'high', 'USD', 1, ?, 'm', ?, ?, ?)
  `).run(
    normalizedHash, opts.isBackfill ?? 0, opts.promptVersion ?? EXTRACT_PROMPT_VERSION,
    costMicros, opts.createdAt ?? '2026-08-19T00:00:00.000Z',
  );
}

let changeSeq = 0;
function insertConfirmedChange(materiality = 100) {
  changeSeq += 1;
  db.prepare(`
    INSERT INTO changes
      (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
       before_json, after_json, materiality, state, observed_at)
    VALUES (1, ?, ?, 'price_changed', 'tiers.Pro.monthly_price_usd', '20', '24', ?, 'confirmed', '2026-08-19T00:00:00.000Z')
  `).run(changeSeq, changeSeq, materiality);
}

describe('buildMechanics — filter funnel', () => {
  it('derives the dedup rate exactly from a fixture with a known number of repeat snapshots', () => {
    // 5 successful snapshots: 2 byte-identical repeats (#2 of h1, #5 of h3),
    // 3 content-bearing (#1 h1/n1, #3 h2/n1 — same normalized state as #1
    // despite different raw bytes, #4 h3/n2 — a genuinely distinct state,
    // never extracted).
    insertSnapshot({ observedAt: '2026-08-01T00:00:00.000Z', rawContent: 'A', rawHash: 'h1', normalizedHash: 'n1' });
    insertSnapshot({ observedAt: '2026-08-02T00:00:00.000Z', rawContent: null, rawHash: 'h1', normalizedHash: 'n1' });
    insertSnapshot({ observedAt: '2026-08-03T00:00:00.000Z', rawContent: 'B', rawHash: 'h2', normalizedHash: 'n1' });
    insertSnapshot({ observedAt: '2026-08-04T00:00:00.000Z', rawContent: 'C', rawHash: 'h3', normalizedHash: 'n2' });
    insertSnapshot({ observedAt: '2026-08-05T00:00:00.000Z', rawContent: null, rawHash: 'h3', normalizedHash: 'n2' });

    // Only n1 has been extracted at the current prompt version — n2 is a
    // distinct state still awaiting extraction.
    insertExtraction('n1', 9000);

    const m = buildMechanics(db, NOW);

    expect(m.filter.total_snapshots).toBe(5);
    expect(m.filter.extractions_performed).toBe(1);
    expect(m.filter.llm_calls_avoided).toBe(4);
    expect(m.filter.llm_calls_avoided_pct).toBe(80);

    // Fix round 2: the five categories are a true partition — they must sum
    // to total_snapshots exactly, and the running "remaining" column must
    // reach zero. If either failed, the model would be wrong and this page
    // would have no business publishing a number.
    expect(m.filter.gates).toHaveLength(5);
    expect(m.filter.gates.reduce((sum, g) => sum + g.eliminated, 0)).toBe(m.filter.total_snapshots);
    expect(m.filter.gates.at(-1)!.remaining).toBe(0);
    for (const g of m.filter.gates) expect(g.eliminated).toBeGreaterThanOrEqual(0);

    const byName = Object.fromEntries(m.filter.gates.map(g => [g.name, g.eliminated]));
    expect(byName['Repeat fetch, byte-identical']).toBe(2);
    expect(byName['Repeat page state, already extracted']).toBe(1); // row #3
    expect(byName['Short-circuited before any request']).toBe(1);   // row #4, never yet due
    expect(byName['Called and succeeded']).toBe(1);                 // row #1 (or #3 — one call, either way)
    expect(byName['Called and rejected']).toBe(0);

    // Only categories 1-3 are genuine savings.
    expect(byName['Repeat fetch, byte-identical']! + byName['Repeat page state, already extracted']! + byName['Short-circuited before any request']!)
      .toBe(m.filter.llm_calls_avoided);
  });

  it('fix round 2: a repeat of a REJECTED state lands in "called and rejected" every time, never in "already extracted"', () => {
    // n-ok: extracted successfully — one billed call.
    insertSnapshot({ observedAt: '2026-08-01T00:00:00.000Z', rawContent: 'ok', rawHash: 'h-ok', normalizedHash: 'n-ok' });
    insertExtraction('n-ok', 5000);

    // n-rej: one distinct state, two snapshot rows. There is no cache for a
    // failure, so BOTH rows were independently billed and BOTH must count
    // as "called and rejected" — not one state collapsed the way a cached
    // success would be.
    insertSnapshot({
      observedAt: '2026-08-02T00:00:00.000Z', rawContent: 'rej1', rawHash: 'h-rej1', normalizedHash: 'n-rej',
      error: 'extraction ungrounded: tiers.Pro.monthly_price_usd invented a value not in the page text',
    });
    insertSnapshot({
      observedAt: '2026-08-03T00:00:00.000Z', rawContent: 'rej2', rawHash: 'h-rej2', normalizedHash: 'n-rej',
      error: 'extraction invalid: tiers.0.name: Required',
    });

    // n-empty: refused BEFORE any request was sent (extract_pricing.ts's
    // empty-slice guard) — genuinely free, must NOT land in "called and
    // rejected" despite sharing the 'extraction invalid:' prefix.
    insertSnapshot({
      observedAt: '2026-08-04T00:00:00.000Z', rawContent: 'x', rawHash: 'h-empty', normalizedHash: 'n-empty',
      error: 'extraction invalid: normalized slice is empty — the capture carries no extractable text',
    });

    const m = buildMechanics(db, NOW);

    expect(m.filter.total_snapshots).toBe(4);
    expect(m.filter.extractions_performed).toBe(1);
    expect(m.filter.gates.reduce((sum, g) => sum + g.eliminated, 0)).toBe(m.filter.total_snapshots);
    expect(m.filter.gates.at(-1)!.remaining).toBe(0);

    const rejectedGate = m.filter.gates.find(g => g.name === 'Called and rejected')!;
    expect(rejectedGate.eliminated).toBe(2); // both n-rej rows, not 1 state

    const cacheGate = m.filter.gates.find(g => g.name === 'Repeat page state, already extracted')!;
    expect(cacheGate.eliminated).toBe(0); // n-rej's repeat did NOT land here

    const shortCircuitGate = m.filter.gates.find(g => g.name === 'Short-circuited before any request')!;
    expect(shortCircuitGate.eliminated).toBe(1); // n-empty only

    // The rejected rows are excluded from the avoided total.
    expect(m.filter.llm_calls_avoided).toBe(1); // n-empty only (n-ok was a real call, not avoided)
  });

  it('never inflates extractions_performed with a stale row whose snapshot no longer exists', () => {
    insertSnapshot({ observedAt: '2026-08-01T00:00:00.000Z', rawContent: 'A', rawHash: 'h1', normalizedHash: 'n1' });
    insertExtraction('n1', 9000);
    // Orphan: an extraction for a hash no snapshot in the archive carries.
    insertExtraction('n-orphan', 5000);

    const m = buildMechanics(db, NOW);
    expect(m.filter.extractions_performed).toBe(1);
    expect(m.filter.llm_calls_avoided).toBeGreaterThanOrEqual(0);
    expect(m.filter.gates.reduce((sum, g) => sum + g.eliminated, 0)).toBe(m.filter.total_snapshots);
  });

  it('omits the percentage rather than dividing by zero when the archive is empty', () => {
    const m = buildMechanics(db, NOW);
    expect(m.filter.total_snapshots).toBe(0);
    expect(m.filter.llm_calls_avoided_pct).toBeUndefined();
    expect('llm_calls_avoided_pct' in m.filter).toBe(false);
    expect(m.filter.gates.reduce((sum, g) => sum + g.eliminated, 0)).toBe(0);
  });
});
describe('buildMechanics — coverage', () => {
  it('splits live vs backfilled snapshot counts and spans the archive', () => {
    insertSnapshot({ observedAt: '2026-01-15T00:00:00.000Z', rawContent: 'A', rawHash: 'h1', normalizedHash: 'n1', provenance: 'wayback:20260115000000' });
    insertSnapshot({ observedAt: '2026-03-15T00:00:00.000Z', rawContent: 'B', rawHash: 'h2', normalizedHash: 'n2', provenance: 'wayback:20260315000000' });
    insertSnapshot({ observedAt: '2026-08-19T00:00:00.000Z', rawContent: 'C', rawHash: 'h3', normalizedHash: 'n3', provenance: 'live' });

    const m = buildMechanics(db, NOW);
    expect(m.coverage.first_observed_at).toBe('2026-01-15T00:00:00.000Z');
    expect(m.coverage.last_observed_at).toBe('2026-08-19T00:00:00.000Z');
    expect(m.coverage.months_covered).toBe(3);
    expect(m.coverage.live_snapshots).toBe(1);
    expect(m.coverage.backfilled_snapshots).toBe(2);
  });
});

describe('buildMechanics — health', () => {
  it('reports source state and the latest completed run per kind, excluding the in-flight one', () => {
    db.prepare(
      "INSERT INTO runs (kind, started_at, ended_at, state, ok) VALUES ('collect', '2026-08-18T00:00:00.000Z', '2026-08-18T00:05:00.000Z', 'ok', 1)"
    ).run();
    // A run still 'running' for a kind must never be reported as its latest
    // completed run.
    db.prepare(
      "INSERT INTO runs (kind, started_at, state) VALUES ('export', '2026-08-19T12:00:00.000Z', 'running')"
    ).run();

    const m = buildMechanics(db, NOW);
    expect(m.health.sources).toEqual([{
      slug: 'acme', kind: 'pricing', url: 'https://acme.test/pricing',
      state: 'pending', last_ok_at: null, degraded_reason: null,
    }]);
    expect(m.health.runs).toEqual([{ kind: 'collect', state: 'ok', ended_at: '2026-08-18T00:05:00.000Z' }]);
  });
});

describe('buildMechanics — cost', () => {
  it('sums cumulative, monthly, and backfill spend, and computes cost per confirmed change', () => {
    insertExtraction('n1', 9000, { createdAt: '2026-08-19T00:00:00.000Z' });               // recurring, this month
    insertExtraction('n2', 15000, { isBackfill: 1, createdAt: '2026-01-01T00:00:00.000Z' }); // one-time backfill
    db.prepare(`
      INSERT INTO digests (period_start, period_end, body_md, item_count, model, prompt_version, cost_micros, created_at)
      VALUES ('2026-08-01T00:00:00.000Z', '2026-08-07T00:00:00.000Z', 'x', 1, 'm', 'synthesize-v1', 6000, '2026-08-19T00:00:00.000Z')
    `).run();
    insertConfirmedChange();
    insertConfirmedChange();

    const m = buildMechanics(db, NOW);
    expect(m.cost.cumulative_micros).toBe(9000 + 15000 + 6000);
    expect(m.cost.month_micros).toBe(9000 + 6000); // is_backfill excluded, digest included
    expect(m.cost.backfill_micros).toBe(15000);
    expect(m.cost.per_confirmed_change_micros).toBe(Math.round((9000 + 15000 + 6000) / 2));
  });

  it('omits cost per confirmed change — never zero, never Infinity — when nothing is confirmed', () => {
    insertExtraction('n1', 9000);

    const m = buildMechanics(db, NOW);
    expect(m.cost.per_confirmed_change_micros).toBeUndefined();
    expect('per_confirmed_change_micros' in m.cost).toBe(false);
  });
});
