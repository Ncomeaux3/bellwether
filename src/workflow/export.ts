import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DB } from '../ops/db.js';
import { MATERIALITY_THRESHOLD } from '../tools/materiality.js';
import { EXTRACT_PROMPT_VERSION } from '../schema/pricing.js';
import { monthlySpendMicros } from '../agents/_client.js';

const run = promisify(execFile);

export class ExportGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportGuardError';
  }
}

export interface ExportStats {
  files: string[];
  competitors: number;
  healthySources: number;
  totalSources: number;
  confirmedChanges: number;
}

export interface ExportDeps { now?: () => Date }

export type SourceState = 'ok' | 'degraded' | 'failing' | 'pending';

interface SourceRow {
  source_id: number;
  slug: string;
  name: string;
  homepage: string;
  kind: string;
  url: string;
  degraded_reason: string | null;
  last_checked_at: string | null;
  last_ok_at: string | null;
  last_ok_flag: number | null;
  distinct_states: number;
  current_pricing_json: string | null;
}

function stateOf(row: SourceRow): SourceState {
  if (row.last_checked_at === null) return 'pending';
  if (row.last_ok_flag === 0) return 'failing';
  if (row.degraded_reason !== null) return 'degraded';
  return 'ok';
}

/**
 * Spec 15.7: the published artifact is the deliverable, and overwriting it with
 * nothing is the one unrecoverable failure. Every file is written to .tmp first
 * and only renamed after every guard passes, so a trip leaves the last good
 * publish completely untouched.
 */
export function exportData(db: DB, outDir: string, deps: ExportDeps = {}): ExportStats {
  const now = (deps.now ?? (() => new Date()))();
  const generatedAt = now.toISOString();
  mkdirSync(outDir, { recursive: true });

  const rows = db.prepare(`
    SELECT
      s.id AS source_id, c.slug, c.name, c.homepage, s.kind, s.url, s.degraded_reason,
      (SELECT MAX(fetched_at) FROM snapshots WHERE source_id = s.id) AS last_checked_at,
      (SELECT MAX(fetched_at) FROM snapshots WHERE source_id = s.id AND ok = 1) AS last_ok_at,
      (SELECT ok FROM snapshots WHERE source_id = s.id ORDER BY fetched_at DESC, id DESC LIMIT 1) AS last_ok_flag,
      (SELECT COUNT(DISTINCT raw_hash) FROM snapshots WHERE source_id = s.id AND raw_hash IS NOT NULL) AS distinct_states,
      (SELECT e.data_json FROM snapshots sn
         JOIN extractions e ON e.normalized_hash = sn.normalized_hash
        WHERE sn.source_id = s.id AND sn.ok = 1
          AND e.currency = 'USD' AND e.prompt_version = @promptVersion
        ORDER BY sn.observed_at DESC, sn.id DESC LIMIT 1) AS current_pricing_json
    FROM sources s
    JOIN competitors c ON c.id = s.competitor_id
    WHERE s.active = 1 AND c.active = 1
    ORDER BY c.name, s.kind
  `).all({ promptVersion: EXTRACT_PROMPT_VERSION }) as SourceRow[];

  const bySlug = new Map<string, { slug: string; name: string; homepage: string; sources: unknown[] }>();
  let healthy = 0;

  for (const row of rows) {
    const state = stateOf(row);
    if (state === 'ok') healthy += 1;

    if (!bySlug.has(row.slug)) {
      bySlug.set(row.slug, { slug: row.slug, name: row.name, homepage: row.homepage, sources: [] });
    }
    bySlug.get(row.slug)!.sources.push({
      kind: row.kind,
      url: row.url,
      state,
      last_checked_at: row.last_checked_at,
      last_ok_at: row.last_ok_at,
      distinct_states: row.distinct_states,
      degraded_reason: row.degraded_reason,
      current_pricing: row.current_pricing_json === null
        ? null
        : JSON.parse(row.current_pricing_json) as unknown,
    });
  }

  const competitors = [...bySlug.values()];

  const lastRun = db.prepare(
    'SELECT kind, started_at, ended_at, state FROM runs ORDER BY id DESC LIMIT 1'
  ).get() as { kind: string; started_at: string; ended_at: string | null; state: string } | undefined;

  const board = { generated_at: generatedAt, competitors };
  const status = {
    generated_at: generatedAt,
    total_sources: rows.length,
    healthy_sources: healthy,
    sources: rows.map(r => ({
      slug: r.slug, kind: r.kind, state: stateOf(r),
      last_ok_at: r.last_ok_at, degraded_reason: r.degraded_reason,
    })),
    last_run: lastRun ?? null,
    cost_micros_month: monthlySpendMicros(db, now),
  };

  const confirmed = db.prepare(`
    SELECT ch.id, ch.change_type, ch.json_path, ch.before_json, ch.after_json,
           ch.materiality, ch.observed_at, c.name AS competitor, c.slug
    FROM changes ch
    JOIN sources s ON s.id = ch.source_id
    JOIN competitors c ON c.id = s.competitor_id
    WHERE ch.state = 'confirmed' AND ch.materiality >= ?
    ORDER BY ch.observed_at DESC, ch.id DESC
    LIMIT 200
  `).all(MATERIALITY_THRESHOLD) as Record<string, unknown>[];

  const changesFeed = {
    generated_at: generatedAt,
    threshold: MATERIALITY_THRESHOLD,
    changes: confirmed.map(c => ({
      competitor: c.competitor,
      slug: c.slug,
      change_type: c.change_type,
      json_path: c.json_path,
      before: c.before_json === null ? null : JSON.parse(String(c.before_json)),
      after: c.after_json === null ? null : JSON.parse(String(c.after_json)),
      materiality: c.materiality,
      observed_at: c.observed_at,
    })),
  };

  const payloads: Record<string, unknown> = { 'board.json': board, 'status.json': status, 'changes.json': changesFeed };

  // ---- Guards (spec 15.7). All must pass before anything is renamed. -----
  if (competitors.length === 0) {
    throw new ExportGuardError(
      'Refusing to publish: no active competitors found. Run `bellwether seed` first.'
    );
  }

  const previousBoardPath = join(outDir, 'board.json');
  if (existsSync(previousBoardPath)) {
    const previous = JSON.parse(readFileSync(previousBoardPath, 'utf8')) as { competitors?: unknown[] };
    const previousCount = previous.competitors?.length ?? 0;
    if (competitors.length < previousCount) {
      throw new ExportGuardError(
        `Refusing to publish fewer competitors than the last publish ` +
        `(${competitors.length} now, ${previousCount} before). ` +
        `If this is intentional, delete ${previousBoardPath} and export again.`
      );
    }
  }

  const staged: { final: string; tmp: string }[] = [];
  try {
    for (const [name, payload] of Object.entries(payloads)) {
      const serialized = JSON.stringify(payload, null, 2);
      const finalPath = join(outDir, name);

      if (existsSync(finalPath)) {
        const previousSize = readFileSync(finalPath, 'utf8').length;
        if (previousSize > 0 && serialized.length < previousSize * 0.5) {
          throw new ExportGuardError(
            `Refusing to publish: ${name} shrank from ${previousSize} to ${serialized.length} bytes. ` +
            `A file losing more than half its content usually means a query broke.`
          );
        }
      }

      const tmpPath = `${finalPath}.tmp`;
      writeFileSync(tmpPath, serialized);
      JSON.parse(readFileSync(tmpPath, 'utf8'));
      staged.push({ final: finalPath, tmp: tmpPath });
    }

    for (const { final, tmp } of staged) renameSync(tmp, final);
  } catch (err) {
    // A tripped guard must leave no trace. Remove anything already staged so a
    // later run never renames a half-written set.
    for (const { tmp } of staged) { try { unlinkSync(tmp); } catch { /* already gone */ } }
    throw err;
  }

  return {
    files: Object.keys(payloads),
    competitors: competitors.length,
    healthySources: healthy,
    totalSources: rows.length,
    confirmedChanges: confirmed.length,
  };
}

export interface CommitFacts { changes: number; sources: number; date: string }

/** Spec 14.1: a fixed format so `git log` reads as a changelog of the market. */
export function buildCommitMessage(facts: CommitFacts): string {
  const changes = facts.changes === 0
    ? 'no changes'
    : `${facts.changes} change${facts.changes === 1 ? '' : 's'}`;
  const sources = `${facts.sources} source${facts.sources === 1 ? '' : 's'}`;
  return `data: ${changes}, ${sources}, ${facts.date}`;
}

export interface PublishDeps {
  exec?: (file: string, args: string[], opts: { cwd: string }) => Promise<unknown>;
}

/**
 * Spec 14.1: never force-pushes. A conflicting push aborts and retries next
 * run, because a stale publish is recoverable and a clobbered one is not.
 */
export async function publish(
  repoRoot: string,
  message: string,
  deps: PublishDeps = {}
): Promise<{ pushed: boolean; detail: string }> {
  const exec = deps.exec ?? ((f: string, a: string[], o: { cwd: string }) => run(f, a, o));

  await exec('git', ['add', 'web/public/data'], { cwd: repoRoot });

  try {
    await exec('git', ['diff', '--cached', '--quiet'], { cwd: repoRoot });
    return { pushed: false, detail: 'nothing to publish — the data is unchanged' };
  } catch {
    // A non-zero exit from --quiet means there are staged changes. Proceed.
  }

  await exec('git', ['commit', '-m', message], { cwd: repoRoot });

  try {
    await exec('git', ['push', 'origin', 'HEAD'], { cwd: repoRoot });
    return { pushed: true, detail: message };
  } catch (err) {
    return {
      pushed: false,
      detail: `push rejected, will retry next run: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    };
  }
}
