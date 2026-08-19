import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from './db.js';

const KEEP_LOCAL = 7;
const NAME_RE = /^bellwether-\d{8}\.db$/;
// Spec 7.3: row counts a restore is checked against — the tables that carry
// the archive's actual content, not lookup/config tables.
const VERIFY_TABLES = ['snapshots', 'extractions', 'changes'] as const;

function stamp(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export interface BackupDeps { now?: () => Date }
export interface BackupResult { path: string; bytes: number; pruned: string[] }

/**
 * Spec 7.3: nightly `VACUUM INTO` a dated snapshot. SQLite's `VACUUM INTO`
 * refuses to overwrite an existing file, so a same-day re-run (a manual
 * retry, a crashed cron job run again) writes to `<name>.tmp` and renames
 * over the target — idempotent and atomic either way. Pure: no telegram, no
 * `runs` row — the CLI layer owns those so this stays unit-testable.
 */
export function backupSnapshot(db: DB, dir: string, deps: BackupDeps = {}): BackupResult {
  const now = (deps.now ?? (() => new Date()))();
  mkdirSync(dir, { recursive: true });

  const target = join(dir, `bellwether-${stamp(now)}.db`);
  const tmp = `${target}.tmp`;

  try { unlinkSync(tmp); } catch { /* no leftover .tmp from a prior crash */ }
  db.prepare('VACUUM INTO ?').run(tmp);
  renameSync(tmp, target);

  const bytes = statSync(target).size;

  // Filename sort is chronological (YYYYMMDD), so the oldest names sort
  // first — keep the newest KEEP_LOCAL, prune the rest.
  const existing = readdirSync(dir).filter(f => NAME_RE.test(f)).sort();
  const excess = existing.length - KEEP_LOCAL;
  const pruned = excess > 0 ? existing.slice(0, excess) : [];
  for (const f of pruned) unlinkSync(join(dir, f));

  return { path: target, bytes, pruned };
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
  counts: Record<string, { live: number; snapshot: number }>;
}

// A snapshot is legitimately a little behind live (it is taken minutes
// earlier), but it must never be a fraction of it: the failure this exists
// to catch is a truncated or half-written file, and a flat row-count floor
// cannot catch that on a small archive — at 120 live rows a 200-row
// tolerance passes an EMPTY snapshot. The floor is therefore proportional,
// and the upper bound (live + a small overage) catches comparing the wrong
// pair of files. live=0 passes trivially — a fresh install has nothing to
// be truncated.
//
// Floor is 97%, not the 90% first floated for this rule: at 10,000 rows a
// 90% floor tolerates 1,000 missing, so a 5%-truncated file (9,500 rows)
// would still pass — exactly the kind of at-scale truncation this check
// exists to catch. 97% fails that case while still passing a 120-row
// archive lagging by 2 rows (118/120).
function tolerance(live: number, snapshot: number): { ok: boolean; bound?: 'floor' | 'ceiling' } {
  const floor = Math.floor(live * 0.97);
  const overage = Math.max(10, Math.ceil(live * 0.02));
  if (snapshot < floor) return { ok: false, bound: 'floor' };
  if (snapshot > live + overage) return { ok: false, bound: 'ceiling' };
  return { ok: true };
}

/**
 * Spec 7.3: restore is tested, not assumed. Opens both files readonly and
 * compares row counts for the tables that carry the archive's content.
 * Pure: no telegram — the CLI layer alerts on `ok: false`.
 */
export function verifyBackup(livePath: string, snapshotPath: string): VerifyResult {
  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });

  try {
    const counts: VerifyResult['counts'] = {};
    let failing: { table: string; bound: 'floor' | 'ceiling' } | undefined;

    for (const table of VERIFY_TABLES) {
      const liveCount = (live.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const snapCount = (snapshot.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      counts[table] = { live: liveCount, snapshot: snapCount };
      if (!failing) {
        const check = tolerance(liveCount, snapCount);
        if (!check.ok) failing = { table, bound: check.bound! };
      }
    }

    if (failing) {
      const c = counts[failing.table]!;
      const crossed = failing.bound === 'floor' ? 'below the floor' : 'above the ceiling';
      return {
        ok: false,
        detail: `${failing.table}: live=${c.live} snapshot=${c.snapshot} (${crossed})`,
        counts,
      };
    }
    return { ok: true, detail: 'within tolerance', counts };
  } finally {
    live.close();
    snapshot.close();
  }
}
