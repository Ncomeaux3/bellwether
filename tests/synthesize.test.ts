import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import {
  PRIOR_DIGESTS, SYNTH_MAX_CHANGES, shouldSynthesize, synthesize,
} from '../src/workflow/synthesize.js';
import type { ChangeForSynthesis, SynthesizeResult } from '../src/agents/synthesize_weekly.js';
import { SYNTH_PROMPT_VERSION } from '../src/schema/synthesis.js';
import { SYNTH_MODEL } from '../src/agents/_client.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string; let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

const NOW_MONDAY = new Date('2026-08-17T13:00:00.000Z');
const NOW_TUESDAY = new Date(NOW_MONDAY.getTime() + 86_400_000);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-synth-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

let seq = 0;

/** A confirmed, above-threshold change. Each call gets a unique snapshot pair so the
 * (source_id, from_snapshot_id, to_snapshot_id, json_path) unique constraint never collides. */
function insertChange(observedAt: string, opts: { materiality?: number; state?: string } = {}): number {
  seq += 1;
  const info = db.prepare(`
    INSERT INTO changes (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
                          before_json, after_json, materiality, state, observed_at)
    VALUES (1, ?, ?, 'price_increase', ?, '19', '25', ?, ?, ?)
  `).run(seq * 2, seq * 2 + 1, `tiers[0].seq${seq}`, opts.materiality ?? 50, opts.state ?? 'confirmed', observedAt);
  return Number(info.lastInsertRowid);
}

function insertAnalysis(changeId: number, promptVersion = SYNTH_PROMPT_VERSION): void {
  db.prepare(`
    INSERT INTO analyses (change_id, implication, so_what, confidence, model, prompt_version, created_at)
    VALUES (?, 'x', 'y', 'high', ?, ?, ?)
  `).run(changeId, SYNTH_MODEL, promptVersion, new Date().toISOString());
}

function insertDigest(periodStart: string, createdAt: string, bodyMd = `digest ${periodStart}`): void {
  db.prepare(`
    INSERT INTO digests (period_start, period_end, body_md, item_count, model, prompt_version, cost_micros, created_at)
    VALUES (?, ?, ?, 1, ?, ?, 0, ?)
  `).run(periodStart, createdAt, bodyMd, SYNTH_MODEL, SYNTH_PROMPT_VERSION, createdAt);
}

const digestCount = () => (db.prepare('SELECT COUNT(*) AS n FROM digests').get() as { n: number }).n;
const analysisCount = () => (db.prepare('SELECT COUNT(*) AS n FROM analyses').get() as { n: number }).n;

/** A stubbed synthesizeWeekly: builds an ok result annotating every change it is shown.
 * `topCount` defaults to 5 (the real schema cap); pass fewer than the change count to
 * make item_count (top.length) diverge from annotated (annotations.length), which is
 * the only way a test can tell the digest row's item_count apart from a bug that writes
 * annotations.length instead. */
function fakeOkSynthesizer(topCount = 5): {
  fn: (c: ChangeForSynthesis[], p: string[]) => Promise<SynthesizeResult>;
  calls: { changes: ChangeForSynthesis[]; priors: string[] }[];
} {
  const calls: { changes: ChangeForSynthesis[]; priors: string[] }[] = [];
  const fn = async (changes: ChangeForSynthesis[], priors: string[]): Promise<SynthesizeResult> => {
    calls.push({ changes, priors });
    return {
      ok: true,
      data: {
        annotations: changes.map((_, i) => ({
          index: i, implication: 'it changed', so_what: 'buyers care', confidence: 'high' as const,
        })),
        digest_markdown: '## This week\nStuff happened.',
        top: changes.slice(0, topCount).map((_, i) => ({ index: i, headline: `headline ${i}` })),
      },
      changeIdByIndex: new Map(changes.map((c, i) => [i, c.id])),
      inputTokens: 1000, outputTokens: 200, costMicros: 6000, attempts: 1,
    };
  };
  return { fn, calls };
}

describe('shouldSynthesize (trigger truth table)', () => {
  it('fires: 3 pending, Monday', () => {
    insertChange('2026-08-10T00:00:00.000Z');
    insertChange('2026-08-11T00:00:00.000Z');
    insertChange('2026-08-12T00:00:00.000Z');
    const v = shouldSynthesize(db, NOW_MONDAY);
    expect(v.fire).toBe(true);
    expect(v.pending).toBe(3);
  });

  it('holds: 2 pending, Monday, last digest fresh (0d old)', () => {
    insertChange('2026-08-10T00:00:00.000Z');
    insertChange('2026-08-11T00:00:00.000Z');
    insertDigest('2026-08-03T00:00:00.000Z', NOW_MONDAY.toISOString());
    const v = shouldSynthesize(db, NOW_MONDAY);
    expect(v.fire).toBe(false);
    expect(v.reason).toContain('2 pending < 3');
  });

  it('fires: 1 pending, Monday, last digest 31d old (stale rule)', () => {
    insertChange('2026-08-16T00:00:00.000Z');
    const staleAt = new Date(NOW_MONDAY.getTime() - 31 * 86_400_000).toISOString();
    insertDigest('2026-07-13T00:00:00.000Z', staleAt);
    const v = shouldSynthesize(db, NOW_MONDAY);
    expect(v.fire).toBe(true);
    expect(v.reason).toContain('stale rule');
  });

  it('holds: 0 pending, Monday, last digest 90d old — never fires empty', () => {
    const staleAt = new Date(NOW_MONDAY.getTime() - 90 * 86_400_000).toISOString();
    insertDigest('2026-05-19T00:00:00.000Z', staleAt);
    const v = shouldSynthesize(db, NOW_MONDAY);
    expect(v.fire).toBe(false);
    expect(v.pending).toBe(0);
    expect(v.reason).toContain('nothing pending');
  });

  it('holds: 3 pending, Tuesday (not Monday)', () => {
    insertChange('2026-08-10T00:00:00.000Z');
    insertChange('2026-08-11T00:00:00.000Z');
    insertChange('2026-08-12T00:00:00.000Z');
    const v = shouldSynthesize(db, NOW_TUESDAY);
    expect(v.fire).toBe(false);
    expect(v.reason).toContain('not Monday');
  });

  it('fires: 3 pending, Tuesday, --force bypasses the Monday gate', () => {
    insertChange('2026-08-10T00:00:00.000Z');
    insertChange('2026-08-11T00:00:00.000Z');
    insertChange('2026-08-12T00:00:00.000Z');
    const v = shouldSynthesize(db, NOW_TUESDAY, { force: true });
    expect(v.fire).toBe(true);
    expect(v.reason).toContain('forced');
  });

  it('never fires empty even with --force', () => {
    const v = shouldSynthesize(db, NOW_TUESDAY, { force: true });
    expect(v.fire).toBe(false);
    expect(v.reason).toContain('nothing pending');
  });

  it('annotated changes do not count as pending', () => {
    const a = insertChange('2026-08-10T00:00:00.000Z');
    insertChange('2026-08-11T00:00:00.000Z');
    insertChange('2026-08-12T00:00:00.000Z');
    insertAnalysis(a); // annotated at SYNTH_PROMPT_VERSION — excluded from pending
    insertDigest('2026-08-03T00:00:00.000Z', NOW_MONDAY.toISOString()); // fresh, isolates the volume gate
    const v = shouldSynthesize(db, NOW_MONDAY);
    expect(v.pending).toBe(2);
    expect(v.fire).toBe(false);
    expect(v.reason).toContain('2 pending < 3');
  });
});

describe('synthesize (workflow)', () => {
  it('writes one digests row and one analyses row per annotation', async () => {
    insertChange('2026-08-10T00:00:00.000Z');
    insertChange('2026-08-11T00:00:00.000Z');
    insertChange('2026-08-12T00:00:00.000Z');
    // topCount=2 against 3 changes: item_count (top.length) must read 2, not
    // annotated (annotations.length, 3) — the only way to catch a digest
    // insert that swaps in the wrong count.
    const { fn } = fakeOkSynthesizer(2);

    const stats = await synthesize(db, {}, {
      now: () => NOW_MONDAY,
      env: { LLM_ENABLED: 'true' },
      synthesizer: fn,
    });

    expect(stats.fired).toBe(true);
    expect(stats.annotated).toBe(3);
    expect(stats.itemCount).toBe(2);
    expect(digestCount()).toBe(1);
    expect(analysisCount()).toBe(3);

    const run = db.prepare("SELECT state, ok FROM runs WHERE kind = 'synthesize'").get() as
      { state: string; ok: number };
    expect(run.state).toBe('ok');
    expect(run.ok).toBe(1);

    const digest = db.prepare(
      'SELECT model, prompt_version, cost_micros, item_count, body_md FROM digests',
    ).get() as { model: string; prompt_version: string; cost_micros: number; item_count: number; body_md: string };
    expect(digest.model).toBe(SYNTH_MODEL);
    expect(digest.prompt_version).toBe(SYNTH_PROMPT_VERSION);
    expect(digest.cost_micros).toBe(6000);
    expect(digest.item_count).toBe(2);
    expect(digest.body_md).toBe('## This week\nStuff happened.');
  });

  it('ON CONFLICT(change_id, prompt_version) DO NOTHING de-dupes a repeated annotation index', async () => {
    insertChange('2026-08-10T00:00:00.000Z');
    insertChange('2026-08-11T00:00:00.000Z');
    insertChange('2026-08-12T00:00:00.000Z');
    // Model output that annotates index 0 twice — the second insert must
    // no-op rather than error or double-count.
    const dupSynthesizer = async (changes: ChangeForSynthesis[]): Promise<SynthesizeResult> => ({
      ok: true,
      data: {
        annotations: [
          { index: 0, implication: 'a', so_what: 'b', confidence: 'high' },
          { index: 0, implication: 'a again', so_what: 'b again', confidence: 'high' },
          { index: 1, implication: 'c', so_what: 'd', confidence: 'high' },
          { index: 2, implication: 'e', so_what: 'f', confidence: 'high' },
        ],
        digest_markdown: '## This week\nStuff happened.',
        top: [{ index: 0, headline: 'headline' }],
      },
      changeIdByIndex: new Map(changes.map((c, i) => [i, c.id])),
      inputTokens: 1000, outputTokens: 200, costMicros: 6000, attempts: 1,
    });

    const stats = await synthesize(db, {}, {
      now: () => NOW_MONDAY, env: { LLM_ENABLED: 'true' }, synthesizer: dupSynthesizer,
    });

    expect(stats.fired).toBe(true);
    expect(stats.annotated).toBe(3); // the duplicate index-0 insert did not count
    expect(analysisCount()).toBe(3);
  });

  it('LLM_ENABLED=false skips and writes no rows', async () => {
    insertChange('2026-08-10T00:00:00.000Z');
    insertChange('2026-08-11T00:00:00.000Z');
    insertChange('2026-08-12T00:00:00.000Z');
    const { fn, calls } = fakeOkSynthesizer();

    const stats = await synthesize(db, {}, {
      now: () => NOW_MONDAY, env: { LLM_ENABLED: 'false' }, synthesizer: fn,
    });

    expect(stats.skipped).toBe(true);
    expect(stats.fired).toBe(false);
    expect(calls).toHaveLength(0);
    expect(digestCount()).toBe(0);
    expect(analysisCount()).toBe(0);
  });

  it('a BudgetExceededError is caught: skipped with a warning, no throw', async () => {
    insertChange('2026-08-10T00:00:00.000Z');
    insertChange('2026-08-11T00:00:00.000Z');
    insertChange('2026-08-12T00:00:00.000Z');
    const { fn, calls } = fakeOkSynthesizer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stats = await synthesize(db, {}, {
      now: () => NOW_MONDAY,
      env: { LLM_ENABLED: 'true', BELLWETHER_MONTHLY_BUDGET_USD: '0' },
      synthesizer: fn,
    });

    expect(stats.skipped).toBe(true);
    expect(stats.fired).toBe(false);
    expect(calls).toHaveLength(0);
    expect(digestCount()).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a failed synthesis (ok:false) records the run failed with no partial rows', async () => {
    insertChange('2026-08-10T00:00:00.000Z');
    insertChange('2026-08-11T00:00:00.000Z');
    insertChange('2026-08-12T00:00:00.000Z');
    const failing = async (): Promise<SynthesizeResult> =>
      ({ ok: false, reason: 'invalid', detail: 'schema mismatch' });

    const stats = await synthesize(db, {}, {
      now: () => NOW_MONDAY, env: { LLM_ENABLED: 'true' }, synthesizer: failing,
    });

    expect(stats.fired).toBe(false);
    expect(digestCount()).toBe(0);
    expect(analysisCount()).toBe(0);

    const run = db.prepare("SELECT state, ok, error FROM runs WHERE kind = 'synthesize'").get() as
      { state: string; ok: number; error: string };
    expect(run.state).toBe('failed');
    expect(run.ok).toBe(0);
    expect(run.error).toContain('invalid');
  });

  it('--dry-run evaluates the trigger and calls nothing', async () => {
    insertChange('2026-08-10T00:00:00.000Z');
    insertChange('2026-08-11T00:00:00.000Z');
    insertChange('2026-08-12T00:00:00.000Z');
    const { fn, calls } = fakeOkSynthesizer();

    const stats = await synthesize(db, { dryRun: true }, {
      now: () => NOW_MONDAY, env: { LLM_ENABLED: 'true' }, synthesizer: fn,
    });

    expect(stats.fired).toBe(false);
    expect(stats.wouldFire).toBe(true); // the trigger says fire; dry-run just never acted on it
    expect(calls).toHaveLength(0);
    expect(digestCount()).toBe(0);
  });

  it('caps input at SYNTH_MAX_CHANGES: 25 pending sends only the oldest 20', async () => {
    for (let i = 0; i < 25; i += 1) {
      insertChange(new Date(Date.UTC(2026, 6, 1 + i)).toISOString());
    }
    const { fn, calls } = fakeOkSynthesizer();

    await synthesize(db, {}, {
      now: () => NOW_MONDAY, env: { LLM_ENABLED: 'true' }, synthesizer: fn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.changes).toHaveLength(SYNTH_MAX_CHANGES);
    const observed = calls[0]!.changes.map(c => c.observed_at);
    expect(observed).toEqual([...observed].sort());
    expect(observed[0]).toBe(new Date(Date.UTC(2026, 6, 1)).toISOString());
    expect(observed[observed.length - 1]).toBe(new Date(Date.UTC(2026, 6, 20)).toISOString());
  });

  it('passes only the newest PRIOR_DIGESTS digest bodies, newest first', async () => {
    insertChange('2026-08-10T00:00:00.000Z');
    insertChange('2026-08-11T00:00:00.000Z');
    insertChange('2026-08-12T00:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      const at = new Date(Date.UTC(2026, 6, 1 + i)).toISOString();
      insertDigest(at, at, `digest-${i}`);
    }
    const { fn, calls } = fakeOkSynthesizer();

    await synthesize(db, {}, {
      now: () => NOW_MONDAY, env: { LLM_ENABLED: 'true' }, synthesizer: fn,
    });

    expect(calls[0]!.priors).toHaveLength(PRIOR_DIGESTS);
    // Newest first: digest-4 (Jul 5) down to digest-1 (Jul 2); digest-0 (Jul 1) is dropped.
    expect(calls[0]!.priors).toEqual(['digest-4', 'digest-3', 'digest-2', 'digest-1']);
  });

  // Fix round 1, finding 1: detect stamps every change from one snapshot pair
  // with an identical observed_at, so a change overhaul big enough to split
  // across two capped (SYNTH_MAX_CHANGES) runs used to hand both runs the
  // same period_start (= changes[0].observed_at) — the digest insert's old
  // ON CONFLICT DO NOTHING then silently dropped run 2's digest while its
  // annotations still committed. period_start is now the run's own
  // timestamp, so this must no longer collide.
  it('two runs whose pending changes share one observed_at both keep their digest', async () => {
    const sharedObservedAt = '2026-08-10T00:00:00.000Z';
    for (let i = 0; i < 25; i += 1) insertChange(sharedObservedAt);

    const run1 = fakeOkSynthesizer();
    const stats1 = await synthesize(db, {}, {
      now: () => NOW_MONDAY, env: { LLM_ENABLED: 'true' }, synthesizer: run1.fn,
    });
    expect(stats1.fired).toBe(true);
    expect(run1.calls[0]!.changes).toHaveLength(SYNTH_MAX_CHANGES); // 20 of 25 consumed

    // A second run, moments later, picks up the 5 changes the cap left behind.
    const laterNow = new Date(NOW_MONDAY.getTime() + 1000);
    const run2 = fakeOkSynthesizer();
    const stats2 = await synthesize(db, {}, {
      now: () => laterNow, env: { LLM_ENABLED: 'true' }, synthesizer: run2.fn,
    });
    expect(stats2.fired).toBe(true);
    expect(run2.calls[0]!.changes).toHaveLength(25 - SYNTH_MAX_CHANGES);

    expect(digestCount()).toBe(2);
    const digests = db.prepare('SELECT period_start, body_md, cost_micros FROM digests').all() as
      { period_start: string; body_md: string; cost_micros: number }[];
    expect(new Set(digests.map(d => d.period_start)).size).toBe(2); // no collision
    expect(digests.every(d => d.body_md.length > 0)).toBe(true);
    expect(digests.reduce((sum, d) => sum + d.cost_micros, 0)).toBe(stats1.costMicros + stats2.costMicros);

    const runs = db.prepare("SELECT state FROM runs WHERE kind = 'synthesize'").all() as { state: string }[];
    expect(runs.every(r => r.state === 'ok')).toBe(true);
  });
});
