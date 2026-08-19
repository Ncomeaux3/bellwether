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
  dir = mkdtempSync(join(tmpdir(), 'bw-confirm-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function observe(day: number, hash: string, price: number, confidence: 'high' | 'low' = 'high') {
  const at = `2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`;
  db.prepare(`INSERT INTO snapshots
    (source_id, observed_at, fetched_at, ok, http_status, raw_content, raw_hash, normalized_hash, provenance)
    VALUES (1, ?, ?, 1, 200, 'x', ?, ?, 'live')`).run(at, at, `r-${hash}`, hash);

  if (db.prepare('SELECT 1 FROM extractions WHERE normalized_hash = ?').get(hash)) return;
  db.prepare(`INSERT INTO extractions
    (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
     is_backfill, model, prompt_version, cost_micros, created_at)
    VALUES (?, 'pricing', ?, ?, 'USD', 1, 0, 'm', 'extract-pricing-v1', 9000, ?)`)
    .run(hash, JSON.stringify({
      currency: 'USD',
      tiers: [{
        name: 'Pro', monthly_price_usd: price, annual_price_usd: null,
        billing_unit: 'per_seat', included_seats: null,
        is_free: false, is_enterprise: false, headline_features: [],
      }],
      usage_rates: [], notes: null, extraction_confidence: confidence,
    }), confidence, at);
}

const states = () => db.prepare(
  "SELECT state, materiality FROM changes WHERE change_type = 'price_changed' ORDER BY id",
).all() as { state: string; materiality: number }[];

describe('confirmation', () => {
  it('leaves the newest change unconfirmed — nothing has agreed with it yet', () => {
    observe(18, 'a', 20); observe(19, 'b', 24);
    detect(db, {});
    expect(states()[0]!.state).toBe('candidate');
  });

  it('confirms once the new value is observed a second time', () => {
    observe(18, 'a', 20); observe(19, 'b', 24); observe(20, 'b', 24);
    const stats = detect(db, {});
    expect(stats.confirmed).toBe(1);
    expect(states()[0]!.state).toBe('confirmed');
  });

  it('disputes a change whose value moves again immediately (A->B->C)', () => {
    observe(18, 'a', 20); observe(19, 'b', 24); observe(20, 'c', 28);
    detect(db, {});
    const s = states();
    expect(s[0]!.state).toBe('disputed');   // 20->24 never reproduced
    expect(s[1]!.state).toBe('candidate');  // 24->28 is simply the newest
  });

  it('retracts a change that reverts (A->B->A)', () => {
    observe(18, 'a', 20); observe(19, 'b', 24); observe(20, 'a', 20);
    detect(db, {});
    expect(states()[0]!.state).toBe('retracted');
  });

  it('never confirms a change when either side is low confidence', () => {
    observe(18, 'a', 20); observe(19, 'b', 24, 'low'); observe(20, 'b', 24, 'low');
    detect(db, {});
    expect(states()[0]!.state).toBe('candidate');
  });

  it('never confirms a sub-threshold change', () => {
    observe(18, 'a', 20);
    db.prepare("UPDATE extractions SET data_json = json_set(data_json, '$.notes', 'x') WHERE normalized_hash = 'a'").run();
    observe(19, 'b', 20); observe(20, 'b', 20);
    detect(db, {});
    const minor = db.prepare('SELECT state FROM changes WHERE materiality < 40').all() as { state: string }[];
    expect(minor.every(c => c.state === 'candidate')).toBe(true);
  });

  it('is idempotent — re-running does not flip a confirmed change', () => {
    observe(18, 'a', 20); observe(19, 'b', 24); observe(20, 'b', 24);
    detect(db, {});
    const second = detect(db, {});
    expect(second.confirmed).toBe(0);       // already confirmed, not re-counted
    expect(states()[0]!.state).toBe('confirmed');
  });

  it('promotes a candidate to confirmed when tomorrow agrees', () => {
    observe(18, 'a', 20); observe(19, 'b', 24);
    detect(db, {});
    expect(states()[0]!.state).toBe('candidate');

    observe(20, 'b', 24);                   // the next day agrees
    detect(db, {});
    expect(states()[0]!.state).toBe('confirmed');
  });
});
