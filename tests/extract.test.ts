import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { extract } from '../src/workflow/extract.js';
import { monthlySpendMicros } from '../src/agents/_client.js';
import type { CompetitorConfig } from '../src/config/types.js';
import type { ExtractResult } from '../src/agents/extract_pricing.js';

let dir: string; let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

const HTML = '<body><main><h2>Pro</h2><p>$20/mo</p><h2>Enterprise</h2></main></body>';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-extract-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function addSnapshot(
  html: string | null, ok = 1, observedAt = '2026-08-18T12:00:00.000Z', provenance = 'live',
) {
  db.prepare(`INSERT INTO snapshots
    (source_id, observed_at, fetched_at, ok, http_status, error, raw_content, raw_hash, normalized_hash, provenance)
    VALUES (1, ?, ?, ?, 200, NULL, ?, ?, NULL, ?)`)
    .run(observedAt, observedAt, ok, html, html ? `h${html.length}${observedAt}` : null, provenance);
}

const okResult = (price: number, currency = 'USD', confidence: 'high' | 'low' = 'high'): ExtractResult => ({
  ok: true,
  data: {
    currency,
    tiers: [{
      name: 'Pro', monthly_price_usd: price, annual_price_usd: null,
      billing_unit: 'per_seat', included_seats: null,
      is_free: false, is_enterprise: false, headline_features: [],
    }],
    usage_rates: [], notes: null, extraction_confidence: confidence,
  },
  inputTokens: 6_000, outputTokens: 600, costMicros: 9_000, attempts: 1,
});

const deps = (result: ExtractResult, env: Record<string, string> = { LLM_ENABLED: 'true' }) => ({
  extractor: async () => result,
  env: env as NodeJS.ProcessEnv,
  now: () => new Date('2026-08-18T12:00:00.000Z'),
});

describe('extract', () => {
  it('backfills normalized_hash onto snapshots that lack it', async () => {
    addSnapshot(HTML);
    await extract(db, {}, deps(okResult(20)));
    const row = db.prepare('SELECT normalized_hash FROM snapshots').get() as { normalized_hash: string | null };
    expect(row.normalized_hash).toHaveLength(64);
  });

  it('writes an extraction row with cost and provenance', async () => {
    addSnapshot(HTML);
    const stats = await extract(db, {}, deps(okResult(20)));
    expect(stats.extracted).toBe(1);

    const row = db.prepare('SELECT * FROM extractions').get() as Record<string, unknown>;
    expect(row.prompt_version).toBe('extract-pricing-v1');
    expect(row.model).toBe('claude-haiku-4-5');
    expect(row.cost_micros).toBe(9_000);
    expect(row.grounded).toBe(1);
    expect(JSON.parse(String(row.data_json)).tiers[0].monthly_price_usd).toBe(20);
  });

  it('reuses the cache for a repeated page state instead of calling again', async () => {
    addSnapshot(HTML, 1, '2026-08-18T12:00:00.000Z');
    addSnapshot(HTML, 1, '2026-08-19T12:00:00.000Z');
    let calls = 0;
    await extract(db, {}, { ...deps(okResult(20)), extractor: async () => { calls += 1; return okResult(20); } });

    expect(calls).toBe(1);
    const n = db.prepare('SELECT COUNT(*) AS n FROM extractions').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('skips failed snapshots entirely', async () => {
    addSnapshot(null, 0);
    const stats = await extract(db, {}, deps(okResult(20)));
    expect(stats.considered).toBe(0);
    expect(stats.extracted).toBe(0);
  });

  it('does nothing and spends nothing when LLM_ENABLED is false', async () => {
    addSnapshot(HTML);
    let calls = 0;
    const stats = await extract(db, {}, {
      ...deps(okResult(20), { LLM_ENABLED: 'false' }),
      extractor: async () => { calls += 1; return okResult(20); },
    });
    expect(calls).toBe(0);
    expect(stats.skipped).toBeGreaterThan(0);
    // Hashing still happens — it is free and detect needs it.
    const row = db.prepare('SELECT normalized_hash FROM snapshots').get() as { normalized_hash: string | null };
    expect(row.normalized_hash).not.toBeNull();
  });

  it('stores a non-USD extraction but flags it as a mismatch', async () => {
    addSnapshot(HTML);
    const stats = await extract(db, {}, deps(okResult(20, 'EUR')));
    expect(stats.mismatched).toBe(1);
    const row = db.prepare('SELECT currency FROM extractions').get() as { currency: string };
    expect(row.currency).toBe('EUR');
  });

  it('degrades the source when extraction is ungrounded', async () => {
    addSnapshot(HTML);
    const stats = await extract(db, {}, deps({ ok: false, reason: 'ungrounded', detail: 'tiers.Pro.monthly_price_usd = 99 does not appear' }));
    expect(stats.degraded).toBe(1);
    const row = db.prepare('SELECT degraded_reason FROM sources').get() as { degraded_reason: string | null };
    expect(row.degraded_reason).toMatch(/ungrounded|99/i);
    const n = db.prepare('SELECT COUNT(*) AS n FROM extractions').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('stops when the monthly budget is exhausted', async () => {
    addSnapshot(HTML);
    db.prepare(`INSERT INTO extractions
      (normalized_hash, source_kind, data_json, extraction_confidence, is_backfill,
       model, prompt_version, cost_micros, created_at)
      VALUES ('other', 'pricing', '{}', 'high', 0, 'm', 'v', 6000000, '2026-08-02T00:00:00.000Z')`).run();

    let calls = 0;
    const stats = await extract(db, {}, { ...deps(okResult(20)), extractor: async () => { calls += 1; return okResult(20); } });
    expect(calls).toBe(0);
    expect(stats.skipped).toBeGreaterThan(0);
  });

  it('honours --limit', async () => {
    addSnapshot('<body><main>$10</main></body>', 1, '2026-08-18T12:00:00.000Z');
    addSnapshot('<body><main>$20</main></body>', 1, '2026-08-19T12:00:00.000Z');
    const stats = await extract(db, { limit: 1 }, deps(okResult(20)));
    expect(stats.extracted).toBe(1);
  });

  it('applies --limit to LLM calls made, not to the oldest candidates — a grown, mostly-cached archive still makes progress', async () => {
    addSnapshot('<body><main>$10</main></body>', 1, '2026-08-18T12:00:00.000Z');
    addSnapshot('<body><main>$20</main></body>', 1, '2026-08-19T12:00:00.000Z');
    // First run caches both — they're now the oldest snapshots in the archive.
    await extract(db, {}, deps(okResult(20)));

    addSnapshot('<body><main>$30</main></body>', 1, '2026-08-20T12:00:00.000Z');   // new, uncached
    let calls = 0;
    const stats = await extract(db, { limit: 1 }, {
      ...deps(okResult(30)),
      extractor: async () => { calls += 1; return okResult(30); },
    });

    // A limit applied to the candidate query (sorted oldest-first) would
    // return only the already-cached snapshots and never reach this one.
    expect(calls).toBe(1);
    expect(stats.extracted).toBe(1);
  });

  it('leaves a completed run row', async () => {
    addSnapshot(HTML);
    await extract(db, {}, deps(okResult(20)));
    const row = db.prepare("SELECT state, ok FROM runs WHERE kind = 'extract'").get() as { state: string; ok: number };
    expect(row).toEqual({ state: 'ok', ok: 1 });
  });

  it('propagates normalized_hash to a dedup sibling inserted after the source row was already hashed', async () => {
    addSnapshot(HTML, 1, '2026-08-18T12:00:00.000Z');
    await extract(db, {}, deps(okResult(20)));

    const first = db.prepare('SELECT raw_hash, normalized_hash FROM snapshots').get() as
      { raw_hash: string; normalized_hash: string };
    expect(first.normalized_hash).not.toBeNull();

    // Exactly what `collect` does on a repeat day: a dedup row sharing
    // raw_hash with the already-hashed source row, but with raw_content NULL
    // and normalized_hash NULL, inserted *after* that source row was hashed.
    db.prepare(`INSERT INTO snapshots
      (source_id, observed_at, fetched_at, ok, http_status, error, raw_content, raw_hash, normalized_hash, provenance)
      VALUES (1, '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z', 1, 200, NULL, NULL, ?, NULL, 'live')`)
      .run(first.raw_hash);

    await extract(db, {}, deps(okResult(20)));

    const sibling = db.prepare('SELECT normalized_hash FROM snapshots WHERE raw_content IS NULL').get() as
      { normalized_hash: string | null };
    expect(sibling.normalized_hash).not.toBeNull();
    expect(sibling.normalized_hash).toBe(first.normalized_hash);
  });
});

describe('historical snapshots (spec 12.1)', () => {
  it('never marks a source degraded when a historical extraction fails (R3)', async () => {
    addSnapshot(HTML, 1, '2025-01-16T00:00:00.000Z', 'wayback:20250116000000');

    const stats = await extract(
      db,
      {},
      deps({ ok: false, reason: 'oversized', detail: '31000 tokens exceeds the 20000 budget' }),
    );

    const source = db.prepare('SELECT degraded_reason FROM sources WHERE id = 1').get() as
      { degraded_reason: string | null };
    expect(source.degraded_reason).toBeNull();
    expect(stats.historicalFailed).toBe(1);
    expect(stats.degraded).toBe(0);
  });

  it('still marks a source degraded when a LIVE extraction fails', async () => {
    addSnapshot(HTML);

    const stats = await extract(
      db,
      {},
      deps({ ok: false, reason: 'ungrounded', detail: 'price 20 not in source' }),
    );

    const source = db.prepare('SELECT degraded_reason FROM sources WHERE id = 1').get() as
      { degraded_reason: string | null };
    expect(source.degraded_reason).toContain('ungrounded');
    expect(stats.degraded).toBe(1);
    expect(stats.historicalFailed).toBe(0);
  });

  it('tags a historical extraction is_backfill=1 so it misses the recurring cap (R4)', async () => {
    addSnapshot(HTML, 1, '2025-01-16T00:00:00.000Z', 'wayback:20250116000000');

    await extract(db, {}, deps(okResult(20)));

    const row = db.prepare('SELECT is_backfill, cost_micros FROM extractions').get() as
      { is_backfill: number; cost_micros: number };
    expect(row.is_backfill).toBe(1);
    expect(monthlySpendMicros(db, new Date('2026-08-18T12:00:00.000Z'))).toBe(0);
  });

  it('tags a live extraction is_backfill=0 so it does count against the cap', async () => {
    addSnapshot(HTML);

    await extract(db, {}, deps(okResult(20)));

    const row = db.prepare('SELECT is_backfill FROM extractions').get() as { is_backfill: number };
    expect(row.is_backfill).toBe(0);
    expect(monthlySpendMicros(db, new Date('2026-08-18T12:00:00.000Z'))).toBeGreaterThan(0);
  });
});
