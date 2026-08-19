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

// Fix round 2 ruling: the property this check defends is completeness, not
// currency. The realistic failure modes are an empty file, a wrong file, or
// a file that will not open — not a precisely-95%-truncated SQLite
// database, which is not a real failure mode. The earlier 97% floor was
// chosen against that theoretical partial-truncation case, and in exchange
// it broke the thing this check most needs to survive: the documented
// manual restore rehearsal. Live grows ~6 snapshots/day against ~120 total
// (~5%/day), so any snapshot restored more than ~14 hours ago already reads
// "below the floor" — a perfectly good backup taught the operator it was
// broken. 50% still catches every real failure (an empty or wildly
// truncated file) while giving currency drift, including a day-old
// rehearsal snapshot, room to pass. The explicit non-empty rule below is
// the floor's backstop at small row counts, where 50% itself can round
// down to 0 and let an empty snapshot slip through. The ceiling (live + a
// small overage) is unchanged — it catches comparing the wrong pair of
// files. live=0 passes trivially — a fresh install has nothing to truncate.
function tolerance(live: number, snapshot: number): { ok: boolean; bound?: 'floor' | 'ceiling' } {
  if (live > 0 && snapshot === 0) return { ok: false, bound: 'floor' };
  const floor = Math.floor(live * 0.5);
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

    // Currency isn't a pass/fail condition any more (see the ruling above),
    // but an operator staring at "OK" still wants to know how stale the
    // snapshot is — surfaced here rather than silently dropped.
    const primary = counts.snapshots!;
    const behindPct = primary.live > 0
      ? Math.round(((primary.live - primary.snapshot) / primary.live) * 100)
      : 0;
    const drift = behindPct > 0 ? ` (${behindPct}% behind)` : '';
    return {
      ok: true,
      detail: `within tolerance: snapshots ${primary.snapshot}/${primary.live}${drift}`,
      counts,
    };
  } finally {
    live.close();
    snapshot.close();
  }
}
