import Database from 'better-sqlite3';

export type DB = Database.Database;

/**
 * Spec 6: WAL so readers never block the single writer — `export` can read
 * while `collect` writes. busy_timeout covers the brief lock during commit.
 */
export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
