import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { discoverCaptures } from '../src/workflow/backfill.js';
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
