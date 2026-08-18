import type { DB } from './db.js';

export class RunLockedError extends Error {
  constructor(kind: string, startedAt: string) {
    super(
      `A ${kind} run started at ${startedAt} is still running. ` +
      `Wait for it to finish, or clear it if the process died: ` +
      `UPDATE runs SET state='crashed' WHERE kind='${kind}' AND state='running';`
    );
    this.name = 'RunLockedError';
  }
}

export interface RunDeps { now?: () => Date; staleHours?: number }

/**
 * Spec 15.5: single-writer lock. Cron overlap on a slow step would otherwise
 * put two writers on one SQLite file. Runs older than the stale window are
 * assumed dead — a crashed process never gets to mark itself failed.
 */
export function acquireRun(db: DB, kind: string, deps: RunDeps = {}): number {
  const now = (deps.now ?? (() => new Date()))();
  const staleHours = deps.staleHours ?? 6;
  const cutoff = new Date(now.getTime() - staleHours * 3600 * 1000).toISOString();

  return db.transaction(() => {
    db.prepare(
      "UPDATE runs SET state = 'crashed', ended_at = ?, error = 'exceeded stale window' " +
      "WHERE kind = ? AND state = 'running' AND started_at < ?"
    ).run(now.toISOString(), kind, cutoff);

    const held = db.prepare(
      "SELECT started_at FROM runs WHERE kind = ? AND state = 'running' ORDER BY started_at LIMIT 1"
    ).get(kind) as { started_at: string } | undefined;

    if (held) throw new RunLockedError(kind, held.started_at);

    const info = db.prepare(
      "INSERT INTO runs (kind, started_at, state) VALUES (?, ?, 'running')"
    ).run(kind, now.toISOString());

    return Number(info.lastInsertRowid);
  })();
}

export function finishRun(db: DB, id: number, ok: boolean, stats: unknown, error?: string): void {
  db.prepare(
    'UPDATE runs SET ended_at = ?, state = ?, ok = ?, stats_json = ?, error = ? WHERE id = ?'
  ).run(
    new Date().toISOString(),
    ok ? 'ok' : 'failed',
    ok ? 1 : 0,
    JSON.stringify(stats),
    error ?? null,
    id
  );
}
