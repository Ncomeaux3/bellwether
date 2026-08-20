import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import {
  buildDatasetRows, toCsv, buildRssXml, buildLlmsTxt, describeChange, stepPoints,
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

  // Fix round 1, finding 1: observationsFor collapses a later snapshot with
  // an identical hash into its representative, keeping only the FIRST
  // snapshot's date and provenance. A live re-fetch confirming a wayback
  // capture's state must still move last_observed_at and register as mixed.
  it('does not lose a live re-confirmation collapsed by observationsFor\'s hash dedup', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], { hash: 'same', provenance: 'wayback:20250116' });
    observe('2026-08-18T00:00:00.000Z', [{ name: 'Pro', price: 8 }], { hash: 'same', provenance: 'live' });

    const rows = buildDatasetRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provenance).toBe('mixed');
    expect(rows[0]!.last_observed_at).toBe('2026-08-18T00:00:00.000Z');
  });

  // Fix round 1, finding 3: Zod permits a duplicate tier name in one
  // extraction; keying runs on bare name made every repeat clobber the run
  // in progress mid-observation.
  it('bounds a duplicate tier name to one row per occurrence, not one per encounter', () => {
    const dup = [{ name: 'Pro', price: 8 }, { name: 'Pro', price: 8 }];
    observe('2025-01-16T00:00:00.000Z', dup, { hash: 'a' });
    observe('2025-02-16T00:00:00.000Z', dup, { hash: 'b' });
    observe('2025-03-16T00:00:00.000Z', dup, { hash: 'c' });

    const rows = buildDatasetRows(db);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.tier === 'Pro')).toBe(true);
    expect(rows[0]).toMatchObject({
      first_observed_at: '2025-01-16T00:00:00.000Z',
      last_observed_at: '2025-03-16T00:00:00.000Z',
    });
  });

  // Fix round 1, finding 6 (ruling): billing_unit jitter against 'unknown'
  // does not split a run — measured on Supabase Enterprise, which alternated
  // flat/unknown across re-extractions of an otherwise-unchanged tier.
  it('does not split a run when billing_unit jitters against "unknown"', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Enterprise', price: null, billing_unit: 'flat' }], { hash: 'a' });
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Enterprise', price: null, billing_unit: 'unknown' }], { hash: 'b' });
    observe('2025-03-16T00:00:00.000Z', [{ name: 'Enterprise', price: null, billing_unit: 'flat' }], { hash: 'c' });

    const rows = buildDatasetRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.billing_unit).toBe('flat'); // first observation's value is kept
    expect(rows[0]!.last_observed_at).toBe('2025-03-16T00:00:00.000Z');
  });

  // Fix round 1, finding 6 (ruling): annual_price_usd jitter between 0 and
  // null does not split a run when the tier's monthly price is 0 on both
  // sides — measured on Notion Free, which flipped this way across re-runs.
  it('does not split a run when annual_price_usd jitters 0/null on a free tier', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Free', price: 0, annual: 0 }], { hash: 'a' });
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Free', price: 0, annual: null }], { hash: 'b' });

    const rows = buildDatasetRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.annual_price_usd).toBe(0); // first observation's value is kept
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

  // Fix round 1, finding 2: tier/competitor names come from third-party
  // pages via the model, so an attacker-controlled page can inject a
  // formula into the CSV we tell people to open in Excel.
  it('defuses a formula-injection payload in a tier name', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: '=HYPERLINK("http://evil.test","x")', price: 5 }]);
    const rows = buildDatasetRows(db);
    const csv = toCsv(rows);
    const dataLine = csv.trim().split('\n')[1]!;
    expect(dataLine).toContain('"\'=HYPERLINK');
    expect(dataLine).not.toMatch(/^=/);
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

describe('stepPoints', () => {
  it('expands three points ($8/$8/$10) to five, with the step landing on the next date', () => {
    const points = [
      { observed_at: '2025-01-16T00:00:00.000Z', price: 8 },
      { observed_at: '2025-02-16T00:00:00.000Z', price: 8 },
      { observed_at: '2025-03-16T00:00:00.000Z', price: 10 },
    ];
    expect(stepPoints(points)).toEqual([
      { observed_at: '2025-01-16T00:00:00.000Z', price: 8 },
      { observed_at: '2025-02-16T00:00:00.000Z', price: 8 }, // step to next date, current price
      { observed_at: '2025-02-16T00:00:00.000Z', price: 8 },
      { observed_at: '2025-03-16T00:00:00.000Z', price: 8 }, // step to next date, current price
      { observed_at: '2025-03-16T00:00:00.000Z', price: 10 },
    ]);
  });

  it('leaves a one-point segment unchanged', () => {
    const points = [{ observed_at: '2025-01-16T00:00:00.000Z', price: 8 }];
    expect(stepPoints(points)).toEqual(points);
  });

  it('leaves an empty segment unchanged', () => {
    expect(stepPoints([])).toEqual([]);
  });

  it('never reorders or drops an original point', () => {
    const points = [
      { observed_at: '2025-01-16T00:00:00.000Z', price: 8 },
      { observed_at: '2025-02-16T00:00:00.000Z', price: 8 },
      { observed_at: '2025-03-16T00:00:00.000Z', price: 10 },
    ];
    const result = stepPoints(points);
    // Every original point object survives, by identity, as a subsequence
    // of the output in its original order — searching forward from the
    // last match found guards against reordering, not just presence.
    let searchFrom = 0;
    for (const original of points) {
      const foundAt = result.indexOf(original, searchFrom);
      expect(foundAt).toBeGreaterThanOrEqual(searchFrom);
      searchFrom = foundAt + 1;
    }
  });

  it('does not mutate the input array or its points', () => {
    const points = [
      { observed_at: '2025-01-16T00:00:00.000Z', price: 8 },
      { observed_at: '2025-02-16T00:00:00.000Z', price: 10 },
    ];
    const snapshot = JSON.parse(JSON.stringify(points));
    stepPoints(points);
    expect(points).toEqual(snapshot);
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

  it('caps at 50 items out of 60 supplied, keeping the newest and dropping the oldest', () => {
    const changes = Array.from({ length: 60 }, (_, i) => makeChange({
      observed_at: new Date(2025, 0, i + 1).toISOString(),
      json_path: `tiers.T${i}.monthly_price_usd`,
    }));
    const xml = buildRssXml(changes, '2026-08-19T00:00:00.000Z', 'https://bellwether.test');
    const opens = xml.match(/<item>/g) ?? [];
    expect(opens).toHaveLength(50);
    expect(xml).toContain('T59'); // newest (day 60) survived
    expect(xml).not.toContain('T0 '); // oldest (day 1) was dropped
  });

  it('builds guid as slug|json_path|observed_at with isPermaLink false', () => {
    const change = makeChange();
    const xml = buildRssXml([change], '2026-08-19T00:00:00.000Z', 'https://bellwether.test');
    expect(xml).toContain('<guid isPermaLink="false">acme|tiers.Pro.monthly_price_usd|2025-02-16T00:00:00.000Z</guid>');
  });

  // Fix round 1, finding 4: tier_added/tier_removed carry whole tier objects
  // as before/after and always reach the feed at materiality 100.
  it('does not stringify an object value into the description (tier_added)', () => {
    const change = makeChange({
      change_type: 'tier_added', json_path: 'tiers.Solo',
      before: null, after: { name: 'Solo', monthly_price_usd: 5 },
    });
    const xml = buildRssXml([change], '2026-08-19T00:00:00.000Z', 'https://bellwether.test');
    expect(xml).not.toContain('[object');
    expect(xml).toContain('Solo tier added');
  });

  // M4 fix round 1, finding 5 pinned this to a same-page anchor because
  // /c/<slug> had no route yet. M6 task 4 ships that route and repoints both
  // the feed and llms.txt at it — this closes that deferral.
  it('links to the competitor\'s own page, not the deferred anchor', () => {
    const xml = buildRssXml([makeChange()], '2026-08-19T00:00:00.000Z', 'https://bellwether.test');
    expect(xml).toContain('<link>https://bellwether.test/c/acme/</link>');
    expect(xml).not.toContain('/#acme');
  });

  // Fix round 1, finding 7: defensive — no legitimate row should have an
  // unparseable observed_at, but one must not corrupt the sort or print
  // "Invalid Date" into a published feed.
  it('drops a feed change with an unparseable observed_at', () => {
    const bad = makeChange({ observed_at: 'not-a-date', json_path: 'tiers.Bad.monthly_price_usd' });
    const good = makeChange({ observed_at: '2025-06-01T00:00:00.000Z', json_path: 'tiers.Good.monthly_price_usd' });
    const xml = buildRssXml([bad, good], '2026-08-19T00:00:00.000Z', 'https://bellwether.test');
    expect(xml).not.toContain('Invalid Date');
    expect(xml).toContain('Good');
    expect(xml).not.toContain('Bad');
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

  it('links each competitor to its own /c/<slug> page, not a same-page anchor', () => {
    const txt = buildLlmsTxt('https://bellwether.test', [{ name: 'Acme', slug: 'acme' }]);
    expect(txt).toContain('https://bellwether.test/c/acme/');
    expect(txt).not.toContain('/#acme');
  });

  it('is deterministic across calls', () => {
    const competitors = [{ name: 'Acme', slug: 'acme' }, { name: 'Beta', slug: 'beta' }];
    expect(buildLlmsTxt('https://bellwether.test', competitors))
      .toBe(buildLlmsTxt('https://bellwether.test', competitors));
  });
});

describe('the web changeLabel stays pinned to describeChange', () => {
  // web/ cannot import from src/, so the board's change-list labels are an
  // intentional reimplementation of describeChange's grammar. Nothing else
  // guards against drift — the web package has no test runner — so this pins
  // the two on the branches real data does not currently exercise.
  it('agrees on the dotted-name, annual-field, and null-value branches', async () => {
    const { changeLabel } = await import('../web/lib/data.js');

    const cases = [
      { change_type: 'price_changed', json_path: 'tiers.Team 2.0.monthly_price_usd', before_json: '8', after_json: '10' },
      { change_type: 'price_changed', json_path: 'tiers.Pro.annual_price_usd', before_json: '96', after_json: '120' },
      { change_type: 'price_changed', json_path: 'tiers.Ent.monthly_price_usd', before_json: null, after_json: '299' },
      { change_type: 'tier_removed', json_path: 'tiers.Basic', before_json: '{"name":"Basic"}', after_json: null },
    ];
    for (const c of cases) {
      const web = changeLabel({
        change_type: c.change_type, json_path: c.json_path,
        before: c.before_json === null ? null : JSON.parse(c.before_json),
        after: c.after_json === null ? null : JSON.parse(c.after_json),
      });
      expect(web, `${c.change_type} ${c.json_path}`).toBe(describeChange(c));
    }
  });
});

describe('the web stepPoints stays pinned to src stepPoints', () => {
  // web/ cannot import from src/, so Timeline.tsx's step-after interpolation
  // is an intentional reimplementation of stepPoints's expansion. Nothing
  // else guards against drift — the web package has no test runner — so
  // this pins the two together the same way changeLabel is pinned above.
  it('agrees on a multi-point series, a one-point segment, and an empty segment', async () => {
    const { stepPoints: webStepPoints } = await import('../web/lib/data.js');

    const cases: { observed_at: string; price: number }[][] = [
      [
        { observed_at: '2025-01-16T00:00:00.000Z', price: 8 },
        { observed_at: '2025-02-16T00:00:00.000Z', price: 8 },
        { observed_at: '2025-03-16T00:00:00.000Z', price: 10 },
      ],
      [{ observed_at: '2025-01-16T00:00:00.000Z', price: 8 }],
      [],
    ];
    for (const points of cases) {
      expect(webStepPoints(points)).toEqual(stepPoints(points));
    }
  });
});
