import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { RunLockedError, acquireRun, finishRun } from '../src/ops/runs.js';

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-runs-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireRun', () => {
  it('creates a running row', () => {
    const id = acquireRun(db, 'collect');
    const row = db.prepare('SELECT kind, state FROM runs WHERE id = ?').get(id) as
      { kind: string; state: string };
    expect(row).toEqual({ kind: 'collect', state: 'running' });
  });

  it('refuses a second run of the same kind while one is running', () => {
    acquireRun(db, 'collect');
    expect(() => acquireRun(db, 'collect')).toThrow(RunLockedError);
  });

  it('allows a different kind to run concurrently', () => {
    acquireRun(db, 'collect');
    expect(() => acquireRun(db, 'export')).not.toThrow();
  });

  it('marks a run older than 6 hours as crashed and proceeds', () => {
    const stale = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    db.prepare("INSERT INTO runs (kind, started_at, state) VALUES ('collect', ?, 'running')").run(stale);

    const id = acquireRun(db, 'collect');

    const crashed = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state = 'crashed'").get() as { n: number };
    expect(crashed.n).toBe(1);
    expect(id).toBeGreaterThan(0);
  });

  it('allows a new run after the previous one finished', () => {
    finishRun(db, acquireRun(db, 'collect'), true, { stored: 1 });
    expect(() => acquireRun(db, 'collect')).not.toThrow();
  });
});

describe('finishRun', () => {
  it('records success with stats', () => {
    const id = acquireRun(db, 'collect');
    finishRun(db, id, true, { stored: 3 });

    const row = db.prepare('SELECT state, ok, stats_json, ended_at FROM runs WHERE id = ?').get(id) as
      { state: string; ok: number; stats_json: string; ended_at: string };
    expect(row.state).toBe('ok');
    expect(row.ok).toBe(1);
    expect(JSON.parse(row.stats_json)).toEqual({ stored: 3 });
    expect(row.ended_at).toBeTruthy();
  });

  it('records failure with the error text', () => {
    const id = acquireRun(db, 'collect');
    finishRun(db, id, false, {}, 'network down');

    const row = db.prepare('SELECT state, ok, error FROM runs WHERE id = ?').get(id) as
      { state: string; ok: number; error: string };
    expect(row.state).toBe('failed');
    expect(row.ok).toBe(0);
    expect(row.error).toBe('network down');
  });
});
