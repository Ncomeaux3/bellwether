import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';

interface AppliedRow { version: string; checksum: string }

/**
 * Applies pending .sql files in filename order, inside a transaction each.
 * Spec 7: migrations are immutable — editing an applied file is a hard error,
 * because the DB it produced no longer matches the file that claims to describe it.
 */
export function migrate(db: DB, dir: string): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
  `);

  const prior = new Map(
    (db.prepare('SELECT version, checksum FROM schema_migrations').all() as AppliedRow[])
      .map(r => [r.version, r.checksum] as const)
  );

  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const seen = prior.get(file);

    if (seen === checksum) continue;
    if (seen !== undefined) {
      throw new Error(
        `Migration ${file} changed after it was applied. Migrations are immutable — ` +
        `add a new migration file instead of editing this one.`
      );
    }

    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)'
      ).run(file, new Date().toISOString(), checksum);
    })();

    applied.push(file);
  }

  return applied;
}
