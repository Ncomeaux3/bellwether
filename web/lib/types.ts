export type SourceState = 'ok' | 'degraded' | 'failing' | 'pending';

export interface Tier {
  name: string;
  monthly_price_usd: number | null;
  annual_price_usd: number | null;
  billing_unit: 'per_seat' | 'flat' | 'usage' | 'unknown';
  included_seats: number | null;
  is_free: boolean;
  is_enterprise: boolean;
  headline_features: string[];
}

export interface CurrentPricing {
  currency: string;
  tiers: Tier[];
  usage_rates: { metric: string; unit_price_usd: number }[];
  notes: string | null;
  extraction_confidence: 'high' | 'medium' | 'low';
}

export interface BoardSource {
  kind: string;
  url: string;
  state: SourceState;
  last_checked_at: string | null;
  last_ok_at: string | null;
  distinct_states: number;
  degraded_reason: string | null;
  current_pricing: CurrentPricing | null;
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

export interface TimelinePoint {
  observed_at: string;
  price: number;
}

export type TierClass = 'free' | 'entry' | 'mid' | 'enterprise';

export interface TimelineSeries {
  tier: string;
  segments: TimelinePoint[][];
  tier_class: TierClass;
}

export interface TimelineMarker {
  observed_at: string;
  label: string;
}

export interface TimelineCompetitor {
  slug: string;
  name: string;
  first_observed_at: string | null;
  last_observed_at: string | null;
  series: TimelineSeries[];
  markers: TimelineMarker[];
}

export interface Timeline {
  generated_at: string;
  observation_count: number;
  competitors: TimelineCompetitor[];
}

export interface DigestBody {
  period_start: string;
  period_end: string;
  body_markdown: string;
  item_count: number;
  created_at: string;
}

export interface Digest {
  generated_at: string;
  digest: DigestBody | null;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface ChangeAnnotation {
  implication: string;
  so_what: string;
  confidence: Confidence;
}

export interface ChangeEntry {
  competitor: string;
  slug: string;
  change_type: string;
  json_path: string;
  before: unknown;
  after: unknown;
  materiality: number;
  observed_at: string;
  annotation: ChangeAnnotation | null;
}

export interface ChangesFeed {
  generated_at: string;
  threshold: number;
  changes: ChangeEntry[];
}

export interface ProvenanceMix {
  live: number;
  wayback: number;
  mixed: number;
}

export interface FilterGate {
  name: string;
  eliminated: number;
  remaining: number;
  note: string;
}

export interface FilterFunnel {
  total_snapshots: number;
  byte_identical_repeats: number;
  distinct_normalized_states: number;
  extractions_performed: number;
  llm_calls_avoided: number;
  llm_calls_avoided_pct?: number;
  gates: FilterGate[];
}

export interface MechanicsCoverage {
  first_observed_at: string | null;
  last_observed_at: string | null;
  months_covered: number;
  live_snapshots: number;
  backfilled_snapshots: number;
}

export interface MechanicsSourceHealth {
  slug: string;
  kind: string;
  url: string;
  state: SourceState;
  last_ok_at: string | null;
  degraded_reason: string | null;
}

export interface MechanicsRunHealth {
  kind: string;
  state: string;
  ended_at: string | null;
}

export interface MechanicsHealth {
  sources: MechanicsSourceHealth[];
  runs: MechanicsRunHealth[];
}

export interface MechanicsCost {
  cumulative_micros: number;
  month_micros: number;
  backfill_micros: number;
  per_confirmed_change_micros?: number;
}

/** Shape of public/data/mechanics.json — see src/workflow/mechanics.ts. */
export interface Mechanics {
  generated_at: string;
  filter: FilterFunnel;
  coverage: MechanicsCoverage;
  health: MechanicsHealth;
  cost: MechanicsCost;
}

/** Shape of public/data/competitors/<slug>.json — see src/workflow/export.ts. */
export interface CompetitorPayload {
  generated_at: string;
  slug: string;
  name: string;
  homepage: string;
  source_url: string | null;
  current_tiers: Tier[];
  first_observed_at: string | null;
  last_observed_at: string | null;
  series: TimelineSeries[];
  markers: TimelineMarker[];
  changes: ChangeEntry[];
  provenance: ProvenanceMix;
}
