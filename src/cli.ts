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
      `${s.hashed} hashed, ${s.skipped} skipped, ${s.degraded} degraded, ` +
      `${s.historicalFailed} historical failed, ${s.mismatched} non-USD.`,
    );
    db.close();
  });

program
  .command('detect')
  .description('derive change events from consecutive extractions')
  .option('--rebuild', 're-derive all change rows from scratch')
  .option('--source <id>', 'restrict to one source', v => Number(v))
  .action(async (options: { rebuild?: boolean; source?: number }) => {
    const { detect } = await import('./workflow/detect.js');
    const db = openDb(dbPath());
    const s = detect(db, { rebuild: options.rebuild, sourceId: options.source });
    console.log(
      `${s.sources} sources, ${s.pairs} state transitions: ${s.created} new changes, ` +
      `${s.confirmed} confirmed, ${s.disputed} disputed, ${s.retracted} retracted.`,
    );
    db.close();
  });

program
  .command('synthesize')
  .description('annotate confirmed changes and write a digest when the trigger fires')
  .option('--force', 'ignore the Monday and volume gates (never the budget or kill switch)')
  .option('--dry-run', 'evaluate the trigger and report, calling nothing')
  .action(async (options: { force?: boolean; dryRun?: boolean }) => {
    const { synthesize } = await import('./workflow/synthesize.js');
    const db = openDb(dbPath());
    const s = await synthesize(db, { force: options.force, dryRun: options.dryRun });
    console.log(
      s.fired
        ? `Digest written: ${s.itemCount} items, ${s.annotated} changes annotated, $${(s.costMicros / 1e6).toFixed(4)}.`
        : options.dryRun
          ? `Dry run: ${s.wouldFire ? 'WOULD fire' : 'would hold'} (${s.reason}).`
          : `No digest: ${s.reason}${s.skipped ? ' (skipped: LLM disabled or budget exhausted)' : ''}`,
    );
    db.close();
  });

// backfill's flags are all numeric and feed budget math or a source-id
// filter, where a silently-NaN value is either wrong output (--budget) or a
// falsy filter that backfills every source (--source) — so, unlike the
// older commands' bare `Number(v)`, these are validated at the CLI boundary.
function numeric(flag: string, { min }: { min: number }) {
  return (raw: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min) {
      throw new Error(`${flag} needs a number >= ${min}; got "${raw}"`);
    }
    return value;
  };
}

program
  .command('backfill')
  .description('seed the archive with historical captures from the Internet Archive')
  .option('--months <n>', 'how far back to look (default 18)', numeric('--months', { min: 1 }))
  .option('--budget <usd>', 'one-time spend ceiling for this backfill (default 10.00)', numeric('--budget', { min: 0 }))
  .option('--limit <n>', 'fetch at most n captures this run', numeric('--limit', { min: 1 }))
  .option('--source <id>', 'restrict to one source', numeric('--source', { min: 1 }))
  .option('--discover-only', 'enqueue captures but fetch none')
  .action(async (options: {
    months?: number; budget?: number; limit?: number; source?: number; discoverOnly?: boolean;
  }) => {
    const { runBackfill } = await import('./workflow/backfill.js');
    const db = openDb(dbPath());

    const s = await runBackfill(db, {
      months: options.months,
      budgetUsd: options.budget,
      limit: options.limit,
      sourceId: options.source,
      discoverOnly: options.discoverOnly,
    });

    const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

    console.log(
      `Discovery: ${s.discover.sources} sources, ${s.discover.found} captures found, ` +
      `${s.discover.enqueued} new, ${s.discover.duplicate} already queued, ${s.discover.failed} failed.`,
    );
    console.log(
      `Estimate: ${s.estimate.pending} pending x ${usd(s.estimate.meanCostMicros)} = ` +
      `${usd(s.estimate.estimateMicros)} against a ${usd(s.estimate.budgetMicros)} budget.`,
    );

    if (!s.estimate.withinBudget) {
      console.log(
        `\nRefusing to start: the queue would cost more than the budget allows.\n` +
        `The captures are already queued, so nothing is lost — re-run with\n` +
        `  bellwether backfill --budget ${(s.estimate.estimateMicros / 1e6).toFixed(2)}\n` +
        `or work through it in slices with --limit ${Math.max(1, s.estimate.maxCalls)}.\n` +
        `The estimate is a worst case: identical captures share an extraction and cost nothing.`,
      );
      db.close();
      return;
    }

    if (options.discoverOnly) {
      console.log('\nDiscovery only — nothing fetched. Re-run without --discover-only to continue.');
      db.close();
      return;
    }

    console.log(
      `Fetched ${s.drain.claimed}: ${s.drain.stored} new page states, ${s.drain.deduped} identical, ` +
      `${s.drain.skipped} skipped, ${s.drain.failed} failed.`,
    );
    console.log(
      `Extracted ${s.extracted} for ${usd(s.actualMicros)} (estimated ${usd(s.estimate.estimateMicros)}). ` +
      `Rebuilt detection: ${s.changes} changes, ${s.confirmed} confirmed.`,
    );
    console.log('\nRun `bellwether export` to publish the new history.');

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
    const siteDir = process.env.BELLWETHER_SITE_EXPORT_DIR
      ? resolve(process.env.BELLWETHER_SITE_EXPORT_DIR)
      : undefined;
    const stats = exportData(db, outDir, { siteDir });
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

function printStepTable(steps: { name: string; ok: boolean; summary: string }[]): void {
  for (const step of steps) {
    console.log(`[${step.ok ? ' ok ' : 'FAIL'}] ${step.name.padEnd(11)} ${step.summary}`);
  }
}

program
  .command('start')
  .description('run the full daily pipeline once (migrate, seed, collect..export), then idle')
  .action(async () => {
    const { seedCompetitors } = await import('./config/seed.js');
    const { COMPETITORS } = await import('./config/competitors.public.js');
    const { runPipeline } = await import('./workflow/pipeline.js');
    const { runHeartbeat } = await import('./ops/heartbeat.js');

    const db = openDb(dbPath());

    const applied = migrate(db, join(ROOT, 'migrations'));
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema is current.');

    const seedStats = seedCompetitors(db, COMPETITORS);
    console.log(`Seeded ${seedStats.competitors} competitors and ${seedStats.sources} sources.`);

    const pipelineStats = await runPipeline(db, {}, { heartbeat: (d) => runHeartbeat(d) });
    printStepTable(pipelineStats.steps);

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
  .command('pipeline')
  .description('run the daily sequence once and exit (for cron)')
  .action(async () => {
    const { runPipeline } = await import('./workflow/pipeline.js');
    const { runHeartbeat } = await import('./ops/heartbeat.js');
    const db = openDb(dbPath());

    const pipelineStats = await runPipeline(db, {}, { heartbeat: (d) => runHeartbeat(d) });
    printStepTable(pipelineStats.steps);

    db.close();
    process.exit(pipelineStats.steps.some(s => !s.ok) ? 1 : 0);
  });

program
  .command('doctor')
  .description('check that everything needed to run is present and working')
  .action(async () => {
    const { runDoctor } = await import('./ops/doctor.js');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);

    const { existsSync, accessSync, constants: fsConstants } = await import('node:fs');
    const db = openDb(dbPath());
    const results = await runDoctor({
      db,
      env: process.env,
      publishScript: async () => {
        // ops/ is never copied into the image (see .dockerignore / Dockerfile) —
        // publishing runs on the host, not in the container — so absence here
        // is the container's normal state, not a failure to fix.
        const scriptPath = join(ROOT, 'ops', 'publish.sh');
        if (!existsSync(scriptPath)) {
          return { ok: true, skipped: true, detail: 'ops/publish.sh not present — publishing runs on the host, not in the container' };
        }
        try {
          accessSync(scriptPath, fsConstants.X_OK);
          return { ok: true, detail: 'ops/publish.sh is executable' };
        } catch {
          return { ok: false, detail: 'ops/publish.sh exists but is not executable' };
        }
      },
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

// Nested so Task 4's `ops backup` / `ops verify-backup` land next to this
// without a second top-level namespace.
const ops = program.command('ops').description('operational commands (alerts, backup)');

ops
  .command('heartbeat')
  .description('run the outcome-based health check once and send any Telegram alert')
  .action(async () => {
    const { runHeartbeat } = await import('./ops/heartbeat.js');
    const db = openDb(dbPath());

    const stats = await runHeartbeat(db);
    if (stats.alerts.length > 0) {
      console.log(`${stats.alerts.length} problem(s):`);
      for (const alert of stats.alerts) console.log(`  - ${alert}`);
    } else {
      console.log('No problems found.');
    }
    console.log(
      stats.sent
        ? `Telegram: sent${stats.allGreenSent ? ' (all-green)' : ''}.`
        : 'Telegram: not sent (unconfigured, not Monday in CT, or the API call failed).'
    );

    db.close();
  });

ops
  .command('backup')
  .description('VACUUM INTO a dated snapshot and prune local copies beyond 7')
  .option('--dir <path>', 'snapshot directory (default: alongside the database)')
  .action(async (options: { dir?: string }) => {
    const { backupSnapshot } = await import('./ops/backup.js');
    const { acquireRun, finishRun } = await import('./ops/runs.js');
    const { sendTelegram } = await import('./tools/telegram.js');

    const dbFile = dbPath();
    const dir = options.dir ? resolve(options.dir) : join(dirname(dbFile), 'backup');
    const db = openDb(dbFile);
    const runId = acquireRun(db, 'backup');

    try {
      const result = backupSnapshot(db, dir);
      finishRun(db, runId, true, result);
      console.log(
        `Backed up to ${result.path} (${result.bytes} bytes)` +
        (result.pruned.length ? `; pruned ${result.pruned.join(', ')}` : '') + '.'
      );
      db.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finishRun(db, runId, false, {}, message);
      db.close();
      await sendTelegram(`Bellwether: backup failed — ${message}`);
      throw err;
    }
  });

ops
  .command('verify-backup')
  .description('open the newest local snapshot and compare row counts against the live archive')
  .option('--file <path>', 'snapshot file (default: newest bellwether-*.db in the backup dir)')
  .action(async (options: { file?: string }) => {
    const { verifyBackup } = await import('./ops/backup.js');
    const { sendTelegram } = await import('./tools/telegram.js');
    const { existsSync, readdirSync } = await import('node:fs');

    const livePath = dbPath();
    const dir = join(dirname(livePath), 'backup');

    // No `runs` row here (see docs/superpowers/plans/2026-08-19-bellwether-m5.md
    // Task 4): the heartbeat watchdog only queries kinds `export` and `backup`,
    // and adding a third kind means also editing that query. verify-backup
    // alerts directly and exits nonzero; cron log output surfaces the rest.
    try {
      const file = options.file
        ? resolve(options.file)
        : (() => {
            const newest = existsSync(dir)
              ? readdirSync(dir).filter(f => /^bellwether-\d{8}\.db$/.test(f)).sort().at(-1)
              : undefined;
            if (!newest) throw new Error(`no bellwether-*.db snapshot found in ${dir}`);
            return join(dir, newest);
          })();

      const result = verifyBackup(livePath, file);
      for (const [table, c] of Object.entries(result.counts)) {
        console.log(`${table.padEnd(12)} live=${c.live} snapshot=${c.snapshot}`);
      }
      if (!result.ok) throw new Error(result.detail);
      console.log('verify-backup: OK');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`verify-backup: FAILED — ${message}`);
      await sendTelegram(`Bellwether: verify-backup failed — ${message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  // ExportGuardError and RunLockedError carry messages written for a human
  // to read (e.g. "Run `bellwether seed` first"). Without this, they'd
  // surface as an unhandled-rejection stack trace — exactly what `doctor`
  // exists to avoid everywhere else.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
