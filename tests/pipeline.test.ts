import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { runPipeline } from '../src/workflow/pipeline.js';
import type { CollectStats } from '../src/workflow/collect.js';
import type { ExtractStats } from '../src/workflow/extract.js';
import type { DetectStats } from '../src/workflow/detect.js';
import type { SynthStats } from '../src/workflow/synthesize.js';
import type { ExportStats } from '../src/workflow/export.js';
import type { HeartbeatStats } from '../src/ops/heartbeat.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-pipeline-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const COLLECT_STATS: CollectStats = { attempted: 0, stored: 0, unchanged: 0, failed: 0, degraded: 0, cleared: 0 };
const EXTRACT_STATS: ExtractStats = {
  considered: 0, hashed: 0, cached: 0, extracted: 0, skipped: 0, degraded: 0, mismatched: 0, historicalFailed: 0,
};
const DETECT_STATS: DetectStats = {
  sources: 0, pairs: 0, created: 0, confirmed: 0, disputed: 0, retracted: 0, relinked: 0, orphaned: 0,
};
const SYNTH_STATS: SynthStats = {
  fired: false, reason: 'nothing pending', skipped: false, annotated: 0, itemCount: 0, costMicros: 0, wouldFire: false,
};
const EXPORT_STATS: ExportStats = { files: [], competitors: 0, healthySources: 0, totalSources: 0, confirmedChanges: 0 };

function greenDeps() {
  return {
    now: () => new Date('2026-08-19T12:00:00.000Z'),
    collectFn: vi.fn(async () => COLLECT_STATS),
    extractFn: vi.fn(async () => EXTRACT_STATS),
    detectFn: vi.fn(() => DETECT_STATS),
    synthesizeFn: vi.fn(async () => SYNTH_STATS),
    exportFn: vi.fn(() => EXPORT_STATS),
  };
}

describe('runPipeline', () => {
  it('runs every step and reports all-green when nothing throws', async () => {
    const deps = greenDeps();
    const result = await runPipeline(db, {}, deps);

    expect(result.steps.map(s => s.name)).toEqual(['collect', 'extract', 'detect', 'synthesize', 'export']);
    expect(result.steps.every(s => s.ok)).toBe(true);
    expect(deps.collectFn).toHaveBeenCalledTimes(1);
    expect(deps.extractFn).toHaveBeenCalledTimes(1);
    expect(deps.detectFn).toHaveBeenCalledTimes(1);
    expect(deps.synthesizeFn).toHaveBeenCalledTimes(1);
    expect(deps.exportFn).toHaveBeenCalledTimes(1);
  });

  it('keeps running later steps after an earlier one throws, and never throws itself', async () => {
    const deps = greenDeps();
    deps.detectFn = vi.fn(() => { throw new Error('detect blew up\nwith a stack trace'); });

    const result = await runPipeline(db, {}, deps);

    const detectStep = result.steps.find(s => s.name === 'detect')!;
    expect(detectStep.ok).toBe(false);
    expect(detectStep.summary).toBe('detect blew up');   // first line only

    // synthesize and export must still have run despite detect throwing.
    expect(deps.synthesizeFn).toHaveBeenCalledTimes(1);
    expect(deps.exportFn).toHaveBeenCalledTimes(1);
    const exportStep = result.steps.find(s => s.name === 'export')!;
    expect(exportStep.ok).toBe(true);
  });

  it('records a failed export step without throwing when export rejects', async () => {
    const deps = greenDeps();
    deps.exportFn = vi.fn(() => { throw new Error('disk full'); });

    const result = await runPipeline(db, {}, deps);

    const exportStep = result.steps.find(s => s.name === 'export')!;
    expect(exportStep.ok).toBe(false);
    expect(exportStep.summary).toBe('disk full');
  });

  it('calls the heartbeat when provided, after export', async () => {
    const deps = greenDeps();
    const order: string[] = [];
    deps.exportFn = vi.fn(() => { order.push('export'); return EXPORT_STATS; });
    const quiet: HeartbeatStats = { alerts: [], allGreenSent: false, sent: false };
    const heartbeat = vi.fn(async (): Promise<HeartbeatStats> => { order.push('heartbeat'); return quiet; });

    const result = await runPipeline(db, {}, { ...deps, heartbeat });

    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenCalledWith(db);
    expect(order).toEqual(['export', 'heartbeat']);
    expect(result.steps.map(s => s.name)).toContain('heartbeat');
    expect(result.steps.find(s => s.name === 'heartbeat')!.ok).toBe(true);
  });

  it('skips the heartbeat step entirely when none is provided', async () => {
    const deps = greenDeps();
    const result = await runPipeline(db, {}, deps);
    expect(result.steps.map(s => s.name)).not.toContain('heartbeat');
  });

  it('records a failed heartbeat without throwing', async () => {
    const deps = greenDeps();
    const heartbeat = vi.fn(async (): Promise<HeartbeatStats> => { throw new Error('ping failed'); });

    const result = await runPipeline(db, {}, { ...deps, heartbeat });

    const step = result.steps.find(s => s.name === 'heartbeat')!;
    expect(step.ok).toBe(false);
    expect(step.summary).toBe('ping failed');
  });

  // Fix round 1, finding 1: the heartbeat step used to hardcode
  // summary: 'sent' regardless of what runHeartbeat actually did — a run
  // where Telegram was unconfigured, or a healthy Tuesday where nothing
  // fired, printed "sent" in the step table and cron.log, which is exactly
  // the dead-channel invisibility the heartbeat exists to prevent. These
  // three pin the summary against every shape runHeartbeat can return.
  // Falsifiability check performed by hand: hardcoding `summary: 'sent'` in
  // pipeline.ts again fails all four of these (none of the four honest
  // summaries below is literally the string 'sent') — confirming they
  // genuinely exercise the fix rather than passing vacuously.
  it('summarizes an unsent alert heartbeat honestly, not as "sent"', async () => {
    const deps = greenDeps();
    const stats: HeartbeatStats = { alerts: ['stale: https://acme.test/pricing'], allGreenSent: false, sent: false };
    const heartbeat = vi.fn(async (): Promise<HeartbeatStats> => stats);

    const result = await runPipeline(db, {}, { ...deps, heartbeat });

    const step = result.steps.find(s => s.name === 'heartbeat')!;
    expect(step.ok).toBe(true);
    expect(step.summary).toBe('1 alert(s) NOT SENT — telegram unconfigured or failed');
  });

  it('summarizes a sent alert heartbeat as sent, with the alert count', async () => {
    const deps = greenDeps();
    const stats: HeartbeatStats = {
      alerts: ['stale: a', 'degraded: b'], allGreenSent: false, sent: true,
    };
    const heartbeat = vi.fn(async (): Promise<HeartbeatStats> => stats);

    const result = await runPipeline(db, {}, { ...deps, heartbeat });

    const step = result.steps.find(s => s.name === 'heartbeat')!;
    expect(step.summary).toBe('2 alert(s) sent');
  });

  it('summarizes a quiet, non-Monday heartbeat as quiet rather than "sent"', async () => {
    const deps = greenDeps();
    const stats: HeartbeatStats = { alerts: [], allGreenSent: false, sent: false };
    const heartbeat = vi.fn(async (): Promise<HeartbeatStats> => stats);

    const result = await runPipeline(db, {}, { ...deps, heartbeat });

    const step = result.steps.find(s => s.name === 'heartbeat')!;
    expect(step.summary).toBe('quiet (no alerts, not Monday)');
  });

  it('summarizes a Monday all-green heartbeat distinctly from a plain "sent"', async () => {
    const deps = greenDeps();
    const stats: HeartbeatStats = { alerts: [], allGreenSent: true, sent: true };
    const heartbeat = vi.fn(async (): Promise<HeartbeatStats> => stats);

    const result = await runPipeline(db, {}, { ...deps, heartbeat });

    const step = result.steps.find(s => s.name === 'heartbeat')!;
    expect(step.summary).toBe('all green sent');
  });
});

describe('runPipeline — default wiring (real extract/detect/synthesize/export)', () => {
  const CONFIG: CompetitorConfig[] = [{
    slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
    sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
  }];

  it('resolves outDir/siteDir from env.BELLWETHER_EXPORT_DIR and runs every default step for real', async () => {
    seedCompetitors(db, CONFIG);
    // One level under its own scratch dir, so siteDir (exportDir/..) is that
    // scratch dir, not the shared OS tmpdir — cleanup below must not touch that.
    const exportParent = mkdtempSync(join(tmpdir(), 'bw-pipeline-export-'));
    const exportDir = join(exportParent, 'data');

    const result = await runPipeline(db, {}, {
      now: () => new Date('2026-08-19T12:00:00.000Z'),
      env: { LLM_ENABLED: 'false', BELLWETHER_EXPORT_DIR: exportDir },
      // Only collect touches the network; extract is killed by LLM_ENABLED=false
      // and synthesize holds itself (nothing pending) — zero network either way.
      collectFn: vi.fn(async () => COLLECT_STATS),
    });

    expect(result.steps.every(s => s.ok)).toBe(true);
    expect(existsSync(join(exportDir, 'board.json'))).toBe(true);       // outDir
    expect(existsSync(join(exportDir, '..', 'changes.xml'))).toBe(true); // siteDir

    const run = db.prepare("SELECT state, ok FROM runs WHERE kind = 'export'").get() as
      { state: string; ok: number };
    expect(run.state).toBe('ok');
    expect(run.ok).toBe(1);

    rmSync(exportParent, { recursive: true, force: true });
  });

  it('routes changes.xml/llms.txt into BELLWETHER_SITE_EXPORT_DIR when set, alongside the other seven artifacts', async () => {
    seedCompetitors(db, CONFIG);
    const exportParent = mkdtempSync(join(tmpdir(), 'bw-pipeline-siteexport-'));
    const exportDir = join(exportParent, 'data');
    const siteExportDir = join(exportParent, 'export'); // one directory, all nine files

    const result = await runPipeline(db, {}, {
      now: () => new Date('2026-08-19T12:00:00.000Z'),
      env: {
        LLM_ENABLED: 'false',
        BELLWETHER_EXPORT_DIR: exportDir,
        BELLWETHER_SITE_EXPORT_DIR: siteExportDir,
      },
      collectFn: vi.fn(async () => COLLECT_STATS),
    });

    expect(result.steps.every(s => s.ok)).toBe(true);
    expect(existsSync(join(exportDir, 'board.json'))).toBe(true);
    // Without the env, this would land at exportDir/../changes.xml (siteDir
    // default) — the whole point of BELLWETHER_SITE_EXPORT_DIR is that it
    // doesn't, and lands in the same directory as board.json instead.
    expect(existsSync(join(exportDir, '..', 'changes.xml'))).toBe(false);
    expect(existsSync(join(siteExportDir, 'changes.xml'))).toBe(true);
    expect(existsSync(join(siteExportDir, 'llms.txt'))).toBe(true);

    rmSync(exportParent, { recursive: true, force: true });
  });
});
