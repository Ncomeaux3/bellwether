import type { DB } from '../ops/db.js';
import { acquireRun, finishRun } from '../ops/runs.js';
import {
  BudgetExceededError, SYNTH_MODEL, anthropic, assertWithinBudget, llmEnabled,
} from '../agents/_client.js';
import { SYNTH_PROMPT_VERSION } from '../schema/synthesis.js';
import { synthesizeWeekly, type ChangeForSynthesis, type SynthesizeResult } from '../agents/synthesize_weekly.js';
import { MATERIALITY_THRESHOLD } from '../tools/materiality.js';

export const SYNTH_MIN_CHANGES = 3;
export const SYNTH_MAX_CHANGES = 20;   // ruling R5: bounded input
export const SYNTH_STALE_DAYS = 30;
export const PRIOR_DIGESTS = 4;

export interface SynthesizeOptions { force?: boolean; dryRun?: boolean }
export interface SynthesizeWorkflowDeps {
  synthesizer?: (changes: ChangeForSynthesis[], priorDigests: string[]) => Promise<SynthesizeResult>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}
export interface SynthStats {
  fired: boolean; reason: string; skipped: boolean;
  annotated: number; itemCount: number; costMicros: number;
}

const pendingQuery = `
  SELECT ch.id, c.name AS competitor, ch.observed_at, ch.change_type, ch.json_path,
         ch.before_json, ch.after_json
  FROM changes ch
  JOIN sources s ON s.id = ch.source_id
  JOIN competitors c ON c.id = s.competitor_id
  WHERE ch.state = 'confirmed' AND ch.materiality >= ${MATERIALITY_THRESHOLD}
    AND NOT EXISTS (SELECT 1 FROM analyses a
                    WHERE a.change_id = ch.id AND a.prompt_version = ?)
  ORDER BY ch.observed_at, ch.id`;

/** Spec 13. The trigger is code; the model never decides whether to run. */
export function shouldSynthesize(
  db: DB, now: Date, opts: SynthesizeOptions = {},
): { fire: boolean; reason: string; pending: number } {
  const pending = (db.prepare(
    `SELECT COUNT(*) AS n FROM (${pendingQuery})`,
  ).get(SYNTH_PROMPT_VERSION) as { n: number }).n;

  if (pending === 0) return { fire: false, reason: 'nothing pending — an empty digest is worse than none', pending };
  if (opts.force) return { fire: true, reason: `forced with ${pending} pending`, pending };

  if (now.getUTCDay() !== 1) return { fire: false, reason: 'not Monday (spec 13 cadence gate)', pending };

  if (pending >= SYNTH_MIN_CHANGES) return { fire: true, reason: `${pending} pending >= ${SYNTH_MIN_CHANGES}`, pending };

  const last = db.prepare('SELECT MAX(created_at) AS at FROM digests').get() as { at: string | null };
  const staleMs = SYNTH_STALE_DAYS * 86_400_000;
  if (last.at === null || now.getTime() - Date.parse(last.at) > staleMs) {
    return { fire: true, reason: `${pending} pending and last digest ${last.at === null ? 'never' : last.at} — stale rule`, pending };
  }
  return { fire: false, reason: `${pending} pending < ${SYNTH_MIN_CHANGES} and digest is fresh`, pending };
}

export async function synthesize(
  db: DB, opts: SynthesizeOptions = {}, deps: SynthesizeWorkflowDeps = {},
): Promise<SynthStats> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const stats: SynthStats = { fired: false, reason: '', skipped: false, annotated: 0, itemCount: 0, costMicros: 0 };
  const runId = acquireRun(db, 'synthesize', { now });

  try {
    const verdict = shouldSynthesize(db, now(), opts);
    stats.reason = verdict.reason;
    if (!verdict.fire || opts.dryRun) {
      finishRun(db, runId, true, stats);
      return stats;
    }

    if (!llmEnabled(env)) {
      stats.skipped = true;
      finishRun(db, runId, true, stats);
      return stats;
    }
    try {
      assertWithinBudget(db, { now, env });
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      console.warn(err.message);
      stats.skipped = true;
      finishRun(db, runId, true, stats);
      return stats;
    }

    const changes = (db.prepare(`${pendingQuery} LIMIT ${SYNTH_MAX_CHANGES}`)
      .all(SYNTH_PROMPT_VERSION) as {
        id: number; competitor: string; observed_at: string; change_type: string;
        json_path: string; before_json: string | null; after_json: string | null;
      }[]).map((r): ChangeForSynthesis => ({
        id: r.id, competitor: r.competitor, observed_at: r.observed_at,
        change_type: r.change_type, json_path: r.json_path,
        before: r.before_json, after: r.after_json,
      }));

    const priors = (db.prepare(
      'SELECT body_md FROM digests ORDER BY created_at DESC LIMIT ?',
    ).all(PRIOR_DIGESTS) as { body_md: string }[]).map(r => r.body_md);

    const run = deps.synthesizer
      ?? ((c: ChangeForSynthesis[], p: string[]) => synthesizeWeekly(c, p, { client: anthropic() as never }));
    const result: SynthesizeResult = await run(changes, priors);

    if (!result.ok) {
      finishRun(db, runId, false, stats, `synthesis ${result.reason}: ${result.detail}`.slice(0, 300));
      return stats;
    }

    stats.fired = true;
    const stamp = now().toISOString();
    const periodStart = changes[0]!.observed_at;

    // One transaction: a digest with half its annotations is not a state
    // this table is allowed to hold.
    db.transaction(() => {
      const insertAnalysis = db.prepare(`
        INSERT INTO analyses (change_id, implication, so_what, confidence, model, prompt_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (change_id, prompt_version) DO NOTHING`);
      for (const a of result.data.annotations) {
        const changeId = result.changeIdByIndex.get(a.index)!;
        const info = insertAnalysis.run(changeId, a.implication, a.so_what, a.confidence,
          SYNTH_MODEL, SYNTH_PROMPT_VERSION, stamp);
        if (info.changes > 0) stats.annotated += 1;
      }
      db.prepare(`
        INSERT INTO digests (period_start, period_end, body_md, item_count, model, prompt_version, cost_micros, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (period_start, prompt_version) DO NOTHING`)
        .run(periodStart, stamp, result.data.digest_markdown, result.data.top.length,
          SYNTH_MODEL, SYNTH_PROMPT_VERSION, result.costMicros, stamp);
    })();

    stats.itemCount = result.data.top.length;
    stats.costMicros = result.costMicros;
    finishRun(db, runId, true, stats);
    return stats;
  } catch (err) {
    finishRun(db, runId, false, stats, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
