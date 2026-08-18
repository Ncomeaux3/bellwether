export type SourceState = 'ok' | 'degraded' | 'failing' | 'pending';

export interface BoardSource {
  kind: string;
  url: string;
  state: SourceState;
  last_checked_at: string | null;
  last_ok_at: string | null;
  distinct_states: number;
  degraded_reason: string | null;
}

export interface BoardCompetitor {
  slug: string;
  name: string;
  homepage: string;
  sources: BoardSource[];
}

export interface Board {
  generated_at: string;
  competitors: BoardCompetitor[];
}

export interface Status {
  generated_at: string;
  total_sources: number;
  healthy_sources: number;
  sources: { slug: string; kind: string; state: SourceState; last_ok_at: string | null; degraded_reason: string | null }[];
  last_run: { kind: string; started_at: string; ended_at: string | null; state: string } | null;
  cost_micros_month: number;
}
