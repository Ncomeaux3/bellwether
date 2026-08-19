import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import {
  buildDatasetRows, toCsv, buildRssXml, buildLlmsTxt, describeChange,
  type FeedChange,
} from '../src/workflow/dataset.js';
import { EXTRACT_PROMPT_VERSION } from '../src/schema/pricing.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

/** Insert one observed page state: a snapshot plus the extraction it hashes to. */
function observe(
  observedAt: string,
  tiers: { name: string; price: number | null; annual?: number | null; billing_unit?: string; seats?: number | null }[],
  opts: { hash?: string; provenance?: string } = {},
): void {
  const hash = opts.hash ?? observedAt;
  const provenance = opts.provenance ?? 'live';

  db.prepare(`
    INSERT INTO snapshots
      (source_id, observed_at, fetched_at, ok, http_status, error,
       raw_content, raw_hash, normalized_hash, provenance)
    VALUES (1, ?, ?, 1, 200, NULL, NULL, ?, ?, ?)
  `).run(observedAt, observedAt, `raw-${hash}`, hash, provenance);

  const data = {
    tiers: tiers.map(t => ({
      name: t.name, monthly_price_usd: t.price, annual_price_usd: t.annual ?? null,
      billing_unit: t.billing_unit ?? 'unknown', included_seats: t.seats ?? null, headline_features: [],
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
  dir = mkdtempSync(join(tmpdir(), 'bw-dataset-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});

afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('buildDatasetRows', () => {
  it('emits two rows for a tier that changes price: one per contiguous state', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], { hash: 'h2' });
    observe('2025-03-16T00:00:00.000Z', [{ name: 'Pro', price: 10 }], { hash: 'h3' });

    const rows = buildDatasetRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      tier: 'Pro', monthly_price_usd: 8,
      first_observed_at: '2025-01-16T00:00:00.000Z',
      last_observed_at: '2025-02-16T00:00:00.000Z',
    });
    expect(rows[1]).toMatchObject({
      tier: 'Pro', monthly_price_usd: 10,
      first_observed_at: '2025-03-16T00:00:00.000Z',
      last_observed_at: '2025-03-16T00:00:00.000Z',
    });
  });

  it('keeps a contact-sales tier\'s monthly price null, never zero', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Enterprise', price: null }]);

    const rows = buildDatasetRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.monthly_price_usd).toBeNull();

    const csv = toCsv(rows);
    const dataLine = csv.trim().split('\n')[1]!;
    const monthlyIdx = toCsv([]).trim().split(',').indexOf('monthly_price_usd');
    expect(dataLine.split(',')[monthlyIdx]).toBe('');
  });

  it('marks a run of wayback captures as wayback provenance', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], { hash: 'a', provenance: 'wayback:20250116' });
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], { hash: 'b', provenance: 'wayback:20250216' });

    const rows = buildDatasetRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provenance).toBe('wayback');
  });

  it('marks a run mixing wayback and live observations as mixed', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], { hash: 'a', provenance: 'wayback:20250116' });
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], { hash: 'b', provenance: 'live' });

    const rows = buildDatasetRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provenance).toBe('mixed');
  });

  it('marks a run of all-live observations as live', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], { hash: 'b' });

    const rows = buildDatasetRows(db);
    expect(rows[0]!.provenance).toBe('live');
  });
});

describe('toCsv', () => {
  it('round-trips a tier name with embedded quotes and a comma (RFC-4180)', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Team "Pro", v2', price: 20 }]);
    const rows = buildDatasetRows(db);
    const csv = toCsv(rows);
    const dataLine = csv.trim().split('\n')[1]!;
    expect(dataLine).toContain('"Team ""Pro"", v2"');
  });

  it('writes booleans as true/false and never a numeric null', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Free', price: 0 }]);
    const rows = buildDatasetRows(db);
    const csv = toCsv(rows);
    expect(csv).toContain('true');
    const header = csv.split('\n')[0]!;
    expect(header).toBe(
      'competitor,tier,first_observed_at,last_observed_at,monthly_price_usd,annual_price_usd,' +
      'billing_unit,included_seats,is_free,is_enterprise,currency,provenance',
    );
  });
});

describe('describeChange', () => {
  it('keeps the dotted-tier-name and annual-field grammar, and "none" for null', () => {
    expect(describeChange({
      json_path: 'tiers.Team 2.0.monthly_price_usd', change_type: 'price_changed',
      before_json: '50', after_json: '60',
    })).toBe('Team 2.0 50 to 60');

    expect(describeChange({
      json_path: 'tiers.Pro.annual_price_usd', change_type: 'price_changed',
      before_json: '96', after_json: '120',
    })).toBe('Pro annual price 96 to 120');

    expect(describeChange({
      json_path: 'tiers.Enterprise.monthly_price_usd', change_type: 'price_changed',
      before_json: null, after_json: '299',
    })).toBe('Enterprise none to 299');
  });
});

function makeChange(overrides: Partial<FeedChange> = {}): FeedChange {
  return {
    competitor: 'Acme', slug: 'acme', change_type: 'price_changed',
    json_path: 'tiers.Pro.monthly_price_usd', before: 8, after: 10,
    observed_at: '2025-02-16T00:00:00.000Z', annotation: null,
    ...overrides,
  };
}

describe('buildRssXml', () => {
  it('produces valid, well-formed XML with matched item tags', () => {
    const xml = buildRssXml([makeChange()], '2026-08-19T00:00:00.000Z', 'https://bellwether.test');
    const opens = xml.match(/<item>/g) ?? [];
    const closes = xml.match(/<\/item>/g) ?? [];
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  });

  it('orders items newest first', () => {
    const older = makeChange({ observed_at: '2025-01-01T00:00:00.000Z', json_path: 'tiers.Old.monthly_price_usd' });
    const newer = makeChange({ observed_at: '2025-06-01T00:00:00.000Z', json_path: 'tiers.New.monthly_price_usd' });
    const xml = buildRssXml([older, newer], '2026-08-19T00:00:00.000Z', 'https://bellwether.test');
    expect(xml.indexOf('New')).toBeLessThan(xml.indexOf('Old'));
  });

  it('uses the annotation as description when present, else the structured fallback', () => {
    const annotated = makeChange({
      annotation: { implication: 'Pro got pricier', so_what: 'budget accordingly' },
    });
    const withAnnotation = buildRssXml([annotated], '2026-08-19T00:00:00.000Z', 'https://bellwether.test');
    expect(withAnnotation).toContain('Pro got pricier — budget accordingly');

    const plain = makeChange();
    const withoutAnnotation = buildRssXml([plain], '2026-08-19T00:00:00.000Z', 'https://bellwether.test');
    expect(withoutAnnotation).toContain('8 -&gt; 10');
  });

  it('escapes an ampersand in a competitor name', () => {
    const change = makeChange({ competitor: 'Acme & Co' });
    const xml = buildRssXml([change], '2026-08-19T00:00:00.000Z', 'https://bellwether.test');
    expect(xml).toContain('Acme &amp; Co');
    expect(xml).not.toContain('Acme & Co');
  });

  it('caps at 50 items out of 60 supplied', () => {
    const changes = Array.from({ length: 60 }, (_, i) => makeChange({
      observed_at: new Date(2025, 0, i + 1).toISOString(),
      json_path: `tiers.T${i}.monthly_price_usd`,
    }));
    const xml = buildRssXml(changes, '2026-08-19T00:00:00.000Z', 'https://bellwether.test');
    const opens = xml.match(/<item>/g) ?? [];
    expect(opens).toHaveLength(50);
  });

  it('builds guid as slug|json_path|observed_at with isPermaLink false', () => {
    const change = makeChange();
    const xml = buildRssXml([change], '2026-08-19T00:00:00.000Z', 'https://bellwether.test');
    expect(xml).toContain('<guid isPermaLink="false">acme|tiers.Pro.monthly_price_usd|2025-02-16T00:00:00.000Z</guid>');
  });
});

describe('buildLlmsTxt', () => {
  it('lists every stable endpoint and the license, with no ISO timestamp', () => {
    const txt = buildLlmsTxt('https://bellwether.test', [{ name: 'Acme', slug: 'acme' }]);
    for (const endpoint of [
      '/data/board.json', '/data/changes.json', '/data/timeline.json',
      '/data/dataset.json', '/data/dataset.csv', '/changes.xml',
    ]) {
      expect(txt).toContain(endpoint);
    }
    expect(txt).toContain('CC BY 4.0');
    expect(txt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('is deterministic across calls', () => {
    const competitors = [{ name: 'Acme', slug: 'acme' }, { name: 'Beta', slug: 'beta' }];
    expect(buildLlmsTxt('https://bellwether.test', competitors))
      .toBe(buildLlmsTxt('https://bellwether.test', competitors));
  });
});
