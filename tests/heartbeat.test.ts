import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { runHeartbeat } from '../src/ops/heartbeat.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string; let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

const ENV = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '1' } as NodeJS.ProcessEnv;

// 2026-08-17 is a Monday in CT (matches tests/synthesize.test.ts's fixture);
// 08-18 is the Tuesday right after it.
const NOW_MONDAY = new Date('2026-08-17T13:00:00.000Z');
const NOW_TUESDAY = new Date(NOW_MONDAY.getTime() + 86_400_000);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-heartbeat-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function sourceId(): number {
  return (db.prepare('SELECT id FROM sources LIMIT 1').get() as { id: number }).id;
}

function insertSnapshot(sourceIdVal: number, fetchedAt: string, ok: number): void {
  db.prepare(`
    INSERT INTO snapshots (source_id, observed_at, fetched_at, ok, provenance)
    VALUES (?, ?, ?, ?, 'live')
  `).run(sourceIdVal, fetchedAt, fetchedAt, ok);
}

function insertRun(kind: string, state: string, endedAt: string): void {
  db.prepare(`
    INSERT INTO runs (kind, started_at, ended_at, state, ok, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(kind, endedAt, endedAt, state, state === 'ok' ? 1 : 0, state === 'failed' ? `${kind} blew up` : null);
}

// The watchdog's absence check (M5 fix round) alerts on any of
// ['export', 'publish', 'backup'] that has never had an ok run once the
// archive (snapshots table) is non-empty — which is true in nearly every
// test below, since most seed at least one snapshot. This seeds a recent ok
// run for each of the three core kinds so a test can assert on the ONE
// thing it actually cares about without the absence check adding noise.
// restic is deliberately excluded: it's optional and its own tests below
// cover it directly.
function seedHealthyWatchdog(now: Date, kinds: string[] = ['export', 'publish', 'backup']): void {
  for (const kind of kinds) {
    insertRun(kind, 'ok', new Date(now.getTime() - 1 * 3_600_000).toISOString());
  }
}

function okFetch() {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

describe('runHeartbeat', () => {
  it('makes zero network calls when nothing is wrong and it is not Monday', async () => {
    insertSnapshot(sourceId(), NOW_TUESDAY.toISOString(), 1);
    seedHealthyWatchdog(NOW_TUESDAY);
    const fetchImpl = okFetch();

    const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

    expect(stats).toEqual({ alerts: [], allGreenSent: false, sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('flags a source with no ok snapshot in 48h as stale, naming its last-ok time', async () => {
    const id = sourceId();
    const lastOk = new Date(NOW_TUESDAY.getTime() - 49 * 3_600_000).toISOString();
    insertSnapshot(id, lastOk, 1);
    seedHealthyWatchdog(NOW_TUESDAY);
    const fetchImpl = okFetch();

    const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

    expect(stats.alerts).toHaveLength(1);
    expect(stats.alerts[0]).toContain('acme.test/pricing');
    expect(stats.alerts[0]).toContain(lastOk);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.text).toContain('Bellwether: 1 problem(s)');
  });

  it('pins the 48h stale boundary: 47h ago is fine, 49h ago is stale', async () => {
    const id = sourceId();
    seedHealthyWatchdog(NOW_TUESDAY);

    insertSnapshot(id, new Date(NOW_TUESDAY.getTime() - 47 * 3_600_000).toISOString(), 1);
    let stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl: okFetch() });
    expect(stats.alerts).toEqual([]);

    db.prepare('DELETE FROM snapshots').run();
    insertSnapshot(id, new Date(NOW_TUESDAY.getTime() - 49 * 3_600_000).toISOString(), 1);
    stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl: okFetch() });
    expect(stats.alerts).toHaveLength(1);
  });

  it('reports "never" for a stale source with no ok snapshot at all', async () => {
    // No snapshot inserted at all: the archive is empty, so the watchdog's
    // absence check stays silent too (fresh-install suppression) — the
    // only alert is the pre-existing stale-source one.
    const fetchImpl = okFetch();
    const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

    expect(stats.alerts).toHaveLength(1);
    expect(stats.alerts[0]).toContain('last ok: never');
  });

  it('flags a source with a degraded_reason', async () => {
    const id = sourceId();
    insertSnapshot(id, NOW_TUESDAY.toISOString(), 1); // not stale
    db.prepare('UPDATE sources SET degraded_reason = ? WHERE id = ?').run('canary missing', id);
    seedHealthyWatchdog(NOW_TUESDAY);
    const fetchImpl = okFetch();

    const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

    expect(stats.alerts).toHaveLength(1);
    expect(stats.alerts[0]).toContain('canary missing');
    expect(stats.alerts[0]).toContain('acme.test/pricing');
  });

  it('flags a failed export run inside the 25h watchdog window', async () => {
    insertSnapshot(sourceId(), NOW_TUESDAY.toISOString(), 1);
    // A recent ok run keeps the absence check quiet for export, isolating
    // this test to the failed-latest-run alert it's named for.
    insertRun('export', 'ok', new Date(NOW_TUESDAY.getTime() - 2 * 3_600_000).toISOString());
    insertRun('export', 'failed', new Date(NOW_TUESDAY.getTime() - 1 * 3_600_000).toISOString());
    seedHealthyWatchdog(NOW_TUESDAY, ['publish', 'backup']);
    const fetchImpl = okFetch();

    const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

    expect(stats.alerts).toHaveLength(1);
    expect(stats.alerts[0]).toContain('export failed');
  });

  it('flags a failed backup run inside the 25h watchdog window', async () => {
    insertSnapshot(sourceId(), NOW_TUESDAY.toISOString(), 1);
    insertRun('backup', 'ok', new Date(NOW_TUESDAY.getTime() - 2 * 3_600_000).toISOString());
    insertRun('backup', 'failed', new Date(NOW_TUESDAY.getTime() - 1 * 3_600_000).toISOString());
    seedHealthyWatchdog(NOW_TUESDAY, ['export', 'publish']);
    const fetchImpl = okFetch();

    const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

    expect(stats.alerts).toHaveLength(1);
    expect(stats.alerts[0]).toContain('backup failed');
  });

  it('does not flag a failed run outside the 25h watchdog window', async () => {
    insertSnapshot(sourceId(), NOW_TUESDAY.toISOString(), 1);
    // The failure is old, but a more recent ok run means it has since
    // recovered — this must stay quiet on both the failed-run check
    // (outside its window) and the absence check (recently ok).
    insertRun('export', 'failed', new Date(NOW_TUESDAY.getTime() - 26 * 3_600_000).toISOString());
    insertRun('export', 'ok', new Date(NOW_TUESDAY.getTime() - 1 * 3_600_000).toISOString());
    seedHealthyWatchdog(NOW_TUESDAY, ['publish', 'backup']);
    const fetchImpl = okFetch();

    const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

    expect(stats.alerts).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not flag a run kind whose latest run succeeded even if an older row failed recently', async () => {
    insertSnapshot(sourceId(), NOW_TUESDAY.toISOString(), 1);
    insertRun('export', 'failed', new Date(NOW_TUESDAY.getTime() - 2 * 3_600_000).toISOString());
    insertRun('export', 'ok', new Date(NOW_TUESDAY.getTime() - 1 * 3_600_000).toISOString());
    seedHealthyWatchdog(NOW_TUESDAY, ['publish', 'backup']);
    const fetchImpl = okFetch();

    const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

    expect(stats.alerts).toEqual([]);
  });

  it('joins every triggered alert into exactly one Telegram send', async () => {
    const id = sourceId();
    // stale (and archive stays empty throughout, since no snapshot is ever
    // inserted — so the absence check contributes nothing extra here)
    db.prepare('DELETE FROM snapshots').run();
    // degraded
    db.prepare('UPDATE sources SET degraded_reason = ? WHERE id = ?').run('canary missing', id);
    // watchdog
    insertRun('export', 'failed', new Date(NOW_TUESDAY.getTime() - 1 * 3_600_000).toISOString());
    insertRun('backup', 'failed', new Date(NOW_TUESDAY.getTime() - 1 * 3_600_000).toISOString());
    const fetchImpl = okFetch();

    const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

    expect(stats.alerts).toHaveLength(4); // stale, degraded, export watchdog, backup watchdog
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.text).toContain(`Bellwether: ${stats.alerts.length} problem(s)`);
    for (const alert of stats.alerts) expect(body.text).toContain(alert);
  });

  it('sends nothing on a healthy Tuesday', async () => {
    insertSnapshot(sourceId(), NOW_TUESDAY.toISOString(), 1);
    seedHealthyWatchdog(NOW_TUESDAY);
    const fetchImpl = okFetch();

    const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

    expect(stats).toEqual({ alerts: [], allGreenSent: false, sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the weekly all-green message on a healthy Monday in CT, with correct counts and spend', async () => {
    insertSnapshot(sourceId(), NOW_MONDAY.toISOString(), 1);
    insertRun('export', 'ok', '2026-08-17T07:00:00.000Z');
    insertRun('publish', 'ok', '2026-08-17T07:05:00.000Z');
    insertRun('backup', 'ok', '2026-08-17T07:30:00.000Z');
    db.prepare(`
      INSERT INTO digests (period_start, period_end, body_md, item_count, model, prompt_version, cost_micros, created_at)
      VALUES ('2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z', 'x', 1, 'm', 'v', 2_500_000, '2026-08-10T00:00:00.000Z')
    `).run();
    const fetchImpl = okFetch();

    const stats = await runHeartbeat(db, { now: () => NOW_MONDAY, env: ENV, fetchImpl });

    expect(stats.alerts).toEqual([]);
    expect(stats.allGreenSent).toBe(true);
    expect(stats.sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.text).toBe('all green: 1/1 sources healthy, last publish 2026-08-17T07:05:00.000Z, spend this month $2.50');
  });

  it('does not send the all-green message when Telegram is unconfigured, and reports sent: false', async () => {
    insertSnapshot(sourceId(), NOW_MONDAY.toISOString(), 1);
    seedHealthyWatchdog(NOW_MONDAY);
    const fetchImpl = okFetch();

    const stats = await runHeartbeat(db, { now: () => NOW_MONDAY, env: {} as NodeJS.ProcessEnv, fetchImpl });

    expect(stats.alerts).toEqual([]);
    expect(stats.allGreenSent).toBe(false);
    expect(stats.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not alert or send when Telegram is unconfigured even with real problems', async () => {
    // stale (no snapshots at all)
    const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: {} as NodeJS.ProcessEnv });

    expect(stats.alerts).toHaveLength(1); // the alert is still detected...
    expect(stats.sent).toBe(false);       // ...but nothing was actually sent
  });

  describe('watchdog absence check (spec 15.3: a run that never happens, not just one that fails)', () => {
    it('pins the 26h absence boundary: an ok run 25h59m ago is fine, 26h01m ago is not', async () => {
      insertSnapshot(sourceId(), NOW_TUESDAY.toISOString(), 1);
      seedHealthyWatchdog(NOW_TUESDAY, ['publish', 'backup']);

      insertRun('export', 'ok', new Date(NOW_TUESDAY.getTime() - (26 * 3_600_000 - 60_000)).toISOString());
      let stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl: okFetch() });
      expect(stats.alerts).toEqual([]);

      db.prepare("DELETE FROM runs WHERE kind = 'export'").run();
      insertRun('export', 'ok', new Date(NOW_TUESDAY.getTime() - (26 * 3_600_000 + 60_000)).toISOString());
      stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl: okFetch() });
      expect(stats.alerts).toHaveLength(1);
      expect(stats.alerts[0]).toContain('export');
      expect(stats.alerts[0]).toContain('26h');
    });

    it('stays quiet when a kind has never had an ok run but the archive is empty (fresh install)', async () => {
      // No snapshots inserted anywhere in this test, so the source itself
      // is also "stale" (that's a separate, pre-existing check) — the point
      // here is that the watchdog-absence check contributes nothing on top
      // of it: export/publish/backup having never run must not pile on
      // extra alerts when there's genuinely nothing collected yet.
      const fetchImpl = okFetch();
      const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

      expect(stats.alerts).toHaveLength(1);
      expect(stats.alerts[0]).toContain('Stale sources');
    });

    it('alerts when a kind has never had an ok run and the archive is non-empty', async () => {
      // Data has been collected (archive non-empty, source itself healthy),
      // but export/publish/backup have never run once — a site frozen since
      // day one must not report all-green. This is the exact bug the
      // absence check exists to catch.
      insertSnapshot(sourceId(), NOW_MONDAY.toISOString(), 1);
      const fetchImpl = okFetch();

      const stats = await runHeartbeat(db, { now: () => NOW_MONDAY, env: ENV, fetchImpl });

      expect(stats.alerts).toHaveLength(3);
      expect(stats.alerts.some(a => a.includes('export') && a.includes('never'))).toBe(true);
      expect(stats.alerts.some(a => a.includes('publish') && a.includes('never'))).toBe(true);
      expect(stats.alerts.some(a => a.includes('backup') && a.includes('never'))).toBe(true);
      expect(stats.allGreenSent).toBe(false);
    });

    it('never alerts on restic when it has never had an ok run (opt-in backup leg)', async () => {
      insertSnapshot(sourceId(), NOW_TUESDAY.toISOString(), 1);
      seedHealthyWatchdog(NOW_TUESDAY); // export, publish, backup healthy; restic untouched
      const fetchImpl = okFetch();

      const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

      expect(stats.alerts).toEqual([]);
    });

    it('does alert on restic once it has opted in and then gone stale', async () => {
      insertSnapshot(sourceId(), NOW_TUESDAY.toISOString(), 1);
      seedHealthyWatchdog(NOW_TUESDAY);
      insertRun('restic', 'ok', new Date(NOW_TUESDAY.getTime() - 27 * 3_600_000).toISOString());
      const fetchImpl = okFetch();

      const stats = await runHeartbeat(db, { now: () => NOW_TUESDAY, env: ENV, fetchImpl });

      expect(stats.alerts).toHaveLength(1);
      expect(stats.alerts[0]).toContain('restic');
    });
  });
});
