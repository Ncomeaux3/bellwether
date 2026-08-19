import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { backupSnapshot, verifyBackup } from '../src/ops/backup.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string; let db: DB; let dbPath: string;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

// The row-count tolerance is "diff <= 200 OR diff <= 2% of live" — with the
// 2% branch essentially inert below ~10,000 rows, so exercising both a
// legitimate few-rows-behind pass AND a genuine failure needs a live row
// count well above 200. 300 keeps setup fast while giving both branches a
// diff that actually crosses/stays under the 200-row floor.
const SEED_ROWS = 300;

function sourceId(target: DB = db): number {
  return (target.prepare('SELECT id FROM sources LIMIT 1').get() as { id: number }).id;
}

function seedRows(n: number, target: DB = db): void {
  const sid = sourceId(target);
  const before = (target.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n;
  for (let i = before; i < before + n; i++) {
    target.prepare(`
      INSERT INTO snapshots (source_id, observed_at, fetched_at, ok, provenance)
      VALUES (?, ?, ?, 1, 'live')
    `).run(sid, `2026-01-01T00:00:00.${String(i).padStart(3, '0')}Z`, `2026-01-01T00:00:00.${String(i).padStart(3, '0')}Z`);

    target.prepare(`
      INSERT INTO extractions
        (normalized_hash, source_kind, data_json, extraction_confidence, model, prompt_version, created_at)
      VALUES (?, 'pricing', '{}', 'high', 'test', 'v1', '2026-01-01T00:00:00.000Z')
    `).run(`hash-${i}`);

    target.prepare(`
      INSERT INTO changes
        (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path, materiality, observed_at)
      VALUES (?, ?, ?, 'price', '$.tiers[0].price', 1, '2026-01-01T00:00:00.000Z')
    `).run(sid, i, i + 1);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-backup-'));
  dbPath = join(dir, 'bellwether.db');
  db = openDb(dbPath);
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
  seedRows(SEED_ROWS);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('backupSnapshot', () => {
  it('creates a dated file that opens as a valid db with the same row counts as live', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    const result = backupSnapshot(db, join(dir, 'backup'), { now: () => now });

    expect(result.path).toBe(join(dir, 'backup', 'bellwether-20260819.db'));
    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.pruned).toEqual([]);

    const snap = new Database(result.path, { readonly: true, fileMustExist: true });
    const liveCount = (db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n;
    const snapCount = (snap.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n;
    snap.close();
    expect(snapCount).toBe(liveCount);
  });

  it('replaces a same-day snapshot atomically on re-run, leaving no .tmp litter', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    backupSnapshot(db, join(dir, 'backup'), { now: () => now });

    seedRows(1); // live changes between the two runs, proving the file was actually replaced

    expect(() => backupSnapshot(db, join(dir, 'backup'), { now: () => now })).not.toThrow();

    const files = readdirSync(join(dir, 'backup'));
    expect(files).toEqual(['bellwether-20260819.db']);

    const snap = new Database(join(dir, 'backup', 'bellwether-20260819.db'), { readonly: true, fileMustExist: true });
    const liveCount = (db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n;
    const snapCount = (snap.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n;
    snap.close();
    expect(snapCount).toBe(liveCount);
  });

  it('prunes local snapshots to exactly the 7 newest, returning the pruned basenames', () => {
    const backupDir = join(dir, 'backup');
    // Prune runs on every call, so with 9 sequential days the two oldest are
    // each pruned on their own call (day 8's run prunes day 1, day 9's run
    // prunes day 2) rather than both landing in the final call's result.
    const dates = Array.from({ length: 9 }, (_, i) => new Date(Date.UTC(2026, 7, 10 + i, 12)));

    const prunedAcrossAllRuns: string[] = [];
    for (const now of dates) {
      const result = backupSnapshot(db, backupDir, { now: () => now });
      prunedAcrossAllRuns.push(...result.pruned);
    }

    expect(prunedAcrossAllRuns).toEqual(['bellwether-20260810.db', 'bellwether-20260811.db']);

    const remaining = readdirSync(backupDir).sort();
    expect(remaining).toHaveLength(7);
    expect(remaining[0]).toBe('bellwether-20260812.db');
    expect(remaining.at(-1)).toBe('bellwether-20260818.db');
  });
});

describe('verifyBackup', () => {
  it('passes when the snapshot matches live exactly', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    const result = backupSnapshot(db, join(dir, 'backup'), { now: () => now });

    const verify = verifyBackup(dbPath, result.path);

    expect(verify.ok).toBe(true);
    expect(verify.counts.snapshots).toEqual({ live: SEED_ROWS, snapshot: SEED_ROWS });
  });

  it('passes when the snapshot is a few rows behind live (legitimate drift)', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    const result = backupSnapshot(db, join(dir, 'backup'), { now: () => now });

    seedRows(5); // live moves on after the snapshot was taken

    const verify = verifyBackup(dbPath, result.path);

    expect(verify.ok).toBe(true);
    expect(verify.counts.snapshots).toEqual({ live: SEED_ROWS + 5, snapshot: SEED_ROWS });
  });

  it('fails, naming the table and both counts, when the snapshot is truncated well past tolerance', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    const result = backupSnapshot(db, join(dir, 'backup'), { now: () => now });

    const snap = new Database(result.path);
    snap.prepare('DELETE FROM snapshots WHERE id > 50').run(); // 250-row shortfall: past both 200 and 2%
    snap.close();

    const verify = verifyBackup(dbPath, result.path);

    expect(verify.ok).toBe(false);
    expect(verify.detail).toBe(`snapshots: live=${SEED_ROWS} snapshot=50`);
    expect(verify.counts.snapshots).toEqual({ live: SEED_ROWS, snapshot: 50 });
  });

  it('fails when the snapshot has far MORE rows than live (comparing the wrong files)', () => {
    const now = new Date('2026-08-19T12:00:00.000Z');
    const result = backupSnapshot(db, join(dir, 'backup'), { now: () => now });

    const snap = new Database(result.path, { fileMustExist: true });
    seedRows(SEED_ROWS, snap); // doubles the snapshot's row counts without touching live
    snap.close();

    const verify = verifyBackup(dbPath, result.path);

    expect(verify.ok).toBe(false);
    expect(verify.counts.snapshots!.snapshot).toBeGreaterThan(verify.counts.snapshots!.live);
  });
});
