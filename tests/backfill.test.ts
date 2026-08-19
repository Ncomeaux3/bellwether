import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { discoverCaptures, drainQueue, MAX_CAPTURE_ATTEMPTS } from '../src/workflow/backfill.js';
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

const NOW = () => new Date('2026-08-19T07:00:00.000Z');

function cdxBody(...timestamps: string[]): string {
  return JSON.stringify([
    ['timestamp', 'original', 'statuscode', 'digest'],
    ...timestamps.map((ts, i) => [ts, 'https://acme.test/pricing', '200', `D${i}`]),
  ]);
}

function ok(body: string): FetchResult {
  return { ok: true, httpStatus: 200, body, error: null };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-backfill-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('discoverCaptures', () => {
  it('enqueues one row per capture, with the id_ target URL', async () => {
    const stats = await discoverCaptures(db, {}, {
      fetcher: async () => ok(cdxBody('20250116002909', '20250209133622')),
      now: NOW,
    });

    expect(stats).toMatchObject({ sources: 1, found: 2, enqueued: 2, duplicate: 0, failed: 0 });

    const rows = db.prepare('SELECT wayback_ts, target_url, state, attempts FROM backfill_queue ORDER BY wayback_ts')
      .all() as { wayback_ts: string; target_url: string; state: string; attempts: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.wayback_ts).toBe('20250116002909');
    expect(rows[0]!.target_url).toBe('https://web.archive.org/web/20250116002909id_/https://acme.test/pricing');
    expect(rows[0]!.state).toBe('pending');
    expect(rows[0]!.attempts).toBe(0);
  });

  it('queries an 18-month window ending today by default', async () => {
    let requested = '';
    await discoverCaptures(db, {}, {
      fetcher: async (url) => { requested = url; return ok(cdxBody()); },
      now: NOW,
    });

    const params = new URL(requested).searchParams;
    expect(params.get('url')).toBe('https://acme.test/pricing');
    expect(params.get('from')).toBe('20250219');
    expect(params.get('to')).toBe('20260819');
  });

  it('honours an explicit --months window', async () => {
    let requested = '';
    await discoverCaptures(db, { months: 12 }, {
      fetcher: async (url) => { requested = url; return ok(cdxBody()); },
      now: NOW,
    });
    expect(new URL(requested).searchParams.get('from')).toBe('20250819');
  });

  it('is idempotent — a second discovery enqueues nothing new', async () => {
    const fetcher = async () => ok(cdxBody('20250116002909', '20250209133622'));
    await discoverCaptures(db, {}, { fetcher, now: NOW });
    const second = await discoverCaptures(db, {}, { fetcher, now: NOW });

    expect(second).toMatchObject({ found: 2, enqueued: 0, duplicate: 2 });
    expect((db.prepare('SELECT COUNT(*) n FROM backfill_queue').get() as { n: number }).n).toBe(2);
  });

  it('never resets a row that has already been drained', async () => {
    const fetcher = async () => ok(cdxBody('20250116002909'));
    await discoverCaptures(db, {}, { fetcher, now: NOW });
    db.prepare("UPDATE backfill_queue SET state = 'fetched', attempts = 1").run();

    await discoverCaptures(db, {}, { fetcher, now: NOW });

    const row = db.prepare('SELECT state, attempts FROM backfill_queue').get() as { state: string; attempts: number };
    expect(row.state).toBe('fetched');
    expect(row.attempts).toBe(1);
  });

  it('counts a CDX failure without throwing, so other sources still run', async () => {
    const stats = await discoverCaptures(db, {}, {
      fetcher: async () => ({ ok: false, httpStatus: 503, body: null, error: 'HTTP 503' }),
      now: NOW,
    });
    expect(stats).toMatchObject({ sources: 1, found: 0, enqueued: 0, failed: 1 });
  });

  it('treats an empty CDX answer as zero captures, not a failure', async () => {
    const stats = await discoverCaptures(db, {}, { fetcher: async () => ok(''), now: NOW });
    expect(stats).toMatchObject({ found: 0, enqueued: 0, failed: 0 });
  });

  it('restricts to one source when asked', async () => {
    await discoverCaptures(db, { sourceId: 999 }, {
      fetcher: async () => { throw new Error('should not fetch'); },
      now: NOW,
    });
    expect((db.prepare('SELECT COUNT(*) n FROM backfill_queue').get() as { n: number }).n).toBe(0);
  });
});

describe('drainQueue', () => {
  const PAGE = '<html><h2>Pro</h2><p>$20/mo</p><h2>Enterprise</h2></html>';

  function enqueue(ts: string, sourceId = 1): void {
    db.prepare(`
      INSERT INTO backfill_queue (source_id, wayback_ts, target_url, state, attempts, updated_at)
      VALUES (?, ?, ?, 'pending', 0, '2026-08-19T07:00:00.000Z')
    `).run(sourceId, ts, `https://web.archive.org/web/${ts}id_/https://acme.test/pricing`);
  }

  it('dates the snapshot to the CAPTURE time, not to now (spec 12.1)', async () => {
    enqueue('20250116002909');

    const stats = await drainQueue(db, {}, { fetcher: async () => ok(PAGE), now: NOW });
    expect(stats).toMatchObject({ claimed: 1, stored: 1, deduped: 0, skipped: 0, failed: 0 });

    const snap = db.prepare('SELECT * FROM snapshots').get() as Record<string, unknown>;
    expect(snap.observed_at).toBe('2025-01-16T00:29:09.000Z');
    expect(snap.provenance).toBe('wayback:20250116002909');
    expect(snap.ok).toBe(1);
    expect(snap.raw_content).toBe(PAGE);
    expect(snap.normalized_hash).toBeNull();   // extract fills this in
  });

  it('sets fetched_at to the capture time so the cadence gate is unaffected (R5)', async () => {
    enqueue('20250116002909');
    await drainQueue(db, {}, { fetcher: async () => ok(PAGE), now: NOW });

    const snap = db.prepare('SELECT fetched_at FROM snapshots').get() as { fetched_at: string };
    expect(snap.fetched_at).toBe('2025-01-16T00:29:09.000Z');

    // The proof that matters: collect still considers the source due, proven
    // through the real cadence gate rather than a hand-copied query.
    const collected = await collect(db, { dryRun: true }, { fetcher: async () => ok(PAGE), now: NOW });
    expect(collected.attempted).toBe(1);
  });

  it('marks the queue row fetched and never re-fetches it', async () => {
    enqueue('20250116002909');
    let calls = 0;
    const fetcher = async () => { calls += 1; return ok(PAGE); };

    await drainQueue(db, {}, { fetcher, now: NOW });
    await drainQueue(db, {}, { fetcher, now: NOW });

    expect(calls).toBe(1);
    expect((db.prepare('SELECT state FROM backfill_queue').get() as { state: string }).state).toBe('fetched');
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(1);
  });

  it('stores identical captures content-addressed — row kept, bytes written once (spec 7.2)', async () => {
    enqueue('20250116002909');
    enqueue('20250209133622');

    const stats = await drainQueue(db, {}, { fetcher: async () => ok(PAGE), now: NOW });
    expect(stats).toMatchObject({ stored: 1, deduped: 1 });

    const snaps = db.prepare('SELECT raw_content, raw_hash FROM snapshots ORDER BY observed_at')
      .all() as { raw_content: string | null; raw_hash: string }[];
    expect(snaps).toHaveLength(2);
    expect(snaps[0]!.raw_content).toBe(PAGE);
    expect(snaps[1]!.raw_content).toBeNull();
    expect(snaps[1]!.raw_hash).toBe(snaps[0]!.raw_hash);
  });

  it('skips a capture with no price-like text and stores no snapshot (R7)', async () => {
    enqueue('20250116002909');

    const stats = await drainQueue(db, {}, {
      fetcher: async () => ok('<html><body>This page cannot be crawled.</body></html>'),
      now: NOW,
    });

    expect(stats).toMatchObject({ claimed: 1, stored: 0, skipped: 1, failed: 0 });
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT state FROM backfill_queue').get() as { state: string }).state).toBe('skipped');
  });

  it('never marks a source degraded, whatever the archive returns (R3)', async () => {
    enqueue('20250116002909');
    await drainQueue(db, {}, { fetcher: async () => ok('<html>no prices here</html>'), now: NOW });

    const source = db.prepare('SELECT degraded_reason FROM sources WHERE id = 1').get() as
      { degraded_reason: string | null };
    expect(source.degraded_reason).toBeNull();
  });

  it('records a fetch failure in the queue, not as an ok=0 snapshot (R6)', async () => {
    enqueue('20250116002909');

    const stats = await drainQueue(db, {}, {
      fetcher: async () => ({ ok: false, httpStatus: 503, body: null, error: 'HTTP 503' }),
      now: NOW,
    });

    expect(stats).toMatchObject({ claimed: 1, stored: 0, failed: 1 });
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(0);

    const row = db.prepare('SELECT state, attempts, last_error FROM backfill_queue').get() as
      { state: string; attempts: number; last_error: string };
    expect(row.state).toBe('pending');   // still retryable
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('503');
  });

  it('gives up on a row after MAX_CAPTURE_ATTEMPTS and stops retrying it', async () => {
    enqueue('20250116002909');
    const fail = async () => ({ ok: false, httpStatus: 503, body: null, error: 'HTTP 503' });

    for (let i = 0; i < MAX_CAPTURE_ATTEMPTS; i += 1) {
      await drainQueue(db, {}, { fetcher: fail, now: NOW });
    }
    expect((db.prepare('SELECT state FROM backfill_queue').get() as { state: string }).state).toBe('failed');

    let calls = 0;
    const stats = await drainQueue(db, {}, {
      fetcher: async () => { calls += 1; return fail(); },
      now: NOW,
    });
    expect(calls).toBe(0);
    expect(stats.claimed).toBe(0);
  });

  it('skips a queue row whose timestamp will not parse rather than dating it to the epoch', async () => {
    enqueue('not-a-timestamp');

    const stats = await drainQueue(db, {}, { fetcher: async () => ok(PAGE), now: NOW });

    expect(stats).toMatchObject({ claimed: 1, skipped: 1, stored: 0 });
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(0);
  });

  it('processes oldest capture first and honours --limit', async () => {
    enqueue('20250209133622');
    enqueue('20250116002909');

    const seen: string[] = [];
    const stats = await drainQueue(db, { limit: 1 }, {
      fetcher: async (url) => { seen.push(url); return ok(PAGE); },
      now: NOW,
    });

    expect(stats.claimed).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('20250116002909');
  });
});
