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
