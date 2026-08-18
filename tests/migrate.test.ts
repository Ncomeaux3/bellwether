import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-mig-'));
  db = openDb(join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeMigration(name: string, sql: string): string {
  const migDir = join(dir, 'migrations');
  writeFileSync(join(migDir, name), sql);
  return migDir;
}

describe('openDb', () => {
  it('enables WAL and foreign keys', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('migrate', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'migrations'), { recursive: true });
  });

  it('applies pending migrations in filename order', () => {
    const migDir = writeMigration('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    writeMigration('002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');

    const applied = migrate(db, migDir);

    expect(applied).toEqual(['001_a.sql', '002_b.sql']);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain('a');
    expect(tables.map(t => t.name)).toContain('b');
  });

  it('is idempotent — a second run applies nothing', () => {
    const migDir = writeMigration('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    migrate(db, migDir);
    expect(migrate(db, migDir)).toEqual([]);
  });

  it('throws when an already-applied migration changes', () => {
    const migDir = writeMigration('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    migrate(db, migDir);
    writeMigration('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY, extra TEXT);');

    expect(() => migrate(db, migDir)).toThrow(/immutable/i);
  });

  it('rolls back a failing migration entirely', () => {
    const migDir = writeMigration(
      '001_bad.sql',
      'CREATE TABLE good (id INTEGER PRIMARY KEY); THIS IS NOT SQL;'
    );

    expect(() => migrate(db, migDir)).toThrow();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as { name: string }[];
    expect(tables.map(t => t.name)).not.toContain('good');
  });
});
