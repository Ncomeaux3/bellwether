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
  .command('extract')
  .description('extract structured pricing from snapshots that lack it')
  .option('--limit <n>', 'process at most n snapshots', v => Number(v))
  .option('--dry-run', 'normalize and hash but make no LLM calls')
  .action(async (options: { limit?: number; dryRun?: boolean }) => {
    const { extract } = await import('./workflow/extract.js');
    const db = openDb(dbPath());
    const s = await extract(db, { limit: options.limit, dryRun: options.dryRun });
    console.log(
      `Considered ${s.considered}: ${s.extracted} extracted, ${s.cached} cached, ` +
      `${s.hashed} hashed, ${s.skipped} skipped, ${s.degraded} degraded, ${s.mismatched} non-USD.`,
    );
    db.close();
  });

program
  .command('export')
  .description('rebuild the published JSON from current database state')
  .option('--publish', 'commit and push the result so Vercel rebuilds')
  .action(async (options: { publish?: boolean }) => {
    const { exportData, publish, buildCommitMessage } = await import('./workflow/export.js');
    const db = openDb(dbPath());
    const outDir = resolve(process.env.BELLWETHER_EXPORT_DIR ?? './web/public/data');
    const stats = exportData(db, outDir);
    console.log(
      `Wrote ${stats.files.join(', ')} to ${outDir} — ` +
      `${stats.competitors} competitors, ${stats.healthySources}/${stats.totalSources} sources healthy.`
    );

    if (options.publish) {
      const changes = db.prepare(
        "SELECT COUNT(*) AS n FROM changes WHERE state = 'confirmed'"
      ).get() as { n: number };
      const message = buildCommitMessage({
        changes: changes.n,
        sources: stats.totalSources,
        date: new Date().toISOString().slice(0, 10),
      });
      const result = await publish(ROOT, message);
      console.log(result.pushed ? `Published: ${result.detail}` : result.detail);
    }

    db.close();
  });

program
  .command('start')
  .description('run the full daily pipeline once (migrate, seed, collect, export), then idle')
  .action(async () => {
    const { seedCompetitors } = await import('./config/seed.js');
    const { COMPETITORS } = await import('./config/competitors.public.js');
    const { collect } = await import('./workflow/collect.js');
    const { extract } = await import('./workflow/extract.js');
    const { exportData } = await import('./workflow/export.js');

    const db = openDb(dbPath());

    const applied = migrate(db, join(ROOT, 'migrations'));
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema is current.');

    const seedStats = seedCompetitors(db, COMPETITORS);
    console.log(`Seeded ${seedStats.competitors} competitors and ${seedStats.sources} sources.`);

    const collectStats = await collect(db, {});
    console.log(
      `Checked ${collectStats.attempted}: ${collectStats.stored} new, ${collectStats.unchanged} unchanged, ` +
      `${collectStats.failed} failed, ${collectStats.degraded} degraded, ${collectStats.cleared} recovered.`
    );

    const extractStats = await extract(db, {});
    console.log(
      `Extracted ${extractStats.extracted}, cached ${extractStats.cached}, ` +
      `skipped ${extractStats.skipped}, degraded ${extractStats.degraded}.`,
    );

    const outDir = resolve(process.env.BELLWETHER_EXPORT_DIR ?? './web/public/data');
    const exportStats = exportData(db, outDir);
    console.log(
      `Wrote ${exportStats.files.join(', ')} to ${outDir} — ` +
      `${exportStats.competitors} competitors, ${exportStats.healthySources}/${exportStats.totalSources} sources healthy.`
    );

    db.close();

    // Cron (M5) is out of scope, so this is the container's whole startup
    // sequence: run the daily pipeline once, then idle so the healthcheck
    // (which looks for a recent `runs` row) has something to find. Safe on
    // every container start/restart: collect()'s cadence gate skips any
    // source already fetched within its cadence_hours window, so a restart
    // loop re-runs migrate/seed (idempotent, no network) but re-fetches
    // nothing — see src/workflow/collect.ts. Never publishes: `export
    // --publish` needs a git remote and deploy key the container doesn't
    // have (see README).
    console.log('Pipeline complete; idling.');
    // A never-resolving promise does NOT hold Node open — the event loop empties
    // and the process exits, which under `restart: unless-stopped` produces a
    // silent restart loop. A live timer is what actually keeps the container up.
    // (Cron replaces this in M5.)
    await new Promise<never>(() => {
      setInterval(() => {}, 60_000);
    });
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
        // Publishing runs on the host, never in the container — the image carries
        // no .git directory and no deploy key. Reporting "fail" there would be a
        // permanent red the operator can never clear, so absence of a repo is
        // reported as not-applicable instead.
        try {
          await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT });
        } catch {
          return { ok: true, skipped: true, detail: 'not a git repository — publishing runs on the host, not in the container' };
        }
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
        : `\n${failures} check${failures === 1 ? ' needs' : 's need'} attention before this will run unattended.`
    );
    process.exit(failures === 0 ? 0 : 1);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  // ExportGuardError and RunLockedError carry messages written for a human
  // to read (e.g. "Run `bellwether seed` first"). Without this, they'd
  // surface as an unhandled-rejection stack trace — exactly what `doctor`
  // exists to avoid everywhere else.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
