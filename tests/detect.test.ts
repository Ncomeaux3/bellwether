import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { detect } from '../src/workflow/detect.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string; let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-detect-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

/** Adds a snapshot plus its extraction. `hash` identifies the page state. */
function observe(
  day: number, hash: string, price: number | null,
  opts: { ok?: number; confidence?: 'high' | 'low'; currency?: string } = {},
) {
  const at = `2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`;
  db.prepare(`INSERT INTO snapshots
    (source_id, observed_at, fetched_at, ok, http_status, raw_content, raw_hash, normalized_hash, provenance)
    VALUES (1, ?, ?, ?, 200, 'x', ?, ?, 'live')`)
    .run(at, at, opts.ok ?? 1, `r-${hash}`, opts.ok === 0 ? null : hash);

  const exists = db.prepare('SELECT 1 FROM extractions WHERE normalized_hash = ?').get(hash);
  if (exists || opts.ok === 0) return;

  db.prepare(`INSERT INTO extractions
    (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
     is_backfill, model, prompt_version, cost_micros, created_at)
    VALUES (?, 'pricing', ?, ?, ?, 1, 0, 'claude-haiku-4-5', 'extract-pricing-v1', 9000, ?)`)
    .run(hash, JSON.stringify({
      currency: opts.currency ?? 'USD',
      tiers: [{
        name: 'Pro', monthly_price_usd: price, annual_price_usd: null,
        billing_unit: 'per_seat', included_seats: null,
        is_free: false, is_enterprise: false, headline_features: [],
      }],
      usage_rates: [], notes: null, extraction_confidence: opts.confidence ?? 'high',
    }), opts.confidence ?? 'high', opts.currency ?? 'USD', at);
}

const changes = () => db.prepare('SELECT change_type, materiality, state, observed_at FROM changes ORDER BY id')
  .all() as { change_type: string; materiality: number; state: string; observed_at: string }[];

describe('detect', () => {
  it('finds nothing from a single observation', () => {
    observe(18, 'a', 20);
    expect(detect(db, {}).created).toBe(0);
  });

  it('finds nothing when the page state repeats', () => {
    observe(18, 'a', 20); observe(19, 'a', 20); observe(20, 'a', 20);
    expect(detect(db, {}).created).toBe(0);
  });

  it('detects a price change between distinct states', () => {
    observe(18, 'a', 20); observe(19, 'b', 24);
    detect(db, {});
    const cs = changes();
    expect(cs).toHaveLength(1);
    expect(cs[0]!.change_type).toBe('price_changed');
    expect(cs[0]!.materiality).toBe(100);   // 80 + min(20, 20% move)
  });

  it('dates a change to the first snapshot showing the new state', () => {
    observe(18, 'a', 20); observe(19, 'b', 24); observe(20, 'b', 24);
    detect(db, {});
    expect(changes()[0]!.observed_at).toBe('2026-08-19T12:00:00.000Z');
  });

  it('skips failed fetches rather than treating them as change', () => {
    observe(18, 'a', 20); observe(19, 'zzz', null, { ok: 0 }); observe(20, 'a', 20);
    expect(detect(db, {}).created).toBe(0);
  });

  it('excludes non-USD extractions from diffing', () => {
    observe(18, 'a', 20); observe(19, 'b', 24, { currency: 'EUR' });
    expect(detect(db, {}).created).toBe(0);
  });

  it('is idempotent — running twice creates no duplicates', () => {
    observe(18, 'a', 20); observe(19, 'b', 24);
    detect(db, {}); detect(db, {});
    expect(changes()).toHaveLength(1);
  });

  it('records sub-threshold changes but never confirms them', () => {
    observe(18, 'a', 20);
    db.prepare("UPDATE extractions SET data_json = json_set(data_json, '$.notes', 'hello') WHERE normalized_hash = 'a'").run();
    observe(19, 'b', 20);
    detect(db, {});
    const minor = changes().filter(c => c.materiality < 40);
    expect(minor.length).toBeGreaterThan(0);
    expect(minor.every(c => c.state === 'candidate')).toBe(true);
  });

  it('rebuild deletes and re-derives, absorbing a late-inserted snapshot', () => {
    observe(18, 'a', 20); observe(20, 'c', 30);
    detect(db, {});
    expect(changes()).toHaveLength(1);

    observe(19, 'b', 24);              // backfill lands between them
    const stats = detect(db, { rebuild: true });
    expect(stats.created).toBe(2);      // a->b and b->c
    expect(changes()).toHaveLength(2);
  });

  it('leaves a completed run row', () => {
    observe(18, 'a', 20);
    detect(db, {});
    const row = db.prepare("SELECT state, ok FROM runs WHERE kind = 'detect'").get() as { state: string; ok: number };
    expect(row).toEqual({ state: 'ok', ok: 1 });
  });
});
