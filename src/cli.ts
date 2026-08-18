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

program
  .command('export')
  .description('rebuild the published JSON from current database state')
  .action(async () => {
    const { exportData } = await import('./workflow/export.js');
    const db = openDb(dbPath());
    const outDir = resolve(process.env.BELLWETHER_EXPORT_DIR ?? './web/public/data');
    const stats = exportData(db, outDir);
    console.log(
      `Wrote ${stats.files.join(', ')} to ${outDir} — ` +
      `${stats.competitors} competitors, ${stats.healthySources}/${stats.totalSources} sources healthy.`
    );
    db.close();
  });

program
  .command('doctor')
  .description('check that everything needed to run is present and working')
  .action(async () => {
    const { runDoctor } = await import('./ops/doctor.js');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);

    const db = openDb(dbPath());
    const results = await runDoctor({
      db,
      env: process.env,
      gitPush: async () => {
        try {
          await run('git', ['push', '--dry-run', 'origin', 'HEAD'], { cwd: ROOT });
          return { ok: true, detail: 'deploy key can push to origin' };
        } catch (err) {
          return { ok: false, detail: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
        }
      },
    });
    db.close();

    const mark = { ok: '  ok  ', fail: ' FAIL ', pending: '  --  ' } as const;
    for (const r of results) {
      console.log(`[${mark[r.status]}] ${r.name.padEnd(24)} ${r.detail}`);
      if (r.fix) console.log(`${' '.repeat(11)}fix: ${r.fix}`);
    }

    const failures = results.filter(r => r.status === 'fail').length;
    console.log(
      failures === 0
        ? '\nAll checks passed. Run `docker compose up -d` to start collecting.'
        : `\n${failures} check${failures === 1 ? '' : 's'} need attention before this will run unattended.`
    );
    process.exit(failures === 0 ? 0 : 1);
  });

program.parseAsync(process.argv);
