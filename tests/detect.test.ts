import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { detect, observationsFor } from '../src/workflow/detect.js';
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

  it('reads only the extraction under EXTRACT_PROMPT_VERSION, not an older-version row sharing the hash', () => {
    observe(18, 'a', 20);   // writes under 'extract-pricing-v1' (current), price 20
    // Same hash, an older prompt version, with a different price. A join on
    // normalized_hash alone would fan out to both rows for this one snapshot.
    db.prepare(`INSERT INTO extractions
      (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
       is_backfill, model, prompt_version, cost_micros, created_at)
      VALUES ('a', 'pricing', ?, 'high', 'USD', 1, 0, 'm', 'extract-pricing-v0', 9000, '2026-08-18T12:00:00.000Z')`)
      .run(JSON.stringify({
        currency: 'USD',
        tiers: [{
          name: 'Pro', monthly_price_usd: 999, annual_price_usd: null,
          billing_unit: 'per_seat', included_seats: null,
          is_free: false, is_enterprise: false, headline_features: [],
        }],
        usage_rates: [], notes: null, extraction_confidence: 'high',
      }));

    const obs = observationsFor(db, 1);
    expect(obs).toHaveLength(1);
    expect(obs[0]!.data.tiers[0]!.monthly_price_usd).toBe(20);
  });

  it('skips a malformed stored extraction rather than guessing at it', () => {
    observe(18, 'a', 20);
    // Corrupt the stored extraction so it fails Zod validation.
    db.prepare("UPDATE extractions SET data_json = '{\"garbage\":true}' WHERE normalized_hash = 'a'").run();
    observe(19, 'b', 24);

    let stats: ReturnType<typeof detect> | undefined;
    expect(() => { stats = detect(db, {}); }).not.toThrow();
    // 'a' is unusable and skipped, so only 'b' remains — no pair, no change.
    expect(stats!.created).toBe(0);
    expect(changes()).toHaveLength(0);
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

describe('untrustworthy observations', () => {
  it('excludes a snapshot recorded as untrustworthy from pairing', () => {
    // `error` on an ok=1 row means "fetched fine, but this observation must
    // not anchor published history" — set either by a deterministic
    // extraction failure or by deliberate curation of a verified-wrong
    // extraction. The row and its extraction are kept (spec 7.1 discards
    // nothing); the series just breaks there (spec 14.3).
    observe(20, 'h1', 10);
    observe(21, 'h2', 20);
    detect(db, { rebuild: true });
    expect(observationsFor(db, 1)).toHaveLength(2);

    db.prepare("UPDATE snapshots SET error = 'curated: verified wrong' WHERE normalized_hash = 'h2'").run();

    const after = observationsFor(db, 1);
    expect(after).toHaveLength(1);
    expect(after[0]!.normalizedHash).toBe('h1');
    // nothing was deleted
    expect((db.prepare("SELECT COUNT(*) n FROM extractions WHERE normalized_hash='h2'").get() as { n: number }).n).toBe(1);
  });
});

describe('analyses across --rebuild (spec 12.2)', () => {
  function annotate(changeId: number): void {
    db.prepare(`INSERT INTO analyses
      (change_id, implication, so_what, confidence, model, prompt_version, created_at)
      VALUES (?, 'price up 25%', 'entry tier repriced', 'high', 'm', 'synth-v1', '2026-08-18T00:00:00.000Z')`)
      .run(changeId);
  }

  it('re-links an annotation whose change survives rebuild', () => {
    observe(20, 'h1', 10);
    observe(21, 'h2', 20);
    detect(db, {});
    const change = db.prepare("SELECT id FROM changes WHERE change_type='price_changed'").get() as { id: number };
    annotate(change.id);

    const stats = detect(db, { rebuild: true });

    const relinked = db.prepare(`
      SELECT a.change_id, c.json_path, a.created_at, a.model, a.prompt_version
      FROM analyses a JOIN changes c ON c.id = a.change_id
    `).all() as { change_id: number; json_path: string; created_at: string; model: string; prompt_version: string }[];
    expect(relinked).toHaveLength(1);
    expect(relinked[0]!.json_path).toBe('tiers.Pro.monthly_price_usd');
    // identity fidelity: a re-link must not look like a fresh annotation —
    // the parked row's original created_at/model/prompt_version survive.
    expect(relinked[0]!.created_at).toBe('2026-08-18T00:00:00.000Z');
    expect(relinked[0]!.model).toBe('m');
    expect(relinked[0]!.prompt_version).toBe('synth-v1');
    expect(stats.relinked).toBe(1);
    expect(stats.orphaned).toBe(0);
  });

  it('reinserts across a shared (json_path, observed_at) without throwing on the UNIQUE constraint', () => {
    observe(20, 'h1', 10);
    observe(21, 'h2', 20);
    observe(21, 'h3', 30); // same day as h2, different hash: two pairs both land on this observed_at
    detect(db, {});

    const colliding = db.prepare(`
      SELECT id, observed_at FROM changes
      WHERE change_type = 'price_changed' AND json_path = 'tiers.Pro.monthly_price_usd'
      ORDER BY id
    `).all() as { id: number; observed_at: string }[];
    expect(colliding).toHaveLength(2);
    expect(colliding[0]!.observed_at).toBe(colliding[1]!.observed_at);
    annotate(colliding[0]!.id);
    annotate(colliding[1]!.id);

    let stats: ReturnType<typeof detect> | undefined;
    expect(() => { stats = detect(db, { rebuild: true }); }).not.toThrow();

    expect(stats!.relinked).toBe(1);
    expect(stats!.orphaned).toBe(1);

    const survivor = db.prepare(`
      SELECT id FROM changes WHERE json_path = 'tiers.Pro.monthly_price_usd' AND observed_at = ?
      ORDER BY id LIMIT 1
    `).get(colliding[0]!.observed_at) as { id: number };
    const rows = db.prepare('SELECT change_id FROM analyses').all() as { change_id: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.change_id).toBe(survivor.id);
  });

  it('deletes an annotation whose change does not survive', () => {
    observe(20, 'h1', 10);
    observe(21, 'h2', 20);
    detect(db, {});
    const change = db.prepare("SELECT id FROM changes WHERE change_type='price_changed'").get() as { id: number };
    annotate(change.id);

    // the second observation becomes untrustworthy, so the pair vanishes on rebuild
    db.prepare("UPDATE snapshots SET error = 'curated: verified wrong' WHERE normalized_hash = 'h2'").run();
    const stats = detect(db, { rebuild: true });

    expect((db.prepare('SELECT COUNT(*) n FROM analyses').get() as { n: number }).n).toBe(0);
    expect(stats.orphaned).toBe(1);
    expect(stats.relinked).toBe(0);
  });

  it('rebuild without any analyses is unchanged', () => {
    observe(20, 'h1', 10);
    observe(21, 'h2', 20);
    detect(db, {});
    const stats = detect(db, { rebuild: true });
    expect(stats.relinked).toBe(0);
    expect(stats.orphaned).toBe(0);
  });
});
