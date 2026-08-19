import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { recordRun } from '../src/ops/runs.js';

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-ops-record-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// recordRun is the pure logic behind `bw ops record` (src/cli.ts): the
// host-side legs (ops/publish.sh, ops/backup.sh) run outside this process
// entirely, so there is no in-process run to acquire/finish — the work
// already happened by the time this is called.
describe('recordRun', () => {
  it('inserts a completed ok row with started_at = ended_at = now, and no error', () => {
    const now = new Date('2026-08-19T07:05:00.000Z');
    recordRun(db, 'publish', true, undefined, { now: () => now });

    const row = db.prepare('SELECT kind, started_at, ended_at, state, ok, error FROM runs').get() as
      { kind: string; started_at: string; ended_at: string; state: string; ok: number; error: string | null };

    expect(row.kind).toBe('publish');
    expect(row.started_at).toBe(now.toISOString());
    expect(row.ended_at).toBe(now.toISOString());
    expect(row.state).toBe('ok');
    expect(row.ok).toBe(1);
    expect(row.error).toBeNull();
  });

  it('discards detail on an ok row — a success never carries an error message', () => {
    recordRun(db, 'publish', true, 'pushed 2 changes, 5 sources');

    const row = db.prepare('SELECT error FROM runs').get() as { error: string | null };
    expect(row.error).toBeNull();
  });

  it('inserts a failed row with detail as the error message', () => {
    recordRun(db, 'restic', false, 'restic backup failed');

    const row = db.prepare('SELECT kind, state, ok, error FROM runs').get() as
      { kind: string; state: string; ok: number; error: string | null };

    expect(row.kind).toBe('restic');
    expect(row.state).toBe('failed');
    expect(row.ok).toBe(0);
    expect(row.error).toBe('restic backup failed');
  });

  it('records a failed row with no detail as a null error, not a crash', () => {
    recordRun(db, 'restic', false);

    const row = db.prepare('SELECT error FROM runs').get() as { error: string | null };
    expect(row.error).toBeNull();
  });

  it('does not touch any other run of the same kind (each call is one completed row)', () => {
    recordRun(db, 'publish', true, undefined, { now: () => new Date('2026-08-18T07:00:00.000Z') });
    recordRun(db, 'publish', false, 'git push failed', { now: () => new Date('2026-08-19T07:00:00.000Z') });

    const rows = db.prepare("SELECT state FROM runs WHERE kind = 'publish' ORDER BY id").all() as { state: string }[];
    expect(rows).toEqual([{ state: 'ok' }, { state: 'failed' }]);
  });
});
