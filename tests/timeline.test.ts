import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { buildTimeline, TIMELINE_GAP_DAYS } from '../src/workflow/export.js';
import { EXTRACT_PROMPT_VERSION } from '../src/schema/pricing.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

const GENERATED = '2026-08-19T07:00:00.000Z';

/** Insert one observed page state: a snapshot plus the extraction it hashes to. */
function observe(observedAt: string, tiers: { name: string; price: number | null }[], hash = observedAt): void {
  db.prepare(`
    INSERT INTO snapshots
      (source_id, observed_at, fetched_at, ok, http_status, error,
       raw_content, raw_hash, normalized_hash, provenance)
    VALUES (1, ?, ?, 1, 200, NULL, NULL, ?, ?, 'wayback:x')
  `).run(observedAt, observedAt, `raw-${hash}`, hash);

  const data = {
    tiers: tiers.map(t => ({
      name: t.name, monthly_price_usd: t.price, annual_price_usd: null,
      billing_unit: 'unknown', included_seats: null, headline_features: [],
      is_free: t.price === 0, is_enterprise: false,
    })),
    usage_rates: [], currency: 'USD', notes: null, extraction_confidence: 'high',
  };

  db.prepare(`
    INSERT INTO extractions
      (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
       is_backfill, model, prompt_version, input_tokens, output_tokens, cost_micros, created_at)
    VALUES (?, 'pricing', ?, 'high', 'USD', 1, 1, 'm', ?, 1, 1, 1000, ?)
    ON CONFLICT (normalized_hash, prompt_version) DO NOTHING
  `).run(hash, JSON.stringify(data), EXTRACT_PROMPT_VERSION, observedAt);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-timeline-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});

afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('buildTimeline', () => {
  it('builds one continuous segment for an unbroken monthly series', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], 'h2');
    observe('2025-03-16T00:00:00.000Z', [{ name: 'Pro', price: 10 }], 'h3');

    const payload = buildTimeline(db, GENERATED);
    const acme = payload.competitors[0]!;
    expect(acme.series).toHaveLength(1);
    expect(acme.series[0]!.tier).toBe('Pro');
    expect(acme.series[0]!.segments).toHaveLength(1);
    expect(acme.series[0]!.segments[0]!.map(p => p.price)).toEqual([8, 8, 10]);
    expect(acme.first_observed_at).toBe('2025-01-16T00:00:00.000Z');
    expect(acme.last_observed_at).toBe('2025-03-16T00:00:00.000Z');
    expect(payload.observation_count).toBe(3);
  });

  it('breaks the series where the archive has no captures — never interpolates (spec 14.3)', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], 'h2');
    observe('2025-09-16T00:00:00.000Z', [{ name: 'Pro', price: 12 }], 'h3');  // 7-month hole

    const segments = buildTimeline(db, GENERATED).competitors[0]!.series[0]!.segments;
    expect(segments).toHaveLength(2);
    expect(segments[0]!.map(p => p.price)).toEqual([8, 8]);
    expect(segments[1]!.map(p => p.price)).toEqual([12]);
  });

  it('treats exactly TIMELINE_GAP_DAYS as continuous and one day more as a break', () => {
    const start = new Date('2025-01-16T00:00:00.000Z');
    const at = (days: number) => new Date(start.getTime() + days * 86_400_000).toISOString();

    observe(at(0), [{ name: 'Pro', price: 8 }], 'a');
    observe(at(TIMELINE_GAP_DAYS), [{ name: 'Pro', price: 9 }], 'b');
    observe(at(TIMELINE_GAP_DAYS * 2 + 1), [{ name: 'Pro', price: 10 }], 'c');

    const segments = buildTimeline(db, GENERATED).competitors[0]!.series[0]!.segments;
    expect(segments).toHaveLength(2);
    expect(segments[0]!.map(p => p.price)).toEqual([8, 9]);
  });

  it('breaks the series when a tier disappears and returns', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }, { name: 'Team', price: 20 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], 'h2');
    observe('2025-03-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }, { name: 'Team', price: 25 }], 'h3');

    const team = buildTimeline(db, GENERATED).competitors[0]!.series.find(s => s.tier === 'Team')!;
    expect(team.segments).toHaveLength(2);
    expect(team.segments[0]!.map(p => p.price)).toEqual([20]);
    expect(team.segments[1]!.map(p => p.price)).toEqual([25]);
  });

  it('never plots a contact-sales tier as zero', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }, { name: 'Enterprise', price: null }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }, { name: 'Enterprise', price: null }], 'h2');

    const series = buildTimeline(db, GENERATED).competitors[0]!.series;
    expect(series.map(s => s.tier)).toEqual(['Pro']);
  });

  it('keeps a free tier, which is a real zero', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Free', price: 0 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Free', price: 0 }], 'h2');

    const series = buildTimeline(db, GENERATED).competitors[0]!.series;
    expect(series[0]!.tier).toBe('Free');
    expect(series[0]!.segments[0]!.map(p => p.price)).toEqual([0, 0]);
  });

  it('carries confirmed material changes as markers, and nothing else', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 10 }], 'h2');

    db.prepare(`
      INSERT INTO changes
        (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
         before_json, after_json, materiality, state, observed_at)
      VALUES
        (1, 1, 2, 'price_changed', 'tiers.Pro.monthly_price_usd', '8', '10', 80, 'confirmed', '2025-02-16T00:00:00.000Z'),
        (1, 1, 2, 'tier_renamed',  'tiers.Pro',                  '"P"', '"Pro"', 35, 'confirmed', '2025-02-16T00:00:00.000Z'),
        (1, 1, 2, 'price_changed', 'tiers.Team.monthly_price_usd', '1', '2', 80, 'candidate', '2025-02-16T00:00:00.000Z')
    `).run();

    const markers = buildTimeline(db, GENERATED).competitors[0]!.markers;
    expect(markers).toHaveLength(1);
    expect(markers[0]!.observed_at).toBe('2025-02-16T00:00:00.000Z');
    // diff.ts writes the real change_type, 'price_changed' (past tense) — a
    // stale 'price_change' fixture would make this fall through to the
    // generic label and never catch the field disappearing.
    expect(markers[0]!.label).toBe('Pro 8 to 10');
  });

  it('names a non-monthly field so an annual move is not mistaken for a monthly one', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], 'h2');

    db.prepare(`
      INSERT INTO changes
        (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
         before_json, after_json, materiality, state, observed_at)
      VALUES
        (1, 1, 2, 'price_changed', 'tiers.Pro.annual_price_usd', '96', '120', 80, 'confirmed', '2025-02-16T00:00:00.000Z')
    `).run();

    const markers = buildTimeline(db, GENERATED).competitors[0]!.markers;
    expect(markers).toHaveLength(1);
    expect(markers[0]!.label).toBe('Pro annual price usd 96 to 120');
  });

  it('extracts a tier name containing a dot from the json_path unmangled', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Team 2.0', price: 50 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Team 2.0', price: 60 }], 'h2');

    db.prepare(`
      INSERT INTO changes
        (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
         before_json, after_json, materiality, state, observed_at)
      VALUES
        (1, 1, 2, 'price_changed', 'tiers.Team 2.0.monthly_price_usd', '50', '60', 80, 'confirmed', '2025-02-16T00:00:00.000Z')
    `).run();

    const markers = buildTimeline(db, GENERATED).competitors[0]!.markers;
    expect(markers).toHaveLength(1);
    expect(markers[0]!.label).toBe('Team 2.0 50 to 60');
  });

  it('never emits a "null" origin for a contact-sales tier moving to a real price', () => {
    // Enterprise's own null-to-price move never becomes a plotted point (a
    // contact-sales price is never a point), so Pro carries the plotted
    // range that puts the marker's timestamp inside it.
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Enterprise', price: null }, { name: 'Pro', price: 8 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Enterprise', price: 299 }, { name: 'Pro', price: 8 }], 'h2');

    db.prepare(`
      INSERT INTO changes
        (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
         before_json, after_json, materiality, state, observed_at)
      VALUES
        (1, 1, 2, 'price_changed', 'tiers.Enterprise.monthly_price_usd', 'null', '299', 80, 'confirmed', '2025-02-16T00:00:00.000Z')
    `).run();

    const markers = buildTimeline(db, GENERATED).competitors[0]!.markers;
    expect(markers).toHaveLength(1);
    expect(markers[0]!.label).toBe('Enterprise none to 299');
  });

  it('emits a competitor with no usable history rather than dropping it', () => {
    const payload = buildTimeline(db, GENERATED);
    expect(payload.competitors).toHaveLength(1);
    expect(payload.competitors[0]!.series).toEqual([]);
    expect(payload.competitors[0]!.first_observed_at).toBeNull();
    expect(payload.observation_count).toBe(0);
  });
});
