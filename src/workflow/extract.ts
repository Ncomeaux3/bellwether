import type { DB } from '../ops/db.js';
import { acquireRun, finishRun } from '../ops/runs.js';
import { normalizeAndSlice } from '../tools/normalize.js';
import { EXTRACT_PROMPT_VERSION } from '../schema/pricing.js';
import {
  BudgetExceededError, EXTRACT_MODEL, anthropic, assertWithinBudget, llmEnabled,
} from '../agents/_client.js';
import { extractPricing, type ExtractResult } from '../agents/extract_pricing.js';

export interface ExtractOptions { limit?: number; dryRun?: boolean }

export interface ExtractStats {
  considered: number; hashed: number; cached: number;
  extracted: number; skipped: number; degraded: number; mismatched: number;
  historicalFailed: number;
}

export interface ExtractWorkflowDeps {
  extractor?: (text: string) => Promise<ExtractResult>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

interface PendingRow {
  id: number; source_id: number; raw_content: string | null;
  raw_hash: string | null; normalized_hash: string | null; provenance: string;
}

/**
 * Spec 5.2: queries the DB for outstanding work rather than holding state.
 * Hashing is free and always runs; the LLM call is gated by cache, kill
 * switch, and budget, in that order.
 */
export async function extract(
  db: DB,
  opts: ExtractOptions = {},
  deps: ExtractWorkflowDeps = {},
): Promise<ExtractStats> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const stats: ExtractStats = {
    considered: 0, hashed: 0, cached: 0, extracted: 0, skipped: 0,
    degraded: 0, mismatched: 0, historicalFailed: 0,
  };

  const runId = acquireRun(db, 'extract', { now });

  try {
    // Snapshots that carry content and have not been extracted at this prompt version.
    // --limit caps LLM calls actually made below, not this candidate set — the
    // oldest snapshots are exactly the ones most likely already cached, so
    // limiting the query here would make `--limit 1` do no new work at all
    // once the archive has grown past the first run.
    const pending = db.prepare(`
      SELECT s.id, s.source_id, s.raw_content, s.raw_hash, s.normalized_hash, s.provenance
      FROM snapshots s
      WHERE s.ok = 1 AND s.raw_content IS NOT NULL
      ORDER BY s.observed_at, s.id
    `).all() as PendingRow[];

    const setHash = db.prepare('UPDATE snapshots SET normalized_hash = ? WHERE id = ?');
    const propagate = db.prepare(
      'UPDATE snapshots SET normalized_hash = ? WHERE source_id = ? AND raw_hash = ? AND normalized_hash IS NULL',
    );
    const findExtraction = db.prepare(
      'SELECT id FROM extractions WHERE normalized_hash = ? AND prompt_version = ?',
    );
    const insertExtraction = db.prepare(`
      INSERT INTO extractions
        (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
         is_backfill, model, prompt_version, input_tokens, output_tokens, cost_micros, created_at)
      VALUES (@hash, 'pricing', @data, @confidence, @currency, 1,
              @isBackfill, @model, @promptVersion, @inputTokens, @outputTokens, @costMicros, @createdAt)
    `);
    const degrade = db.prepare('UPDATE sources SET degraded_reason = ? WHERE id = ?');

    const runExtractor = deps.extractor
      ?? ((text: string) => extractPricing(text, { client: anthropic() as never }));

    let llmCalls = 0;
    for (const row of pending) {
      stats.considered += 1;
      if (row.raw_content === null) continue;

      // Spec 7 schema: provenance is 'live' or 'wayback:<ts>'. An extraction is
      // keyed on normalized_hash and shared between historical and live
      // snapshots; whichever one triggered the call is the budget that paid for
      // it, so the flag records that and is never rewritten afterwards.
      const historical = row.provenance.startsWith('wayback:');

      const { text, normalizedHash } = normalizeAndSlice(row.raw_content);

      if (row.normalized_hash !== normalizedHash) {
        setHash.run(normalizedHash, row.id);
        stats.hashed += 1;
      }

      // Deduplicated snapshots share a raw_hash but carry NULL raw_content, so
      // they can never be hashed on their own. `collect` keeps inserting new
      // siblings like this on every repeat day, so this must run every pass —
      // not just the first time this row's own hash is written — or detect
      // (spec 12.2) silently sees a shrinking fraction of the archive.
      if (row.raw_hash !== null) propagate.run(normalizedHash, row.source_id, row.raw_hash);

      if (findExtraction.get(normalizedHash, EXTRACT_PROMPT_VERSION) !== undefined) {
        stats.cached += 1;
        continue;
      }

      if (!llmEnabled(env)) { stats.skipped += 1; continue; }

      // Spec 15.2: is_backfill rows are excluded from monthlySpendMicros, so
      // gating them on that same figure would be one-sided — a live archive
      // sitting near its recurring cap would refuse the whole historical
      // corpus. Bulk history is bounded by `backfill --budget` instead
      // (spec 12.1), which reaches this loop as opts.limit.
      try {
        if (!historical) assertWithinBudget(db, { now, env });
      } catch (err) {
        if (!(err instanceof BudgetExceededError)) throw err;
        console.warn(err.message);
        stats.skipped += pending.length - stats.considered + 1;
        break;
      }

      if (opts.dryRun) { stats.skipped += 1; continue; }

      llmCalls += 1;
      const result = await runExtractor(text);

      if (!result.ok) {
        // Spec 12.1 / ruling R3: a capture from 2025 failing today's extraction
        // is a fact about that page in 2025, not a health signal about the
        // source today. Degrading here would paint the live source red on the
        // public status board with no path back — every later `extract` pass
        // re-reads the same historical snapshot and re-degrades it.
        if (historical) {
          stats.historicalFailed += 1;
        } else {
          stats.degraded += 1;
          degrade.run(`extraction ${result.reason}: ${result.detail}`.slice(0, 300), row.source_id);
        }
        if (opts.limit !== undefined && llmCalls >= opts.limit) break;
        continue;
      }

      insertExtraction.run({
        hash: normalizedHash,
        data: JSON.stringify(result.data),
        confidence: result.data.extraction_confidence,
        currency: result.data.currency,
        isBackfill: historical ? 1 : 0,
        model: EXTRACT_MODEL,
        promptVersion: EXTRACT_PROMPT_VERSION,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicros: result.costMicros,
        createdAt: now().toISOString(),
      });
      stats.extracted += 1;
      // Spec 12.4: stored, but excluded from diffing by detect.
      if (result.data.currency !== 'USD') stats.mismatched += 1;

      // --limit caps LLM calls made (spec 5.2), not candidates scanned — see
      // the comment on the `pending` query above.
      if (opts.limit !== undefined && llmCalls >= opts.limit) break;
    }

    finishRun(db, runId, true, stats);
    return stats;
  } catch (err) {
    finishRun(db, runId, false, stats, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
