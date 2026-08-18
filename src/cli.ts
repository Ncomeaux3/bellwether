#!/usr/bin/env tsx
import { Command } from 'commander';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { openDb } from './ops/db.js';
import { migrate } from './ops/migrate.js';
import { VERSION } from './version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function dbPath(): string {
  const p = process.env.BELLWETHER_DB ?? './data/bellwether.db';
  mkdirSync(dirname(resolve(p)), { recursive: true });
  return resolve(p);
}

const program = new Command();
program.name('bellwether').version(VERSION);

program
  .command('migrate')
  .description('apply pending database migrations')
  .action(() => {
    const db = openDb(dbPath());
    const applied = migrate(db, join(ROOT, 'migrations'));
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema is current.');
    db.close();
  });

program
  .command('seed')
  .description('load the public competitor config into the database')
  .action(async () => {
    const { seedCompetitors } = await import('./config/seed.js');
    const { COMPETITORS } = await import('./config/competitors.public.js');
    const db = openDb(dbPath());
    const stats = seedCompetitors(db, COMPETITORS);
    console.log(`Seeded ${stats.competitors} competitors and ${stats.sources} sources.`);
    db.close();
  });

program
  .command('collect')
  .description('fetch every source that is past its cadence')
  .option('--limit <n>', 'process at most n sources', v => Number(v))
  .option('--dry-run', 'fetch but write nothing')
  .action(async (options: { limit?: number; dryRun?: boolean }) => {
    const { collect } = await import('./workflow/collect.js');
    const db = openDb(dbPath());
    const stats = await collect(db, { limit: options.limit, dryRun: options.dryRun });
    console.log(
      `Checked ${stats.attempted}: ${stats.stored} new, ${stats.unchanged} unchanged, ` +
      `${stats.failed} failed, ${stats.degraded} degraded, ${stats.cleared} recovered.`
    );
    db.close();
  });

program.parseAsync(process.argv);
