import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Board, ChangeEntry, ChangesFeed, Digest, Status, Timeline } from './types.js';

const DATA_DIR = join(process.cwd(), 'public', 'data');

function read<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T;
  } catch {
    // A missing file means the pipeline has not exported yet. The page renders
    // its empty state rather than failing the build (spec 14.3 copy rules).
    return fallback;
  }
}

export function loadBoard(): Board {
  return read<Board>('board.json', { generated_at: '', competitors: [] });
}

export function loadStatus(): Status {
  return read<Status>('status.json', {
    generated_at: '', total_sources: 0, healthy_sources: 0,
    sources: [], last_run: null, cost_micros_month: 0,
  });
}

export function loadTimeline(): Timeline {
  return read<Timeline>('timeline.json', {
    generated_at: '', observation_count: 0, competitors: [],
  });
}

export function loadDigest(): Digest {
  return read<Digest>('digest.json', { generated_at: '', digest: null });
}

export function loadChanges(): ChangesFeed {
  return read<ChangesFeed>('changes.json', { generated_at: '', threshold: 0, changes: [] });
}

export interface DatasetMeta {
  generatedAt: string;
  rowCount: number;
}

/**
 * Reads the full dataset.json at build time (this only ever runs on the
 * server, during static export) but returns just the count — the row array
 * itself never reaches the page bundle.
 */
export function loadDatasetMeta(): DatasetMeta {
  const data = read<{ generated_at: string; rows: unknown[] }>('dataset.json', {
    generated_at: '', rows: [],
  });
  return { generatedAt: data.generated_at, rowCount: data.rows.length };
}

const fmt = (v: unknown): string => (v === null || v === undefined ? 'none' : String(v));

/**
 * Same grammar as the exporter's describeChange (src/workflow/dataset.ts),
 * ported rather than imported — that module pulls in better-sqlite3, which
 * has no place in a static page bundle. Operates on changes.json's
 * already-parsed before/after rather than raw JSON strings.
 */
export function changeLabel(c: Pick<ChangeEntry, 'json_path' | 'change_type' | 'before' | 'after'>): string {
  const parts = c.json_path.split('.');
  const field = parts[parts.length - 1] ?? '';
  const tier = c.json_path.startsWith('tiers.')
    ? (parts.slice(1, -1).join('.') || parts.slice(1).join('.'))
    : c.json_path;

  if (c.change_type === 'price_changed') {
    const label = field === 'monthly_price_usd' ? '' : `${field.replace(/_usd$/, '').replace(/_/g, ' ')} `;
    return `${tier} ${label}${fmt(c.before)} to ${fmt(c.after)}`;
  }
  return `${tier} ${c.change_type.replace(/_/g, ' ')}`;
}

/**
 * Same rule as the exporter's stepPoints (src/workflow/dataset.ts), ported
 * rather than imported — web/ cannot import from src/. Spec 14.3: "Step-after
 * interpolation, never smooth lines. Prices are piecewise constant. A line
 * sloping from $16 to $18 between two monthly observations asserts a
 * continuous change that did not happen. This is a correctness rule, not a
 * stylistic one, and it is the most common way a pricing chart lies."
 * Inserting a point at the next date holding the CURRENT price makes the
 * segment horizontal-then-vertical instead of diagonal.
 *
 * Pinned to describeChange's sibling by the cross-check test in the root
 * suite (tests/dataset.test.ts) — nothing else guards against the two
 * copies drifting apart.
 */
export function stepPoints(
  points: { observed_at: string; price: number }[],
): { observed_at: string; price: number }[] {
  if (points.length < 2) return [...points];

  const out: { observed_at: string; price: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const current = points[i]!;
    const next = points[i + 1]!;
    out.push(current, { observed_at: next.observed_at, price: current.price });
  }
  out.push(points[points.length - 1]!);
  return out;
}
