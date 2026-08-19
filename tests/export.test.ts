import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { collect } from '../src/workflow/collect.js';
import { ExportGuardError, exportData } from '../src/workflow/export.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let out: string;
let db: DB;

const CONFIG: CompetitorConfig[] = [
  { slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
    sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }] },
  { slug: 'beta', name: 'Beta', homepage: 'https://beta.test',
    sources: [{ kind: 'pricing', url: 'https://beta.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }] },
];

const GOOD = '<html><h2>Pro</h2><p>$20</p><h2>Enterprise</h2></html>';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-export-'));
  out = join(dir, 'data');
  mkdirSync(out, { recursive: true });
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function read(name: string): any {
  return JSON.parse(readFileSync(join(out, name), 'utf8'));
}

async function populate() {
  await collect(db, {}, {
    fetcher: async () => ({ ok: true, httpStatus: 200, body: GOOD, error: null }),
    now: () => new Date('2026-08-18T12:00:00.000Z'),
  });
}

describe('exportData', () => {
  it('writes board.json and status.json', async () => {
    await populate();
    const stats = exportData(db, out);

    expect(stats.files.sort()).toEqual(['board.json', 'changes.json', 'status.json']);
    expect(stats.competitors).toBe(2);
  });

  it('describes each competitor and source in board.json', async () => {
    await populate();
    exportData(db, out);
    const board = read('board.json');

    expect(board.competitors).toHaveLength(2);
    const acme = board.competitors.find((c: any) => c.slug === 'acme');
    expect(acme.name).toBe('Acme');
    expect(acme.sources[0].state).toBe('ok');
    expect(acme.sources[0].last_ok_at).toBe('2026-08-18T12:00:00.000Z');
    expect(acme.sources[0].distinct_states).toBe(1);
  });

  it('reports a degraded source as degraded', async () => {
    await collect(db, {}, {
      fetcher: async () => ({ ok: true, httpStatus: 200, body: '<html>nothing</html>', error: null }),
      now: () => new Date('2026-08-18T12:00:00.000Z'),
    });
    exportData(db, out);

    const board = read('board.json');
    expect(board.competitors[0].sources[0].state).toBe('degraded');
    expect(board.competitors[0].sources[0].degraded_reason).toMatch(/canary/i);
  });

  it('reports a source whose last fetch failed as failing', async () => {
    await collect(db, {}, {
      fetcher: async () => ({ ok: false, httpStatus: 503, body: null, error: 'HTTP 503' }),
      now: () => new Date('2026-08-18T12:00:00.000Z'),
    });
    exportData(db, out);

    expect(read('board.json').competitors[0].sources[0].state).toBe('failing');
  });

  it('counts healthy sources in status.json', async () => {
    await populate();
    exportData(db, out);
    const status = read('status.json');

    expect(status.total_sources).toBe(2);
    expect(status.healthy_sources).toBe(2);
    expect(status.cost_micros_month).toBe(0);
  });

  it('refuses to publish when there are no competitors', () => {
    const empty = openDb(join(dir, 'empty.db'));
    migrate(empty, join(process.cwd(), 'migrations'));

    expect(() => exportData(empty, out)).toThrow(ExportGuardError);
    empty.close();
  });

  it('refuses to publish fewer competitors than last time', async () => {
    await populate();
    exportData(db, out);

    db.prepare("UPDATE competitors SET active = 0 WHERE slug = 'beta'").run();
    expect(() => exportData(db, out)).toThrow(/fewer competitors/i);
  });

  it('refuses to publish a file that shrank by more than half', async () => {
    await populate();
    exportData(db, out);
    const boardBefore = readFileSync(join(out, 'board.json'), 'utf8');
    writeFileSync(join(out, 'status.json'), JSON.stringify({ padding: 'x'.repeat(20_000) }));

    expect(() => exportData(db, out)).toThrow(/shrank/i);

    // Spec 15.7: a guard trip mid-loop must leave no `.tmp` litter behind, and
    // any file staged before the trip (board.json here, written before the
    // status.json shrink guard fires) must be cleaned up rather than renamed.
    expect(existsSync(join(out, 'board.json.tmp'))).toBe(false);
    expect(existsSync(join(out, 'status.json.tmp'))).toBe(false);
    expect(readFileSync(join(out, 'board.json'), 'utf8')).toBe(boardBefore);
  });

  it('reports failing over degraded when the most recent snapshot failed on a source with a stale degraded_reason', () => {
    const source = db.prepare(
      "SELECT s.id FROM sources s JOIN competitors c ON c.id = s.competitor_id WHERE c.slug = 'acme'"
    ).get() as { id: number };

    // Build the tie state directly with SQL rather than driving collect()
    // twice: an older ok=1 snapshot, a stale degraded_reason left on the
    // source, then a newer ok=0 snapshot. stateOf's if-chain must resolve
    // this combination to 'failing', not 'degraded' — every row of the
    // public board renders this value.
    db.prepare(
      "INSERT INTO snapshots (source_id, observed_at, fetched_at, ok, http_status, error, raw_content, raw_hash, normalized_hash, provenance) " +
      "VALUES (?, '2026-08-18T11:00:00.000Z', '2026-08-18T11:00:00.000Z', 1, 200, NULL, ?, 'older-hash', NULL, 'live')"
    ).run(source.id, GOOD);
    db.prepare('UPDATE sources SET degraded_reason = ? WHERE id = ?')
      .run('canary string "Enterprise" missing — the page may have been redesigned', source.id);
    db.prepare(
      "INSERT INTO snapshots (source_id, observed_at, fetched_at, ok, http_status, error, raw_content, raw_hash, normalized_hash, provenance) " +
      "VALUES (?, '2026-08-18T13:00:00.000Z', '2026-08-18T13:00:00.000Z', 0, 503, 'HTTP 503', NULL, NULL, NULL, 'live')"
    ).run(source.id);

    exportData(db, out);
    const board = read('board.json');
    const acme = board.competitors.find((c: any) => c.slug === 'acme');
    expect(acme.sources[0].state).toBe('failing');
  });

  it('leaves the previous files untouched when a guard trips', async () => {
    await populate();
    exportData(db, out);
    const before = readFileSync(join(out, 'board.json'), 'utf8');

    db.prepare("UPDATE competitors SET active = 0 WHERE slug = 'beta'").run();
    expect(() => exportData(db, out)).toThrow();

    expect(readFileSync(join(out, 'board.json'), 'utf8')).toBe(before);
  });
});

describe('exportData — pricing', () => {
  function addExtraction(
    hash: string, price: number,
    opts: { currency?: string; promptVersion?: string; observedAt?: string } = {},
  ) {
    const observedAt = opts.observedAt ?? '2026-08-18T12:00:00.000Z';
    const currency = opts.currency ?? 'USD';
    const promptVersion = opts.promptVersion ?? 'extract-pricing-v1';
    db.prepare(`INSERT INTO snapshots
      (source_id, observed_at, fetched_at, ok, http_status, raw_content, raw_hash, normalized_hash, provenance)
      VALUES (1, ?, ?, 1, 200, 'x', ?, ?, 'live')`)
      .run(observedAt, observedAt, `r-${hash}`, hash);
    db.prepare(`INSERT INTO extractions
      (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
       is_backfill, model, prompt_version, cost_micros, created_at)
      VALUES (?, 'pricing', ?, 'high', ?, 1, 0, 'm', ?, 9000, ?)`)
      .run(hash, JSON.stringify({
        currency,
        tiers: [{
          name: 'Pro', monthly_price_usd: price, annual_price_usd: null,
          billing_unit: 'per_seat', included_seats: null,
          is_free: false, is_enterprise: false, headline_features: [],
        }],
        usage_rates: [], notes: null, extraction_confidence: 'high',
      }), currency, promptVersion, observedAt);
  }

  it('puts the latest tiers on the board', () => {
    addExtraction('h1', 20);
    exportData(db, out);
    const source = read('board.json').competitors.find((c: any) => c.slug === 'acme').sources[0];
    expect(source.current_pricing.tiers[0].name).toBe('Pro');
    expect(source.current_pricing.tiers[0].monthly_price_usd).toBe(20);
  });

  it('leaves current_pricing null when nothing is extracted yet', () => {
    exportData(db, out);
    const source = read('board.json').competitors.find((c: any) => c.slug === 'acme').sources[0];
    expect(source.current_pricing).toBeNull();
  });

  it('never publishes a non-USD extraction as if it were dollars', () => {
    // A geo-served EUR page for one night: this is the newest extraction, but
    // it is not in dollars, so the board must not print "$16" as fact.
    addExtraction('h1', 16, { currency: 'EUR' });
    exportData(db, out);
    const source = read('board.json').competitors.find((c: any) => c.slug === 'acme').sources[0];
    expect(source.current_pricing).toBeNull();
  });

  it('falls back to the newest USD extraction when a more recent one is non-USD', () => {
    addExtraction('h1', 20, { observedAt: '2026-08-18T12:00:00.000Z' });                       // USD, older
    addExtraction('h2', 16, { currency: 'EUR', observedAt: '2026-08-19T12:00:00.000Z' });       // EUR, newer
    exportData(db, out);
    const source = read('board.json').competitors.find((c: any) => c.slug === 'acme').sources[0];
    expect(source.current_pricing.tiers[0].monthly_price_usd).toBe(20);
  });

  it('selects the extraction under the current prompt_version, ignoring an older-version row for the same hash', () => {
    addExtraction('h1', 999, { promptVersion: 'extract-pricing-v0' });
    // Same hash, current version, inserted second — a join with no
    // prompt_version predicate would fan out and could pick either.
    db.prepare(`INSERT INTO extractions
      (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
       is_backfill, model, prompt_version, cost_micros, created_at)
      VALUES ('h1', 'pricing', ?, 'high', 'USD', 1, 0, 'm', 'extract-pricing-v1', 9000, '2026-08-18T12:00:00.000Z')`)
      .run(JSON.stringify({
        currency: 'USD',
        tiers: [{
          name: 'Pro', monthly_price_usd: 20, annual_price_usd: null,
          billing_unit: 'per_seat', included_seats: null,
          is_free: false, is_enterprise: false, headline_features: [],
        }],
        usage_rates: [], notes: null, extraction_confidence: 'high',
      }));
    exportData(db, out);
    const source = read('board.json').competitors.find((c: any) => c.slug === 'acme').sources[0];
    expect(source.current_pricing.tiers[0].monthly_price_usd).toBe(20);
  });

  it('publishes a non-zero cost_micros_month once LLM spend has actually happened', () => {
    addExtraction('h1', 20);   // cost_micros 9000, created_at inside August 2026
    exportData(db, out, { now: () => new Date('2026-08-18T12:00:00.000Z') });
    const published = read('status.json');
    expect(published.cost_micros_month).toBeGreaterThan(0);
    expect(published.cost_micros_month).toBe(9000);
  });

  it('writes changes.json carrying only confirmed material changes', () => {
    addExtraction('h1', 20);
    db.prepare(`INSERT INTO changes
      (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
       before_json, after_json, materiality, state, observed_at)
      VALUES
      (1, 1, 1, 'price_changed', 'tiers.Pro.monthly_price_usd', '20', '24', 100, 'confirmed', '2026-08-18T12:00:00.000Z'),
      (1, 1, 1, 'notes_changed', 'notes', '"a"', '"b"', 5, 'candidate', '2026-08-18T12:00:00.000Z'),
      (1, 1, 1, 'flag_changed', 'tiers.Pro.is_free', '0', '1', 100, 'candidate', '2026-08-18T12:00:00.000Z')`).run();

    const stats = exportData(db, out);
    expect(stats.files).toContain('changes.json');

    const feed = read('changes.json');
    // Isolates the state filter: this row is material (100) but not confirmed,
    // so a query that dropped `state = 'confirmed'` would still leak it in.
    expect(feed.changes.some((c: any) => c.json_path === 'tiers.Pro.is_free')).toBe(false);
    expect(feed.changes).toHaveLength(1);
    expect(feed.changes[0].change_type).toBe('price_changed');
    expect(feed.changes[0].competitor).toBe('Acme');
  });

  it('counts confirmed changes for the commit message', () => {
    addExtraction('h1', 20);
    expect(exportData(db, out).confirmedChanges).toBe(0);

    db.prepare(`INSERT INTO changes
      (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
       before_json, after_json, materiality, state, observed_at)
      VALUES
      (1, 1, 1, 'price_changed', 'tiers.Pro.monthly_price_usd', '20', '24', 100, 'confirmed', '2026-08-18T12:00:00.000Z'),
      (1, 1, 1, 'flag_changed', 'tiers.Pro.is_enterprise', '0', '1', 60, 'confirmed', '2026-08-18T12:00:00.000Z')`).run();

    expect(exportData(db, out).confirmedChanges).toBe(2);
  });
});
