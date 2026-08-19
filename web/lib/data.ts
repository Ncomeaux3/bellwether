import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Board, Status, Timeline } from './types.js';

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
