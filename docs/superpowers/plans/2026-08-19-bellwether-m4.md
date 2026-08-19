# Bellwether M4 — Synthesis and Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the archive found and cited: an adaptive digest synthesized from confirmed changes, a downloadable dataset with documented methodology, an RSS feed, and `llms.txt`.

**Architecture:** One new LLM call — `synthesize` — fires when at least three confirmed changes are un-annotated or thirty days have passed since the last digest, evaluated on Mondays (spec §13). It writes `analyses` (one annotation per change) and one `digests` row via the same schema-constrained `messages.parse` pattern extraction uses. Everything else is static generation inside the existing `export`: `dataset.csv`, `dataset.json`, `changes.xml`, `llms.txt`, `digest.json`, plus a `/data` page. Before any of that, `detect --rebuild` learns to re-link annotations across a wipe (spec §12.2), because M4 is what makes that latent FK bomb live.

**Tech Stack:** unchanged — Node 24, TypeScript ESM strict, better-sqlite3, Zod, Vitest, Next.js static export, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-18-bellwether-design.md` §12.2 (analyses re-linking), §13 (synthesis), §14.1/14.4/14.5 (export, distribution, dataset).

## Global Constraints

- **The LLM never decides control flow.** The synthesis trigger, the item cap, and every retry are code. The model fills a schema.
- **One synthesis call per firing**, model `claude-sonnet-5`, structured output, `model` and `prompt_version` stored on every generated row (spec §13).
- **Hard cap of five digest items — enforced by the schema, not the prompt** (spec §13).
- Synthesis spend is recurring: `assertWithinBudget` gates it and `monthlySpendMicros` already counts the `digests` table. Claude Sonnet 5 pricing: **$3/Mtok in, $15/Mtok out** → 3 and 15 micro-dollars per token.
- `LLM_ENABLED=false` skips synthesis silently, like extraction. CI runs in this mode; **no test makes a network request**.
- Annotations may only reference changes that exist: the model returns integer indexes into the list it was given; code validates the range and maps to `change_id`. An out-of-range index fails the attempt.
- All distribution artifacts are static files written by `exportData` through the existing `.tmp`-stage/verify/rename path — no new write mechanics, no running service (spec §14.4).
- **Null semantics documented and preserved**: `monthly_price_usd: null` is "contact sales", never zero, in both dataset files and their schema doc (spec §14.5).
- Dataset rows carry `provenance` so reconstructed history is distinguishable from observed history (spec §14.5). Rows come from the same filters `observationsFor` applies (ok=1, error IS NULL, USD, current prompt_version, hash-collapse): what the dataset publishes and what detection sees must be the same record.
- License CC BY 4.0 with a copy-paste citation (spec §14.5).
- TypeScript strict with `noUncheckedIndexedAccess`; relative imports carry `.js`; tests in `tests/` on temp-dir SQLite; run locks via `acquireRun`/`finishRun` for the new `synthesize` kind; conventional commits.

## Rulings made before execution

**R1 — The Monday gate lives in the trigger, with a `--force` escape.** Spec §13 says the trigger is "evaluated Mondays at 06:00 CT". The container's cron runs daily at 07:00 CT; the code gates on UTC weekday of the injected `now` (Monday) rather than adding a second cron entry. `bellwether synthesize --force` bypasses both the Monday gate and the 3-changes/30-days rule for manual runs — but never the budget or kill switch. *Cost if wrong:* a digest lands a day late; nothing corrupts.

**R2 — `digest.json` is a new export file; `changes.json` gains annotations in place.** The site needs the latest digest and per-change annotations. Rather than a joins-everything mega-file, `digest.json` carries the latest digest (or an explicit empty state) and `changes.json` entries gain an optional `annotation` field. Both flow through the existing guard/staging machinery automatically.

**R3 — `changes.xml` and `llms.txt` are written by `exportData` into `web/public/` (not `web/public/data/`)**, since their URLs are `/changes.xml` and `/llms.txt` (spec §14.4). They join the same staged-write list; the shrink guard applies. The RSS `<description>` uses the annotation when one exists and the structured before/after otherwise, so the feed is never blocked on synthesis.

**R4 — dataset rows are one per (competitor, tier, distinct page state)**, not per calendar day: repeated identical observations collapse exactly as detection collapses them, and `observed_at` is the first sighting of that state. This is the honest grain — publishing a daily grain would fabricate 365 rows/year of pseudo-observations from ~20 real states. `first_observed_at`/`last_observed_at` columns bound each state's validity window.

**R5 — synthesis input is bounded by code, not trust:** at most 20 un-annotated confirmed changes (oldest first) and the prior 4 digest bodies each truncated to 2,000 chars (spec §13 says four priors). With the token guard this keeps the call under ~8k input tokens ≈ $0.03/firing.

## File Structure

| File | Responsibility |
|---|---|
| `src/workflow/detect.ts` (modify) | Rebuild re-links `analyses` by `(source_id, json_path, observed_at)`; orphans deleted (spec §12.2). |
| `src/schema/synthesis.ts` (create) | `WeeklySynthesis` Zod schema + `SYNTH_PROMPT_VERSION`. |
| `src/agents/synthesize_weekly.ts` (create) | The one call: prompt, `messages.parse`, index validation, cost accounting. |
| `src/agents/_client.ts` (modify) | `SYNTH_MODEL` + sonnet cost constants. |
| `src/workflow/synthesize.ts` (create) | Trigger rule, run lock, writes `analyses` + `digests`. |
| `src/workflow/dataset.ts` (create) | Pure builders: dataset rows, CSV serialization, RSS XML, llms.txt text. |
| `src/workflow/export.ts` (modify) | Emit `dataset.csv`, `dataset.json`, `digest.json`, annotations in `changes.json`, `changes.xml`, `llms.txt`. |
| `src/cli.ts` (modify) | `bellwether synthesize [--force] [--dry-run]`; wire into `start`. |
| `web/app/data/page.tsx` (create) | The `/data` page: downloads, schema, methodology, boundary, license, citation. |
| `web/app/page.tsx`, `web/lib/*` (modify) | Latest digest on the board page; annotations in the feed; footer links. |
| `tests/synthesize.test.ts`, `tests/dataset.test.ts` (create); `tests/detect.test.ts`, `tests/export.test.ts` (modify) | Coverage per task. |

---

### Task 1: `analyses` survive `detect --rebuild`

Spec §12.2: "Annotations in `analyses` are re-linked by `(source_id, json_path, observed_at)` where the change survives rebuild, and orphaned annotations are deleted." Today `wipe` is a bare `DELETE FROM changes WHERE source_id = ?` and `analyses.change_id` is a `NOT NULL REFERENCES changes(id)` with `foreign_keys=ON`: the first rebuild after M4 writes a row would abort with `SQLITE_CONSTRAINT_FOREIGNKEY`. M4 makes this latent bomb live, so it is defused first.

**Files:** Modify `src/workflow/detect.ts`; Test `tests/detect.test.ts`.

**Interfaces:** Consumes the existing `wipe`/`insert` flow inside `detect`. Produces no new exports — `DetectStats` gains `relinked: number` and `orphaned: number`.

- [ ] **Step 1: Write the failing tests** — append to `tests/detect.test.ts`:

```ts
describe('analyses across --rebuild (spec 12.2)', () => {
  function annotate(changeId: number): void {
    db.prepare(`INSERT INTO analyses
      (change_id, implication, so_what, confidence, model, prompt_version, created_at)
      VALUES (?, 'price up 25%', 'entry tier repriced', 'high', 'm', 'synth-v1', '2026-08-18T00:00:00.000Z')`)
      .run(changeId);
  }

  it('re-links an annotation whose change survives rebuild', () => {
    observe(20, 'h1', 10);
    observe(21, 'h2', 20);
    detect(db, {});
    const change = db.prepare("SELECT id FROM changes WHERE change_type='price_changed'").get() as { id: number };
    annotate(change.id);

    const stats = detect(db, { rebuild: true });

    const relinked = db.prepare('SELECT a.change_id, c.json_path FROM analyses a JOIN changes c ON c.id = a.change_id')
      .all() as { change_id: number; json_path: string }[];
    expect(relinked).toHaveLength(1);
    expect(relinked[0]!.json_path).toBe('tiers.Pro.monthly_price_usd');
    expect(stats.relinked).toBe(1);
    expect(stats.orphaned).toBe(0);
  });

  it('deletes an annotation whose change does not survive', () => {
    observe(20, 'h1', 10);
    observe(21, 'h2', 20);
    detect(db, {});
    const change = db.prepare("SELECT id FROM changes WHERE change_type='price_changed'").get() as { id: number };
    annotate(change.id);

    // the second observation becomes untrustworthy, so the pair vanishes on rebuild
    db.prepare("UPDATE snapshots SET error = 'curated: verified wrong' WHERE normalized_hash = 'h2'").run();
    const stats = detect(db, { rebuild: true });

    expect((db.prepare('SELECT COUNT(*) n FROM analyses').get() as { n: number }).n).toBe(0);
    expect(stats.orphaned).toBe(1);
    expect(stats.relinked).toBe(0);
  });

  it('rebuild without any analyses is unchanged', () => {
    observe(20, 'h1', 10);
    observe(21, 'h2', 20);
    detect(db, {});
    const stats = detect(db, { rebuild: true });
    expect(stats.relinked).toBe(0);
    expect(stats.orphaned).toBe(0);
  });
});
```

- [ ] **Step 2:** `pnpm vitest run tests/detect.test.ts` — expect FAIL (`relinked` undefined; FK abort on the delete).

- [ ] **Step 3: Implement.** In `src/workflow/detect.ts`: add `relinked: number; orphaned: number` to `DetectStats` (and initializer). Inside the transaction, replace the bare wipe with a park-and-relink:

```ts
    const parkAnalyses = db.prepare(`
      SELECT a.id, a.change_id, c.json_path, c.observed_at,
             a.implication, a.so_what, a.confidence, a.model, a.prompt_version, a.created_at
      FROM analyses a JOIN changes c ON c.id = a.change_id
      WHERE c.source_id = ?
    `);
    const dropAnalysis = db.prepare('DELETE FROM analyses WHERE id = ?');
    const findSurvivor = db.prepare(
      'SELECT id FROM changes WHERE source_id = ? AND json_path = ? AND observed_at = ? LIMIT 1',
    );
```

and in the per-source rebuild branch:

Park the full row, delete all parked (the FK requires it before the wipe), wipe, re-derive, then re-INSERT each parked row whose `(source_id, json_path, observed_at)` finds a surviving change:

```ts
        // Spec 12.2: annotations are re-linked by (source_id, json_path,
        // observed_at) where the change survives rebuild; orphans are deleted.
        // analyses.change_id is NOT NULL REFERENCES changes(id) with
        // foreign_keys=ON, so rows are parked in memory, deleted before the
        // wipe, and re-created against the surviving change afterwards.
        const parked = (opts.rebuild
          ? parkAnalyses.all(source.id)
          : []) as {
            id: number; json_path: string; observed_at: string; implication: string;
            so_what: string; confidence: string; model: string; prompt_version: string; created_at: string;
          }[];
        if (opts.rebuild) {
          for (const row of parked) dropAnalysis.run(row.id);
          wipe.run(source.id);
        }
```

after the pairing loop for this source (still inside the transaction):

```ts
        const reinsertAnalysis = db.prepare(`
          INSERT INTO analyses (change_id, implication, so_what, confidence, model, prompt_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of parked) {
          const survivor = findSurvivor.get(source.id, row.json_path, row.observed_at) as { id: number } | undefined;
          if (survivor) {
            reinsertAnalysis.run(survivor.id, row.implication, row.so_what, row.confidence,
              row.model, row.prompt_version, row.created_at);
            stats.relinked += 1;
          } else {
            stats.orphaned += 1;   // already deleted above — spec: orphans are deleted
          }
        }
```

(Hoist `reinsertAnalysis` next to the other prepared statements; do not prepare it inside the loop. No `UPDATE analyses SET change_id` path exists — delete-and-reinsert is the whole mechanism.)

- [ ] **Step 4:** `pnpm vitest run tests/detect.test.ts` — PASS. **Step 5:** full suite + typecheck. **Step 6:** commit `fix(detect): re-link analyses across --rebuild instead of tripping the FK`.

---

### Task 2: The synthesis schema and agent

**Files:** Create `src/schema/synthesis.ts`, `src/agents/synthesize_weekly.ts`; Modify `src/agents/_client.ts`; Test `tests/synthesize_weekly.test.ts` (create).

**Interfaces:**
- Consumes: `guardTokens`, `assertWithinBudget` patterns from `_client.ts` (extraction's shapes, reused).
- Produces:
  - `src/schema/synthesis.ts`: `SYNTH_PROMPT_VERSION = 'synthesize-v1'`, `WeeklySynthesis` (Zod), `WeeklySynthesisData`
  - `_client.ts`: `SYNTH_MODEL = 'claude-sonnet-5'`, `synthCostMicros(inputTokens, outputTokens)` at 3/15 micro-dollars per token
  - `synthesize_weekly.ts`: `ChangeForSynthesis` interface, `synthesizeWeekly(changes, priorDigests, deps): Promise<SynthesizeResult>`

- [ ] **Step 1: The schema.** Create `src/schema/synthesis.ts`:

```ts
import { z } from 'zod';

export const SYNTH_PROMPT_VERSION = 'synthesize-v1';

/**
 * Spec 13. The hard five-item cap and the annotation-per-change contract are
 * schema facts, not prompt requests. `index` points into the change list the
 * model was shown; code maps it to a change_id and rejects out-of-range.
 */
export const WeeklySynthesis = z.object({
  annotations: z.array(z.object({
    index: z.number().int().min(0),
    implication: z.string().min(1).max(300),
    so_what: z.string().min(1).max(300),
    confidence: z.enum(['high', 'medium', 'low']),
  })).max(20),
  digest_markdown: z.string().min(1).max(4000),
  top: z.array(z.object({
    index: z.number().int().min(0),
    headline: z.string().min(1).max(120),
  })).max(5),
});

export type WeeklySynthesisData = z.infer<typeof WeeklySynthesis>;
```

- [ ] **Step 2: Cost constants.** In `src/agents/_client.ts`, beside the extract constants:

```ts
export const SYNTH_MODEL = 'claude-sonnet-5';

/** Claude Sonnet 5: $3.00 per Mtok input, $15.00 per Mtok output. */
const SYNTH_INPUT_MICROS_PER_TOKEN = 3;
const SYNTH_OUTPUT_MICROS_PER_TOKEN = 15;

export function synthCostMicros(inputTokens: number, outputTokens: number): number {
  return inputTokens * SYNTH_INPUT_MICROS_PER_TOKEN + outputTokens * SYNTH_OUTPUT_MICROS_PER_TOKEN;
}
```

- [ ] **Step 3: The agent.** Create `src/agents/synthesize_weekly.ts`, mirroring `extract_pricing.ts`'s two-attempt shape:

```ts
import { APIError } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { SYNTH_PROMPT_VERSION, WeeklySynthesis, type WeeklySynthesisData } from '../schema/synthesis.js';
import { SYNTH_MODEL, synthCostMicros } from './_client.js';
import type { ExtractClient } from './extract_pricing.js';

export const SYSTEM = `You write the Bellwether digest: a short, factual brief on SaaS pricing
changes, for readers who track competitor pricing professionally.

Rules:
- Every claim must come from the change list you are given. Never invent a
  number, a company, or a date. Reference changes only by their index.
- annotations: one per change, in the same order. implication states what
  changed in plain terms; so_what states why a buyer or competitor would care.
- digest_markdown: at most five short sections, ranked by how much money the
  change moves for a typical customer. Cross-time patterns (a vendor's second
  raise this year, an industry-wide direction) are the most valuable content —
  the prior digests are provided so you can see them.
- Sentence case. No hype, no adjectives where a number will do.
- confidence is "low" when the change's meaning is ambiguous from the data.`;

export interface ChangeForSynthesis {
  id: number;
  competitor: string;
  observed_at: string;
  change_type: string;
  json_path: string;
  before: string | null;
  after: string | null;
}

export type SynthesizeResult =
  | { ok: true; data: WeeklySynthesisData; changeIdByIndex: Map<number, number>;
      inputTokens: number; outputTokens: number; costMicros: number; attempts: number }
  | { ok: false; reason: 'invalid' | 'unindexed'; detail: string };

export interface SynthesizeDeps { client: ExtractClient; maxAttempts?: number }

/** One schema-constrained call. Every retry and refusal is code (spec 5.1/13). */
export async function synthesizeWeekly(
  changes: ChangeForSynthesis[],
  priorDigests: string[],
  deps: SynthesizeDeps,
): Promise<SynthesizeResult> {
  const maxAttempts = deps.maxAttempts ?? 2;

  const payload = [
    'Confirmed changes (reference by index):',
    ...changes.map((c, i) =>
      `[${i}] ${c.competitor} ${c.observed_at.slice(0, 10)} ${c.change_type} ${c.json_path}: ` +
      `${c.before ?? 'none'} -> ${c.after ?? 'none'}`),
    '',
    priorDigests.length ? 'Prior digests, newest first:' : 'No prior digests.',
    ...priorDigests.map((d, i) => `--- digest ${i + 1} ---\n${d.slice(0, 2000)}`),
  ].join('\n');

  let lastDetail = 'no attempt made';
  let lastReason: 'invalid' | 'unindexed' = 'invalid';
  let correction = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Awaited<ReturnType<ExtractClient['messages']['parse']>>;
    try {
      response = await deps.client.messages.parse({
        model: SYNTH_MODEL,
        max_tokens: 4_000,
        system: SYSTEM,
        messages: [{ role: 'user', content: `${correction}${payload}` }],
        output_config: { format: zodOutputFormat(WeeklySynthesis) },
      });
    } catch (err) {
      // Transient API errors propagate — never recorded as a bad synthesis.
      if (err instanceof APIError) throw err;
      lastReason = 'invalid';
      lastDetail = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      correction = `Your previous answer did not match the schema (${lastDetail}). Return valid JSON.\n\n`;
      continue;
    }

    const parsed = WeeklySynthesis.safeParse(response.parsed_output);
    if (!parsed.success) {
      lastReason = 'invalid';
      lastDetail = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      correction = `Your previous answer did not match the schema (${lastDetail}). Return valid JSON.\n\n`;
      continue;
    }

    // The one grounding rule that matters here: every index must exist.
    const indexes = [...parsed.data.annotations.map(a => a.index), ...parsed.data.top.map(t => t.index)];
    const bad = indexes.filter(i => i >= changes.length);
    if (bad.length > 0) {
      lastReason = 'unindexed';
      lastDetail = `referenced nonexistent change index(es) ${bad.join(', ')} of ${changes.length}`;
      correction = `You referenced change indexes that do not exist (${lastDetail}). Only use indexes 0..${changes.length - 1}.\n\n`;
      continue;
    }

    const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
    return {
      ok: true,
      data: parsed.data,
      changeIdByIndex: new Map(changes.map((c, i) => [i, c.id])),
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costMicros: synthCostMicros(usage.input_tokens, usage.output_tokens),
      attempts: attempt,
    };
  }

  return { ok: false, reason: lastReason, detail: lastDetail };
}

export { SYNTH_PROMPT_VERSION };
```

- [ ] **Step 4: Tests** — create `tests/synthesize_weekly.test.ts` with a scripted fake client (same pattern as `tests/extract_pricing.test.ts`): happy path returns mapped ids and sonnet-rate cost (`synthCostMicros(1000, 200)` = 6,000 micros); an out-of-range index triggers exactly one correction retry whose prompt contains `do not exist`; two bad attempts return `{ok:false, reason:'unindexed'}`; a thrown `APIError` propagates without retry; schema rejects a 6-item `top` (feed `top` with 6 entries via the fake and expect the invalid path). Every test injects the client; no network.

- [ ] **Step 5:** run new tests, full suite, typecheck. **Step 6:** commit `feat(synthesize): schema-constrained weekly synthesis agent`.

---

### Task 3: The synthesize workflow and CLI

**Files:** Create `src/workflow/synthesize.ts`; Modify `src/cli.ts`; Test `tests/synthesize.test.ts` (create).

**Interfaces:**
- Consumes: `synthesizeWeekly`, `ChangeForSynthesis` (Task 2); `acquireRun`/`finishRun`; `assertWithinBudget`, `llmEnabled`, `anthropic`, `SYNTH_MODEL`; `SYNTH_PROMPT_VERSION`; `MATERIALITY_THRESHOLD`.
- Produces: `export const SYNTH_MIN_CHANGES = 3`, `SYNTH_MAX_CHANGES = 20`, `SYNTH_STALE_DAYS = 30`, `PRIOR_DIGESTS = 4`; `shouldSynthesize(db, now, opts): { fire: boolean; reason: string }`; `synthesize(db, opts?, deps?): Promise<SynthStats>`.

**The trigger (spec §13), all code:** pending = confirmed changes at/above threshold with no `analyses` row at `SYNTH_PROMPT_VERSION`. Fire when `now` is a Monday (UTC) AND (pending ≥ 3 OR (pending ≥ 1 AND last digest older than 30 days)). Zero pending never fires — an empty digest is the artifact the spec forbids. `--force` skips the Monday and volume gates only.

- [ ] **Step 1: Failing tests** — create `tests/synthesize.test.ts` (temp-DB setup as elsewhere; helpers that insert a source, a confirmed change, an optional digest row):

```ts
// trigger truth table — NOW_MONDAY = 2026-08-17T13:00Z, NOW_TUESDAY = +1 day
// 3 pending, Monday                          -> fire
// 2 pending, Monday, no prior digest, 0d     -> hold ("2 pending < 3")
// 1 pending, Monday, last digest 31d old     -> fire (stale rule)
// 0 pending, Monday, last digest 90d old     -> hold (never fire empty)
// 3 pending, Tuesday                         -> hold; --force on Tuesday -> fire
// annotated changes do not count as pending (insert analyses row at SYNTH_PROMPT_VERSION)
```

Then the workflow behaviors: a successful run writes one `digests` row (with `model`, `prompt_version`, `cost_micros`, `item_count = top.length`) and one `analyses` row per annotation `ON CONFLICT (change_id, prompt_version) DO NOTHING`; `LLM_ENABLED=false` → `stats.skipped = true`, no rows; a `BudgetExceededError` from `assertWithinBudget` → skipped with the warning, no throw; a failed synthesis (`ok:false`) → run recorded `failed`, no partial rows (transactional); `--dry-run` evaluates the trigger and calls nothing; caps: 25 pending → only oldest 20 sent (assert via the injected synthesizer's argument); only 4 prior digest bodies passed, newest first.

- [ ] **Step 2:** run to FAIL. **Step 3: Implement** `src/workflow/synthesize.ts`:

```ts
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
  synthesizer?: typeof synthesizeWeekly;
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
```

- [ ] **Step 4: CLI.** Add to `src/cli.ts` after `detect`:

```ts
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
        : `No digest: ${s.reason}${s.skipped ? ' (skipped: LLM disabled or budget exhausted)' : ''}`,
    );
    db.close();
  });
```

and in `start`, after detect and before export:

```ts
    const { synthesize } = await import('./workflow/synthesize.js');
    const synthStats = await synthesize(db, {});
    console.log(synthStats.fired
      ? `Digest: ${synthStats.itemCount} items, ${synthStats.annotated} annotated.`
      : `Digest: not fired (${synthStats.reason}).`);
```

- [ ] **Step 5:** full suite + typecheck. **Step 6:** commit `feat(synthesize): adaptive digest trigger, workflow, and CLI`.

---

### Task 4: Dataset, RSS, and llms.txt builders

Pure functions in one new file; `export.ts` wiring comes in Task 5 so this task is testable without touching the write path.

**Files:** Create `src/workflow/dataset.ts`; Test `tests/dataset.test.ts` (create).

**Interfaces:**
- Consumes: `observationsFor` from `detect.js` — already applies ok=1, `error IS NULL`, USD, prompt-version, hash-collapse. **Do not re-derive those filters.** Needs `provenance` per observation: extend `Observation` with `provenance: string` (add `s.provenance` to `observationsFor`'s SELECT and struct — a two-line change to `detect.ts`, existing tests unaffected).
- Produces:
  - `export interface DatasetRow { competitor: string; tier: string; first_observed_at: string; last_observed_at: string; monthly_price_usd: number | null; annual_price_usd: number | null; billing_unit: string; included_seats: number | null; is_free: boolean; is_enterprise: boolean; currency: 'USD'; provenance: 'live' | 'wayback' | 'mixed' }`
  - `buildDatasetRows(db): DatasetRow[]`
  - `toCsv(rows: DatasetRow[]): string`
  - `buildRssXml(changes: FeedChange[], generatedAt: string, siteUrl: string): string` with `export interface FeedChange { competitor: string; slug: string; change_type: string; json_path: string; before: unknown; after: unknown; observed_at: string; annotation: { implication: string; so_what: string } | null }`
  - `buildLlmsTxt(siteUrl: string, competitors: { name: string; slug: string }[]): string`

**Behavior:**
- `buildDatasetRows`: per source, walk `observationsFor` output; per observation, per tier, emit/extend a row per contiguous run of identical `(tier, monthly, annual, billing_unit, seats, flags)` — `first_observed_at` = first sighting, `last_observed_at` = last observation in the run (ruling R4: one row per state, not per day). `provenance` per row: `'live'` if every observation in the run is live, `'wayback'` if every one is a capture, `'mixed'` otherwise (spec §14.5: reconstructed vs observed must be distinguishable).
- `toCsv`: header row; RFC-4180 quoting (quote when a field contains `"`, `,`, or newline; double embedded quotes); `null` → empty field; booleans as `true`/`false`. **Null is an empty field, never `0`.**
- `buildRssXml`: RSS 2.0, `<title>` from the same label grammar as timeline markers — reuse `describeChange` by exporting it from `export.ts`... **no — inverse dependency.** Move `describeChange` (and its `value` helper) from `export.ts` into `dataset.ts`, export both, and have `export.ts` import them back. `<description>` is the annotation (`implication — so_what`) when present, else `before -> after`. `<guid isPermaLink="false">` = `slug|json_path|observed_at`. `<pubDate>` RFC-822 via `new Date(observed_at).toUTCString()`. XML-escape `& < > " '` in every text node. At most 50 items, newest first.
- `buildLlmsTxt` (spec §14.4): markdown-ish plaintext — one line on what the dataset is, the CC BY 4.0 license, then stable endpoints: `/data/board.json`, `/data/changes.json`, `/data/timeline.json`, `/data/dataset.json`, `/data/dataset.csv`, `/changes.xml`, and per-competitor anchors on `/`. Deterministic output — no timestamps (the file would churn every export).

- [ ] **Step 1: failing tests** in `tests/dataset.test.ts` (temp DB, seed, insert observations via the snapshot+extraction helper used in `tests/timeline.test.ts`):
  - two identical observations then a price change → **two** rows for that tier with correct `first/last_observed_at` window boundaries;
  - a contact-sales tier keeps `monthly_price_usd` null and the CSV field is **empty**, not 0;
  - provenance: run of two wayback observations → `'wayback'`; wayback then live with no state change → `'mixed'`;
  - CSV quoting: a tier literally named `Team "Pro", v2` round-trips;
  - RSS: valid XML (parse with `node-html-parser` in XML mode or regex-count matched tags), newest first, annotation used when present, structured fallback otherwise, ampersand in a competitor name escaped, 60 changes → 50 items;
  - llms.txt: contains every endpoint, the license, no ISO timestamp;
  - `describeChange` behavior unchanged after the move (dotted tier name, annual field, `none` for null) — port the existing assertions from `tests/timeline.test.ts` if they live there, else assert directly.
- [ ] **Step 2:** FAIL. **Step 3:** implement `dataset.ts` (single file, no I/O beyond the `db` reads in `buildDatasetRows`); move `describeChange`/`value` out of `export.ts` with `export.ts` importing them. **Step 4:** PASS; full suite; typecheck. **Step 5:** commit `feat(dataset): dataset rows, CSV, RSS, and llms.txt builders`.

---

### Task 5: Wire distribution into export

**Files:** Modify `src/workflow/export.ts`, `src/workflow/detect.ts` (the two-line `provenance` addition if not already done in Task 4); Test `tests/export.test.ts`.

**Interfaces:** Consumes Task 4's builders. Produces: `exportData` writes four new artifacts — `dataset.json`, `dataset.csv` into `outDir`; `changes.xml`, `llms.txt` into `outDir/..` when `outDir` ends in `/data`, else alongside (implement as an explicit second directory: `exportData(db, outDir, deps)` gains `deps.siteDir ?? join(outDir, '..')`). `changes.json` entries gain `annotation`; new `digest.json`.

**Details:**
- `changes.json` query LEFT JOINs `analyses` at `SYNTH_PROMPT_VERSION`; entry gains `annotation: { implication, so_what, confidence } | null`.
- `digest.json`: latest digest row or `{ generated_at, digest: null }`; when present: `{ period_start, period_end, body_markdown, item_count, created_at }`. Never the model name in public output — cost and mechanics live on the status page, not the artifact.
- `dataset.json`: `{ generated_at, license: 'CC BY 4.0', schema_version: 1, rows }` (annotated change log stays in `changes.json`; do not duplicate it — deviation from spec §14.5's "plus the change log", recorded here: one canonical location per artifact, the page links both).
- `dataset.csv` staged/verified like JSON files but skip `JSON.parse` verification for it — verify instead that it is non-empty and starts with the exact header. The shrink guard applies as-is.
- `changes.xml` / `llms.txt`: staged the same way; XML verified by matched `<item>` counts, llms.txt by containing `/data/dataset.json`.
- `board.json` competitors each gain `slug` anchors already; add `dataset_url` fields only if trivial — otherwise skip (YAGNI).
- Tests: files list assertion updated (this breaks `tests/export.test.ts`'s exact-list check — update it, as in M3); a change with an annotation carries it into `changes.json`; `digest.json` empty state; `dataset.csv` header exact; guard still refuses a >50% shrink of `dataset.csv`.

- [ ] Steps: failing tests → implement → full suite + typecheck → commit `feat(export): ship dataset, digest, RSS, and llms.txt artifacts`.

---

### Task 6: The /data page and digest on the board

**Files:** Create `web/app/data/page.tsx`; Modify `web/app/page.tsx`, `web/lib/types.ts`, `web/lib/data.ts`; Test: `cd web && pnpm build` is the gate, plus rendered-HTML greps as in M3.

**Interfaces:** Consumes `digest.json`, `dataset.json` metadata (row count only — do not ship 200KB of rows into the page bundle; read the file at build time and count), `changes.json` annotations.

**Page content (spec §14.5, all static):**
1. Header: "The dataset" + one-line description.
2. Download cards: `dataset.csv` / `dataset.json` with row count and generated date; plain `<a href>` links (files are in `public/`).
3. **Schema table**: every column, type, null semantics — `monthly_price_usd empty/null = contact sales, never free`; `provenance = live | wayback | mixed` with one sentence each.
4. **Methodology**: sources checked daily at 07:00 CT; extraction via schema-constrained LLM with grounding checks; two-observation confirmation rule; curation policy (observations verified wrong are excluded and the exclusion recorded); backfill resolution is monthly so a change is dated to within a month; live observations are daily.
5. **Boundary**: the six companies in scope; Vercel and Jira screened out for client-side-rendered pricing (spec §14.5: naming exclusions makes inclusions credible).
6. **License + citation**: CC BY 4.0; a copy-paste plain citation and a BibTeX block in `<pre>` (no copy-button JS — static export).
7. Footer link from the board page; RSS `<link rel="alternate">` in the layout head; digest section on the board page rendering `digest.json`'s markdown body (render with a ~30-line minimal renderer: paragraphs, `##` headings, `**bold**`, `-` lists — no dependency; escape HTML first).

**Board page**: "The brief" section between the timeline and footer — latest digest body + its date, or the empty state "No digest yet — the first one fires after three confirmed changes." Feed entries on `/data`? No — annotations render in the change feed section if the board has one; today changes render only via JSON, so add a compact "Recent confirmed changes" list (competitor, label via the same marker grammar, annotation italic beneath) capped at 10 on the board page.

- [ ] Steps: types + loaders (`loadDigest`, `loadDataset` metadata) → `/data` page → board sections → `cd web && pnpm build` → grep rendered HTML for: schema table present, citation block, license, digest empty-state or body, `<link rel="alternate" type="application/rss+xml"` in head, no `NaN` — then commit `feat(web): /data page, digest brief, and annotated change list`.

---

## Post-execution (controller, after review)

- [ ] `pnpm bw synthesize --dry-run` — trigger reports correctly against the real archive (12 confirmed, 0 annotated → "12 pending", fires only with `--force` unless Monday).
- [ ] `pnpm bw synthesize --force` — one real sonnet call (~$0.03). **Human-eyeball the digest**: every number in it must appear in the change list; no invented vendors; tone is ledger, not marketing.
- [ ] `pnpm bw export` — inspect `dataset.csv` in a spreadsheet; validate `changes.xml` in an RSS validator; check `/llms.txt`.
- [ ] `cd web && pnpm build`, eyeball `/data` at 375px, then `pnpm bw export --publish`.
- [ ] Homelab: `ssh nicksaiserver 'cd ~/bellwether && git pull && docker compose up -d --build'`; verify healthy; confirm the box's Monday run evaluates the trigger (its own DB has few confirmed changes — likely "pending < 3", which is correct).

## Deferred (recorded, not this milestone)

- Competitor pages `/c/<slug>` with JSON-LD Dataset markup, the change ribbon at three scales, Bricolage/Public Sans/Plex Mono typography (spec §14.2 views 4-5, §14.3) — the UI milestone.
- Citation badge snippet (spec §14.4) — with the competitor pages.
- Live filter hit rates + spend on a "How it works" page (spec §14.2 view 5).
- Digest email delivery — no send channel exists until M5's alerting.
