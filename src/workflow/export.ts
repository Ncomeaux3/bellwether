import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DB } from '../ops/db.js';
import { MATERIALITY_THRESHOLD } from '../tools/materiality.js';
import { EXTRACT_PROMPT_VERSION } from '../schema/pricing.js';
import { monthlySpendMicros } from '../agents/_client.js';
import { observationsFor } from './detect.js';

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
 * Wayback captures are monthly (spec 12.1, `collapse=timestamp:6`), so ~31 days
 * between points is normal and two consecutive missed months is a real hole in
 * the record. Spec 14.3: a hole renders as a break, never as interpolation.
 */
export const TIMELINE_GAP_DAYS = 75;
const GAP_MS = TIMELINE_GAP_DAYS * 86_400_000;

export interface TimelinePoint { observed_at: string; price: number }
export interface TimelineSeries { tier: string; segments: TimelinePoint[][] }
export interface TimelineMarker { observed_at: string; label: string }
export interface TimelineCompetitor {
  slug: string; name: string;
  first_observed_at: string | null; last_observed_at: string | null;
  series: TimelineSeries[]; markers: TimelineMarker[];
}
export interface TimelinePayload {
  generated_at: string; observation_count: number; competitors: TimelineCompetitor[];
}

/**
 * Spec 14.3. Every series break is decided here, so the React component holds
 * no judgement: it draws one polyline per segment and nothing else.
 *
 * Built on observationsFor(), which already applies the USD filter (12.4), the
 * prompt-version filter, the repeated-hash collapse (12.2), and Zod validation.
 */
export function buildTimeline(db: DB, generatedAt: string): TimelinePayload {
  const sources = db.prepare(`
    SELECT s.id AS source_id, c.slug, c.name
    FROM sources s JOIN competitors c ON c.id = s.competitor_id
    WHERE s.active = 1 AND c.active = 1 AND s.kind = 'pricing'
    ORDER BY c.name
  `).all() as { source_id: number; slug: string; name: string }[];

  const markerRows = db.prepare(`
    SELECT ch.source_id, ch.json_path, ch.change_type, ch.before_json, ch.after_json, ch.observed_at
    FROM changes ch
    WHERE ch.state = 'confirmed' AND ch.materiality >= ?
    ORDER BY ch.observed_at
  `).all(MATERIALITY_THRESHOLD) as {
    source_id: number; json_path: string; change_type: string;
    before_json: string | null; after_json: string | null; observed_at: string;
  }[];

  let observationCount = 0;
  const competitors: TimelineCompetitor[] = [];

  for (const source of sources) {
    const observations = observationsFor(db, source.source_id);
    observationCount += observations.length;

    // tier name -> the segments built so far, plus where the open one left off
    const building = new Map<string, { segments: TimelinePoint[][]; lastAt: number | null }>();

    for (const observation of observations) {
      const at = Date.parse(observation.observedAt);
      const priced = new Map<string, number>();
      for (const tier of observation.data.tiers) {
        // null is "contact sales", and it is not zero. Plotting it as zero
        // would be the most misleading thing this chart could do.
        if (typeof tier.monthly_price_usd === 'number') priced.set(tier.name, tier.monthly_price_usd);
      }

      for (const [name, price] of priced) {
        let entry = building.get(name);
        if (!entry) { entry = { segments: [], lastAt: null }; building.set(name, entry); }

        const open = entry.segments[entry.segments.length - 1];
        const continuous = open !== undefined && entry.lastAt !== null && at - entry.lastAt <= GAP_MS;

        if (continuous) open!.push({ observed_at: observation.observedAt, price });
        else entry.segments.push([{ observed_at: observation.observedAt, price }]);

        entry.lastAt = at;
      }

      // A tier absent from this observation ends its run: the next appearance
      // starts a new segment rather than a line drawn across its absence.
      for (const [name, entry] of building) {
        if (!priced.has(name)) entry.lastAt = null;
      }
    }

    const series: TimelineSeries[] = [...building.entries()]
      .map(([tier, entry]) => ({ tier, segments: entry.segments }))
      .filter(s => s.segments.length > 0)
      .sort((a, b) => a.tier.localeCompare(b.tier));

    // The chart only ever plots this range. A marker outside it draws off
    // the axis (an SVG x1 in the negative thousands, clipped but pointless).
    const plottedTimes = series.flatMap(s => s.segments.flat()).map(p => Date.parse(p.observed_at));
    const tMin = plottedTimes.length > 0 ? Math.min(...plottedTimes) : null;
    const tMax = plottedTimes.length > 0 ? Math.max(...plottedTimes) : null;

    competitors.push({
      slug: source.slug,
      name: source.name,
      first_observed_at: observations[0]?.observedAt ?? null,
      last_observed_at: observations[observations.length - 1]?.observedAt ?? null,
      series,
      markers: markerRows
        .filter(m => m.source_id === source.source_id)
        .filter(m => {
          if (tMin === null || tMax === null) return false;
          const at = Date.parse(m.observed_at);
          return at >= tMin && at <= tMax;
        })
        .map(m => ({ observed_at: m.observed_at, label: describeChange(m) })),
    });
  }

  return { generated_at: generatedAt, observation_count: observationCount, competitors };
}

/**
 * SQL NULL and the JSON string "null" are different things here: diff.ts
 * always writes JSON.stringify(v ?? null), so an absent value is the
 * four-character string 'null', never a SQL-NULL column. Both must read as
 * "none" — a contact-sales tier is not the word "null".
 */
const value = (raw: string | null): string => {
  if (raw === null) return 'none';
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null ? 'none' : String(parsed);
  } catch {
    return 'none';
  }
};

/** Short, literal marker text. No adjectives — the number is the story. */
function describeChange(row: {
  json_path: string; change_type: string; before_json: string | null; after_json: string | null;
}): string {
  const parts = row.json_path.split('.');
  const field = parts[parts.length - 1] ?? '';
  const tier = row.json_path.startsWith('tiers.')
    ? (parts.slice(1, -1).join('.') || parts.slice(1).join('.'))
    : row.json_path;

  // diff.ts writes 'price_changed' (past tense) at both .monthly_price_usd
  // and .annual_price_usd with identical materiality — the field name must
  // stay in the label or an annual move reads as a monthly one.
  if (row.change_type === 'price_changed') {
    // The chart's axis is already dollars, so "usd" is noise in a marker
    // label: "Pro annual price 96 to 120", not "Pro annual price usd 96 to 120".
    const label = field === 'monthly_price_usd'
      ? ''
      : `${field.replace(/_usd$/, '').replace(/_/g, ' ')} `;
    return `${tier} ${label}${value(row.before_json)} to ${value(row.after_json)}`;
  }
  return `${tier} ${row.change_type.replace(/_/g, ' ')}`;
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

  const payloads: Record<string, unknown> = {
    'board.json': board,
    'status.json': status,
    'changes.json': changesFeed,
    'timeline.json': buildTimeline(db, generatedAt),
  };

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
