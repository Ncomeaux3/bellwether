import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DB } from '../ops/db.js';
import { MATERIALITY_THRESHOLD } from '../tools/materiality.js';
import { EXTRACT_PROMPT_VERSION } from '../schema/pricing.js';
import { SYNTH_PROMPT_VERSION } from '../schema/synthesis.js';
import { monthlySpendMicros } from '../agents/_client.js';
import { observationsFor } from './detect.js';
import { describeChange, buildDatasetRows, toCsv, buildRssXml, buildLlmsTxt, type FeedChange } from './dataset.js';

const run = promisify(execFile);

// TODO: move to config once a custom domain lands.
const SITE_URL = 'https://bellwether-nicholas-projects-cdfeb046.vercel.app';

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

export interface ExportDeps { now?: () => Date; siteDir?: string }

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
export type TierClass = 'free' | 'entry' | 'mid' | 'enterprise';
export interface TimelineSeries { tier: string; segments: TimelinePoint[][]; tier_class: TierClass }
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

    const plotted = [...building.entries()]
      .map(([tier, entry]) => ({ tier, segments: entry.segments }))
      .filter(s => s.segments.length > 0);
    const tierClasses = classifyTiers(plotted);

    const series: TimelineSeries[] = plotted
      .map(s => ({ ...s, tier_class: tierClasses.get(s.tier)! }))
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
 * Spec 14.3: color encodes tier rung, never competitor or tier name, so the
 * classification happens once here rather than in the component. Ranked on
 * each series' *latest* plotted price — the last point of its last segment —
 * because a tier's rung can only be judged against what it costs now.
 */
function classifyTiers(series: { tier: string; segments: TimelinePoint[][] }[]): Map<string, TierClass> {
  const classes = new Map<string, TierClass>();
  const priced: { tier: string; price: number }[] = [];

  for (const s of series) {
    const last = s.segments[s.segments.length - 1]?.at(-1);
    if (last === undefined) continue;
    if (last.price === 0) classes.set(s.tier, 'free');
    else priced.push({ tier: s.tier, price: last.price });
  }

  priced.sort((a, b) => a.price - b.price);
  priced.forEach((p, i) => {
    const cls: TierClass = i === 0 ? 'entry' : i === priced.length - 1 ? 'enterprise' : 'mid';
    classes.set(p.tier, cls);
  });

  return classes;
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
  const siteDir = deps.siteDir ?? join(outDir, '..');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(siteDir, { recursive: true });

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
           ch.materiality, ch.observed_at, c.name AS competitor, c.slug,
           a.implication, a.so_what, a.confidence
    FROM changes ch
    JOIN sources s ON s.id = ch.source_id
    JOIN competitors c ON c.id = s.competitor_id
    LEFT JOIN analyses a ON a.change_id = ch.id AND a.prompt_version = @promptVersion
    WHERE ch.state = 'confirmed' AND ch.materiality >= @threshold
    ORDER BY ch.observed_at DESC, ch.id DESC
    LIMIT 200
  `).all({ threshold: MATERIALITY_THRESHOLD, promptVersion: SYNTH_PROMPT_VERSION }) as Record<string, unknown>[];

  // Shared by changes.json and the RSS feed (spec: build both from one query result).
  const changeEntries = confirmed.map(c => ({
    competitor: c.competitor,
    slug: c.slug,
    change_type: c.change_type,
    json_path: c.json_path,
    before: c.before_json === null ? null : JSON.parse(String(c.before_json)),
    after: c.after_json === null ? null : JSON.parse(String(c.after_json)),
    materiality: c.materiality,
    observed_at: c.observed_at,
    annotation: c.implication === null ? null : {
      implication: c.implication, so_what: c.so_what, confidence: c.confidence,
    },
  }));

  const changesFeed = {
    generated_at: generatedAt,
    threshold: MATERIALITY_THRESHOLD,
    changes: changeEntries,
  };

  const latestDigest = db.prepare(`
    SELECT period_start, period_end, body_md, item_count, created_at
    FROM digests
    ORDER BY created_at DESC
    LIMIT 1
  `).get() as { period_start: string; period_end: string; body_md: string; item_count: number; created_at: string } | undefined;

  const digestPayload = {
    generated_at: generatedAt,
    digest: latestDigest === undefined ? null : {
      period_start: latestDigest.period_start,
      period_end: latestDigest.period_end,
      body_markdown: latestDigest.body_md,
      item_count: latestDigest.item_count,
      created_at: latestDigest.created_at,
    },
  };

  const datasetRows = buildDatasetRows(db);
  const datasetPayload = {
    generated_at: generatedAt,
    license: 'CC BY 4.0',
    schema_version: 1,
    rows: datasetRows,
  };
  const csvContent = toCsv(datasetRows);
  const csvHeaderLine = toCsv([]).split('\n')[0]!;

  const rssContent = buildRssXml(changeEntries as FeedChange[], generatedAt, SITE_URL);
  const llmsContent = buildLlmsTxt(SITE_URL, competitors.map(c => ({ name: c.name, slug: c.slug })));

  interface Artifact { name: string; dir: string; content: string; verify: (raw: string) => void }
  const jsonArtifact = (dir: string, name: string, payload: unknown): Artifact => ({
    name, dir,
    content: JSON.stringify(payload, null, 2),
    verify: raw => { JSON.parse(raw); },
  });

  const artifacts: Artifact[] = [
    jsonArtifact(outDir, 'board.json', board),
    jsonArtifact(outDir, 'status.json', status),
    jsonArtifact(outDir, 'changes.json', changesFeed),
    jsonArtifact(outDir, 'timeline.json', buildTimeline(db, generatedAt)),
    jsonArtifact(outDir, 'digest.json', digestPayload),
    jsonArtifact(outDir, 'dataset.json', datasetPayload),
    {
      name: 'dataset.csv', dir: outDir, content: csvContent,
      verify: raw => {
        if (raw.length === 0 || !raw.startsWith(csvHeaderLine)) {
          throw new ExportGuardError('Refusing to publish: dataset.csv failed verification (missing header).');
        }
      },
    },
    {
      name: 'changes.xml', dir: siteDir, content: rssContent,
      verify: raw => {
        const opens = (raw.match(/<item>/g) ?? []).length;
        const closes = (raw.match(/<\/item>/g) ?? []).length;
        if (!raw.includes('<rss') || opens !== closes) {
          throw new ExportGuardError('Refusing to publish: changes.xml failed verification.');
        }
      },
    },
    {
      name: 'llms.txt', dir: siteDir, content: llmsContent,
      verify: raw => {
        if (!raw.includes('/data/dataset.json')) {
          throw new ExportGuardError('Refusing to publish: llms.txt failed verification.');
        }
      },
    },
  ];

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
    for (const artifact of artifacts) {
      const { name, dir, content } = artifact;
      const finalPath = join(dir, name);

      if (existsSync(finalPath)) {
        const previousSize = readFileSync(finalPath, 'utf8').length;
        if (previousSize > 0 && content.length < previousSize * 0.5) {
          throw new ExportGuardError(
            `Refusing to publish: ${name} shrank from ${previousSize} to ${content.length} bytes. ` +
            `A file losing more than half its content usually means a query broke.`
          );
        }
      }

      const tmpPath = `${finalPath}.tmp`;
      writeFileSync(tmpPath, content);
      artifact.verify(readFileSync(tmpPath, 'utf8'));
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
    files: artifacts.map(a => a.name),
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
