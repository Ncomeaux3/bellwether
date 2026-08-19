import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

// Row count used by the backupSnapshot file-mechanics tests below (dated
// file creation, atomic same-day replace, pruning) — arbitrary, since those
// tests don't touch verifyBackup's tolerance at all.
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

// Fix round 1: the previous version of this suite built both sides off a
// shared 300-row fixture and a diff<=200-OR-2% tolerance, which made
// live=100/snapshot=0 PASS (0 diff is unreachable when everything shares
// one fixture, and 200 rows swallows the real archive's actual sizes —
// snapshots=120, extractions=99). These five build two INDEPENDENT
// archives at exact row counts each time, so nothing passes vacuously.
function buildArchive(name: string, rows: number): string {
  const archiveDir = join(dir, name);
  mkdirSync(archiveDir, { recursive: true });
  const path = join(archiveDir, 'archive.db');
  const archiveDb = openDb(path);
  migrate(archiveDb, join(process.cwd(), 'migrations'));
  seedCompetitors(archiveDb, CONFIG);
  seedRows(rows, archiveDb);
  archiveDb.close();
  return path;
}

describe('verifyBackup', () => {
  it('fails on an empty snapshot table against a small live archive — the real-archive case', () => {
    // snapshots=120 is close to the box's actual current count; a flat
    // 200-row tolerance would let a completely empty snapshot pass here,
    // which is exactly the bug this tolerance rewrite exists to fix.
    const live = buildArchive('live-a', 120);
    const snapshot = buildArchive('snap-a', 0);

    const verify = verifyBackup(live, snapshot);

    expect(verify.ok).toBe(false);
    expect(verify.detail).toContain('snapshots');
    expect(verify.counts.snapshots).toEqual({ live: 120, snapshot: 0 });
  });

  it('passes when the snapshot is a couple of rows behind live (normal lag)', () => {
    const live = buildArchive('live-b', 120);
    const snapshot = buildArchive('snap-b', 118);

    const verify = verifyBackup(live, snapshot);

    expect(verify.ok).toBe(true);
  });

  it('passes on a fresh install with nothing in either archive', () => {
    const live = buildArchive('live-c', 0);
    const snapshot = buildArchive('snap-c', 0);

    const verify = verifyBackup(live, snapshot);

    expect(verify.ok).toBe(true);
  });

  it('fails when the snapshot has far MORE rows than live (comparing the wrong files)', () => {
    const live = buildArchive('live-d', 100);
    const snapshot = buildArchive('snap-d', 500);

    const verify = verifyBackup(live, snapshot);

    expect(verify.ok).toBe(false);
    expect(verify.counts.snapshots!.snapshot).toBeGreaterThan(verify.counts.snapshots!.live);
  });

  it('fails at scale when 5% of rows are missing (truncation, not lag)', () => {
    const live = buildArchive('live-e', 10_000);
    const snapshot = buildArchive('snap-e', 9_500);

    const verify = verifyBackup(live, snapshot);

    expect(verify.ok).toBe(false);
    expect(verify.detail).toContain('below the floor');
  });
});
