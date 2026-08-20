import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { collect } from '../src/workflow/collect.js';
import { ExportGuardError, exportData } from '../src/workflow/export.js';
import { SYNTH_PROMPT_VERSION } from '../src/schema/synthesis.js';
import { EXTRACT_PROMPT_VERSION } from '../src/schema/pricing.js';
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

    expect(stats.files.sort()).toEqual([
      'board.json', 'changes.json', 'changes.xml', 'competitors/acme.json', 'competitors/beta.json',
      'dataset.csv', 'dataset.json', 'digest.json', 'llms.txt', 'status.json', 'timeline.json',
    ]);
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

  it('leaves no tmp litter in either directory when a guard trips on a siteDir file', async () => {
    // llms.txt is staged last, after every outDir artifact and changes.xml —
    // tripping its shrink guard exercises cleanup across both directories at
    // once, not just outDir.
    await populate();
    exportData(db, out);
    const boardBefore = readFileSync(join(out, 'board.json'), 'utf8');
    const llmsPath = join(dir, 'llms.txt');
    writeFileSync(llmsPath, 'x'.repeat(20_000));

    expect(() => exportData(db, out)).toThrow(/shrank/i);

    for (const name of [
      'board.json', 'status.json', 'changes.json', 'timeline.json',
      'digest.json', 'dataset.json', 'dataset.csv',
      'competitors/acme.json', 'competitors/beta.json',
    ]) {
      expect(existsSync(join(out, `${name}.tmp`))).toBe(false);
    }
    expect(existsSync(join(dir, 'changes.xml.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'llms.txt.tmp'))).toBe(false);
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

  it('writes a runs row on success', async () => {
    await populate();
    exportData(db, out);

    const row = db.prepare("SELECT state, ok FROM runs WHERE kind = 'export'").get() as
      { state: string; ok: number };
    expect(row.state).toBe('ok');
    expect(row.ok).toBe(1);
  });

  it('writes a failed runs row when a guard trips, and still throws', () => {
    const empty = openDb(join(dir, 'empty.db'));
    migrate(empty, join(process.cwd(), 'migrations'));

    expect(() => exportData(empty, out)).toThrow(ExportGuardError);

    const row = empty.prepare("SELECT state, ok FROM runs WHERE kind = 'export'").get() as
      { state: string; ok: number };
    expect(row.state).toBe('failed');
    expect(row.ok).toBe(0);
    empty.close();
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

describe('exportData — distribution artifacts', () => {
  function addConfirmedChange(): number {
    db.prepare(`INSERT INTO changes
      (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
       before_json, after_json, materiality, state, observed_at)
      VALUES (1, 1, 1, 'price_changed', 'tiers.Pro.monthly_price_usd', '20', '24', 100, 'confirmed', '2026-08-18T12:00:00.000Z')`).run();
    return (db.prepare('SELECT id FROM changes ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
  }

  it('carries an annotation into changes.json when one exists at the current prompt version', () => {
    const changeId = addConfirmedChange();
    db.prepare(`INSERT INTO analyses
      (change_id, implication, so_what, confidence, model, prompt_version, created_at)
      VALUES (?, 'Competitor raised prices', 'Customers may churn', 'high', 'm', ?, '2026-08-18T12:00:00.000Z')`)
      .run(changeId, SYNTH_PROMPT_VERSION);

    exportData(db, out);
    const feed = read('changes.json');
    expect(feed.changes[0].annotation).toEqual({
      implication: 'Competitor raised prices', so_what: 'Customers may churn', confidence: 'high',
    });
  });

  it('leaves annotation null when no analysis exists at the current prompt version', () => {
    addConfirmedChange();
    exportData(db, out);
    const feed = read('changes.json');
    expect(feed.changes[0].annotation).toBeNull();
  });

  it('digest.json is null when no digest exists', () => {
    exportData(db, out);
    expect(read('digest.json').digest).toBeNull();
  });

  it('digest.json returns the newest digest, without model or cost', () => {
    db.prepare(`INSERT INTO digests
      (period_start, period_end, body_md, item_count, model, prompt_version, cost_micros, created_at)
      VALUES ('2026-08-01T00:00:00.000Z', '2026-08-07T00:00:00.000Z', 'old digest', 3, 'm', 'synthesize-v1', 1000, '2026-08-07T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO digests
      (period_start, period_end, body_md, item_count, model, prompt_version, cost_micros, created_at)
      VALUES ('2026-08-08T00:00:00.000Z', '2026-08-14T00:00:00.000Z', 'new digest', 5, 'm', 'synthesize-v1', 2000, '2026-08-14T00:00:00.000Z')`).run();

    exportData(db, out);
    const digest = read('digest.json').digest;
    expect(digest.body_markdown).toBe('new digest');
    expect(digest.item_count).toBe(5);
    expect(digest.model).toBeUndefined();
    expect(digest.cost_micros).toBeUndefined();
  });

  it('dataset.csv starts with the exact header line', () => {
    exportData(db, out);
    const csv = readFileSync(join(out, 'dataset.csv'), 'utf8');
    expect(csv.startsWith(
      'competitor,tier,first_observed_at,last_observed_at,monthly_price_usd,annual_price_usd,'
      + 'billing_unit,included_seats,is_free,is_enterprise,currency,provenance\n'
    )).toBe(true);
  });

  it('writes changes.xml to siteDir with an item for a confirmed change', () => {
    addConfirmedChange();
    exportData(db, out);
    const xml = readFileSync(join(dir, 'changes.xml'), 'utf8');
    expect(xml).toContain('<rss');
    expect(xml).toContain('<item>');
  });

  it('writes llms.txt to siteDir', () => {
    exportData(db, out);
    const llms = readFileSync(join(dir, 'llms.txt'), 'utf8');
    expect(llms).toContain('/data/dataset.json');
  });
});

describe('exportData — per-competitor payloads', () => {
  it('emits one payload per active competitor, listed in stats.files', async () => {
    await populate();
    const stats = exportData(db, out);

    expect(stats.files).toContain('competitors/acme.json');
    expect(stats.files).toContain('competitors/beta.json');
    const acme = read('competitors/acme.json');
    expect(acme.slug).toBe('acme');
    expect(acme.name).toBe('Acme');
    expect(acme.homepage).toBe('https://acme.test');
    expect(acme.source_url).toBe('https://acme.test/pricing');
  });

  it('scopes each competitor\'s payload to only that competitor\'s data', async () => {
    await populate();
    exportData(db, out);

    const acmeRaw = readFileSync(join(out, 'competitors', 'acme.json'), 'utf8');
    expect(acmeRaw).not.toContain('beta');

    const betaRaw = readFileSync(join(out, 'competitors', 'beta.json'), 'utf8');
    expect(betaRaw).not.toContain('acme');
  });

  it('carries that competitor\'s current tiers, timeline series, and confirmed changes', () => {
    // source_id 1 is acme's sole pricing source (config order: acme, then
    // beta, one source each — matches source_id 1 used the same way by the
    // 'exportData — pricing' describe above).
    const observedAt = '2026-08-18T12:00:00.000Z';
    db.prepare(`INSERT INTO snapshots
      (source_id, observed_at, fetched_at, ok, http_status, raw_content, raw_hash, normalized_hash, provenance)
      VALUES (1, ?, ?, 1, 200, 'x', 'r-h1', 'h1', 'live')`).run(observedAt, observedAt);
    db.prepare(`INSERT INTO extractions
      (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
       is_backfill, model, prompt_version, cost_micros, created_at)
      VALUES ('h1', 'pricing', ?, 'high', 'USD', 1, 0, 'm', ?, 9000, ?)`)
      .run(JSON.stringify({
        currency: 'USD',
        tiers: [{
          name: 'Pro', monthly_price_usd: 20, annual_price_usd: null,
          billing_unit: 'per_seat', included_seats: null,
          is_free: false, is_enterprise: false, headline_features: [],
        }],
        usage_rates: [], notes: null, extraction_confidence: 'high',
      }), EXTRACT_PROMPT_VERSION, observedAt);
    db.prepare(`INSERT INTO changes
      (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
       before_json, after_json, materiality, state, observed_at)
      VALUES (1, 1, 1, 'price_changed', 'tiers.Pro.monthly_price_usd', '20', '24', 100, 'confirmed', ?)`).run(observedAt);

    exportData(db, out);
    const acme = read('competitors/acme.json');

    expect(acme.current_tiers[0].name).toBe('Pro');
    expect(acme.current_tiers[0].monthly_price_usd).toBe(20);
    expect(acme.changes).toHaveLength(1);
    expect(acme.changes[0].competitor).toBe('Acme');
    expect(acme.first_observed_at).not.toBeNull();
    expect(acme.provenance).toEqual({ live: 1, wayback: 0, mixed: 0 });

    const beta = read('competitors/beta.json');
    expect(beta.current_tiers).toEqual([]);
    expect(beta.changes).toEqual([]);
  });
});
