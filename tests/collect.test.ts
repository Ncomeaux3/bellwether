import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { collect } from '../src/workflow/collect.js';
import type { FetchResult } from '../src/tools/fetch.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme',
  name: 'Acme',
  homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

const GOOD_PAGE = '<html><h2>Pro</h2><p>$20/mo</p><h2>Enterprise</h2></html>';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-collect-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function ok(body: string): FetchResult {
  return { ok: true, httpStatus: 200, body, error: null };
}
function fail(status: number | null, error: string): FetchResult {
  return { ok: false, httpStatus: status, body: null, error };
}
function at(iso: string) { return () => new Date(iso); }

describe('collect', () => {
  it('stores a snapshot with raw content on first sight', async () => {
    const stats = await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z') });

    expect(stats.attempted).toBe(1);
    expect(stats.stored).toBe(1);

    const row = db.prepare('SELECT ok, raw_content, raw_hash, provenance, observed_at FROM snapshots').get() as
      { ok: number; raw_content: string | null; raw_hash: string; provenance: string; observed_at: string };
    expect(row.ok).toBe(1);
    expect(row.raw_content).toBe(GOOD_PAGE);
    expect(row.raw_hash).toHaveLength(64);
    expect(row.provenance).toBe('live');
    expect(row.observed_at).toBe('2026-08-18T12:00:00.000Z');
  });

  it('skips a source that is not yet due', async () => {
    await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z') });
    const stats = await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T18:00:00.000Z') });

    expect(stats.attempted).toBe(0);
    const count = db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('writes a row with NULL raw_content when the hash repeats', async () => {
    await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z') });
    const stats = await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-19T12:00:00.000Z') });

    expect(stats.unchanged).toBe(1);
    expect(stats.stored).toBe(0);

    const rows = db.prepare('SELECT raw_content FROM snapshots ORDER BY id').all() as
      { raw_content: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.raw_content).toBe(GOOD_PAGE);
    expect(rows[1]!.raw_content).toBeNull();
  });

  it('stores raw content again when the page genuinely changes', async () => {
    await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z') });
    const changed = GOOD_PAGE.replace('$20', '$24');
    const stats = await collect(db, {}, { fetcher: async () => ok(changed), now: at('2026-08-19T12:00:00.000Z') });

    expect(stats.stored).toBe(1);
    const rows = db.prepare('SELECT raw_content FROM snapshots ORDER BY id').all() as
      { raw_content: string | null }[];
    expect(rows[1]!.raw_content).toBe(changed);
  });

  it('records a failed fetch without raw content and never overwrites good data', async () => {
    await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z') });
    const stats = await collect(db, {}, {
      fetcher: async () => fail(503, 'HTTP 503'),
      now: at('2026-08-19T12:00:00.000Z'),
    });

    expect(stats.failed).toBe(1);

    const rows = db.prepare('SELECT ok, raw_content, error, http_status FROM snapshots ORDER BY id').all() as
      { ok: number; raw_content: string | null; error: string | null; http_status: number | null }[];
    expect(rows[0]!.raw_content).toBe(GOOD_PAGE);
    expect(rows[1]!.ok).toBe(0);
    expect(rows[1]!.raw_content).toBeNull();
    expect(rows[1]!.error).toBe('HTTP 503');
    expect(rows[1]!.http_status).toBe(503);
  });

  it('marks the source degraded when the canary string is missing', async () => {
    const stats = await collect(db, {}, {
      fetcher: async () => ok('<html><h2>Pro</h2><p>$20</p></html>'),
      now: at('2026-08-18T12:00:00.000Z'),
    });

    expect(stats.degraded).toBe(1);
    const row = db.prepare('SELECT degraded_reason FROM sources').get() as { degraded_reason: string | null };
    expect(row.degraded_reason).toMatch(/canary/i);
  });

  it('marks the source degraded when no price-like text is present', async () => {
    const stats = await collect(db, {}, {
      fetcher: async () => ok('<html><h2>Enterprise</h2><p>Talk to us</p></html>'),
      now: at('2026-08-18T12:00:00.000Z'),
    });

    expect(stats.degraded).toBe(1);
    const row = db.prepare('SELECT degraded_reason FROM sources').get() as { degraded_reason: string | null };
    expect(row.degraded_reason).toMatch(/price/i);
  });

  it('clears degraded_reason on the next healthy fetch', async () => {
    await collect(db, {}, { fetcher: async () => ok('<html>broken</html>'), now: at('2026-08-18T12:00:00.000Z') });
    const stats = await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-19T12:00:00.000Z') });

    expect(stats.cleared).toBe(1);
    const row = db.prepare('SELECT degraded_reason FROM sources').get() as { degraded_reason: string | null };
    expect(row.degraded_reason).toBeNull();
  });

  it('honours --limit', async () => {
    seedCompetitors(db, [
      ...CONFIG,
      { slug: 'beta', name: 'Beta', homepage: 'https://beta.test',
        sources: [{ kind: 'pricing', url: 'https://beta.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }] },
    ]);

    const stats = await collect(db, { limit: 1 }, {
      fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z'),
    });

    expect(stats.attempted).toBe(1);
  });

  it('writes nothing in dry-run mode', async () => {
    const stats = await collect(db, { dryRun: true }, {
      fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z'),
    });

    expect(stats.attempted).toBe(1);
    const count = db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('leaves a completed run row behind', async () => {
    await collect(db, {}, { fetcher: async () => ok(GOOD_PAGE), now: at('2026-08-18T12:00:00.000Z') });
    const row = db.prepare("SELECT state, ok FROM runs WHERE kind = 'collect'").get() as
      { state: string; ok: number };
    expect(row).toEqual({ state: 'ok', ok: 1 });
  });
});
