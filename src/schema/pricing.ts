import { z } from 'zod';

/**
 * Stored on every row this prompt produces, so any extraction traces to the
 * exact prompt behind it and can be reprocessed independently (spec 7.1).
 * Bump this to re-extract all history under a better prompt.
 */
export const EXTRACT_PROMPT_VERSION = 'extract-pricing-v1';

export const Tier = z.object({
  name: z.string(),
  /** null means "contact sales" — NOT free, and NOT zero. */
  monthly_price_usd: z.number().nullable(),
  annual_price_usd: z.number().nullable(),
  billing_unit: z.enum(['per_seat', 'flat', 'usage', 'unknown']),
  included_seats: z.number().nullable(),
  is_free: z.boolean(),
  is_enterprise: z.boolean(),
  headline_features: z.array(z.string()).max(8),
});

export const PricingSnapshot = z.object({
  currency: z.string(),
  tiers: z.array(Tier),
  /** Supabase and Sentry price on consumption; without this they extract to almost nothing. */
  usage_rates: z.array(z.object({
    metric: z.string(),
    unit_price_usd: z.number(),
  })).max(12),
  notes: z.string().nullable(),
  /** Self-reported. A useful signal, never a validator — see ground.ts. */
  extraction_confidence: z.enum(['high', 'medium', 'low']),
});

export type TierData = z.infer<typeof Tier>;
export type PricingSnapshotData = z.infer<typeof PricingSnapshot>;
