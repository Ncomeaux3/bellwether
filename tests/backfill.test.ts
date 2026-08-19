import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import {
  discoverCaptures, drainQueue, MAX_CAPTURE_ATTEMPTS,
  estimateBackfill, runBackfill, FALLBACK_COST_MICROS_PER_EXTRACTION,
} from '../src/workflow/backfill.js';
import { collect } from '../src/workflow/collect.js';
import type { FetchResult } from '../src/tools/fetch.js';
import type { CompetitorConfig } from '../src/config/types.js';
import type { ExtractResult } from '../src/agents/extract_pricing.js';

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

describe('estimateBackfill', () => {
  function enqueuePending(n: number): void {
    const stmt = db.prepare(`
      INSERT INTO backfill_queue (source_id, wayback_ts, target_url, state, attempts, updated_at)
      VALUES (1, ?, 'https://web.archive.org/x', 'pending', 0, '2026-08-19T00:00:00.000Z')
    `);
    // Arithmetic, not string surgery: every stamp is a distinct 14 digits, so
    // the UNIQUE (source_id, wayback_ts) constraint never trips mid-test.
    for (let i = 0; i < n; i += 1) stmt.run(String(20250101000000 + i));
  }

  it('uses the measured mean cost once extractions exist', () => {
    db.prepare(`
      INSERT INTO extractions
        (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
         is_backfill, model, prompt_version, input_tokens, output_tokens, cost_micros, created_at)
      VALUES ('h1','pricing','{}','high','USD',1,0,'m','v',1,1,8000,'2026-08-01T00:00:00.000Z')
    `).run();
    enqueuePending(10);

    const est = estimateBackfill(db, 10);
    expect(est.meanCostMicros).toBe(8000);
    expect(est.pending).toBe(10);
    expect(est.estimateMicros).toBe(80_000);
    expect(est.withinBudget).toBe(true);
    expect(est.maxCalls).toBe(1250);
  });

  it('falls back to the measured constant on an empty extractions table', () => {
    enqueuePending(4);
    const est = estimateBackfill(db, 10);
    expect(est.meanCostMicros).toBe(FALLBACK_COST_MICROS_PER_EXTRACTION);
    expect(est.estimateMicros).toBe(4 * FALLBACK_COST_MICROS_PER_EXTRACTION);
  });

  it('reports over-budget rather than silently truncating', () => {
    enqueuePending(200);
    const est = estimateBackfill(db, 0.5);
    expect(est.withinBudget).toBe(false);
    expect(est.maxCalls).toBe(50);
  });

  it('counts only pending rows — a drained queue estimates zero', () => {
    enqueuePending(5);
    db.prepare("UPDATE backfill_queue SET state = 'fetched'").run();
    expect(estimateBackfill(db, 10).pending).toBe(0);
  });

  it('caps the queue contribution at --limit, so a sliced run costs only the slice', () => {
    enqueuePending(10);
    expect(estimateBackfill(db, 10, 3).pending).toBe(3);
    // No limit given: the whole queue counts, same as before.
    expect(estimateBackfill(db, 10).pending).toBe(10);
  });

  it('counts drained-but-unextracted snapshots too — the backlog a sliced run leaves behind', () => {
    db.prepare(`
      INSERT INTO snapshots
        (source_id, observed_at, fetched_at, ok, http_status, error,
         raw_content, raw_hash, normalized_hash, provenance)
      VALUES (1, '2025-01-16T00:00:00.000Z', '2025-01-16T00:00:00.000Z', 1, 200, NULL,
              '<html>$20</html>', 'rawh', NULL, 'wayback:20250116000000')
    `).run();

    // Nothing left in the queue — a naive "queue rows only" estimate would say zero.
    const est = estimateBackfill(db, 10);
    expect(est.pending).toBe(1);
  });
});

describe('runBackfill', () => {
  const PAGE = '<html><h2>Pro</h2><p>$20/mo</p><h2>Enterprise</h2></html>';

  function router(cdx: string, page: string) {
    return async (url: string): Promise<FetchResult> =>
      url.includes('/cdx/search/') ? ok(cdx) : ok(page);
  }

  it('discovers, drains, and leaves capture-dated snapshots behind', async () => {
    const stats = await runBackfill(db, { llmEnabled: false }, {
      fetcher: router(cdxBody('20250116002909', '20250209133622'), PAGE),
      now: NOW,
    });

    expect(stats.discover.enqueued).toBe(2);
    expect(stats.drain.claimed).toBe(2);

    const snaps = db.prepare('SELECT observed_at, provenance FROM snapshots ORDER BY observed_at')
      .all() as { observed_at: string; provenance: string }[];
    expect(snaps.map(s => s.observed_at)).toEqual([
      '2025-01-16T00:29:09.000Z', '2025-02-09T13:36:22.000Z',
    ]);
    expect(snaps.every(s => s.provenance.startsWith('wayback:'))).toBe(true);
  });

  it('refuses to spend past the budget and drains nothing', async () => {
    const stats = await runBackfill(db, { budgetUsd: 0, llmEnabled: false }, {
      fetcher: router(cdxBody('20250116002909'), PAGE),
      now: NOW,
    });

    expect(stats.estimate.withinBudget).toBe(false);
    expect(stats.drain.claimed).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(0);
    // Discovery still ran, so raising the budget and re-running costs no extra CDX calls.
    expect((db.prepare('SELECT COUNT(*) n FROM backfill_queue').get() as { n: number }).n).toBe(1);
  });

  it('--discover-only enqueues and stops', async () => {
    const stats = await runBackfill(db, { discoverOnly: true }, {
      fetcher: router(cdxBody('20250116002909'), PAGE),
      now: NOW,
    });

    expect(stats.discover.enqueued).toBe(1);
    expect(stats.drain.claimed).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(0);
  });

  it('rebuilds detection so pre-existing changes are re-derived across the new history (spec 12.2)', async () => {
    db.prepare(`
      INSERT INTO changes
        (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
         before_json, after_json, materiality, state, observed_at)
      VALUES (1, 1, 2, 'price_change', 'tiers.Pro.monthly_price_usd', '10', '20', 80,
              'confirmed', '2026-08-01T00:00:00.000Z')
    `).run();

    await runBackfill(db, { llmEnabled: false }, {
      fetcher: router(cdxBody('20250116002909'), PAGE),
      now: NOW,
    });

    // The stale row named snapshots that no longer pair; rebuild must clear it
    // rather than leave a change spanning newly-inserted history.
    expect((db.prepare('SELECT COUNT(*) n FROM changes').get() as { n: number }).n).toBe(0);
  });

  it('records one backfill run and marks it ok', async () => {
    await runBackfill(db, { llmEnabled: false }, {
      fetcher: router(cdxBody('20250116002909'), PAGE),
      now: NOW,
    });

    const run = db.prepare("SELECT state, ok FROM runs WHERE kind = 'backfill'").get() as
      { state: string; ok: number };
    expect(run.state).toBe('ok');
    expect(run.ok).toBe(1);
  });

  it('threads estimate.maxCalls through to extract as --limit, so a sliced, tightly-budgeted run makes exactly that many calls', async () => {
    const okResult: ExtractResult = {
      ok: true,
      data: {
        currency: 'USD',
        tiers: [{
          name: 'Pro', monthly_price_usd: 20, annual_price_usd: null,
          billing_unit: 'per_seat', included_seats: null,
          is_free: false, is_enterprise: false, headline_features: [],
        }],
        usage_rates: [], notes: null, extraction_confidence: 'high',
      },
      inputTokens: 6_000, outputTokens: 600, costMicros: 9_000, attempts: 1,
    };

    let calls = 0;
    const extractor = async (): Promise<ExtractResult> => { calls += 1; return okResult; };

    // Five distinct captures, each with distinct page text so none dedup
    // against each other or cache against a shared extraction. --limit slices
    // the queue down to 2 (fix 3), and the budget is set to cover exactly
    // that slice at the fallback mean cost — "low" relative to what all five
    // would cost ($0.05), not relative to the two actually drained.
    const fetcher = async (url: string): Promise<FetchResult> => {
      if (url.includes('/cdx/search/')) {
        return ok(cdxBody(
          '20250101000000', '20250102000000', '20250103000000', '20250104000000', '20250105000000',
        ));
      }
      const ts = /web\/(\d{14})id_/.exec(url)?.[1] ?? '0';
      return ok(`<html><h2>Pro</h2><p>$${ts}/mo</p><h2>Enterprise</h2></html>`);
    };

    // runBackfill forwards no env of its own to extract() — same as the real
    // CLI, extract's LLM_ENABLED gate reads process.env, so exercising a real
    // (stubbed) extractor call here means toggling it like an operator would.
    const prevLlmEnabled = process.env.LLM_ENABLED;
    process.env.LLM_ENABLED = 'true';
    let stats;
    try {
      stats = await runBackfill(db, { budgetUsd: 0.02, limit: 2 }, {
        fetcher, extractor, now: NOW,
      });
    } finally {
      if (prevLlmEnabled === undefined) delete process.env.LLM_ENABLED;
      else process.env.LLM_ENABLED = prevLlmEnabled;
    }

    expect(stats.estimate.withinBudget).toBe(true);
    expect(stats.estimate.pending).toBe(2);          // capped by --limit, not the full queue of 5
    expect(stats.estimate.maxCalls).toBe(2);
    expect(stats.drain.claimed).toBe(2);
    expect(calls).toBe(2);
    expect(stats.extracted).toBe(2);
  });
});
