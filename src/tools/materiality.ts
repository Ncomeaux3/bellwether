import type { ChangeEvent } from './diff.js';

/**
 * Spec 10. Anything scoring below this is recorded but never reaches an LLM
 * and never appears in the digest.
 */
export const MATERIALITY_THRESHOLD = 40;

const BASE: Record<string, number> = {
  tier_added: 100,
  tier_removed: 100,
  price_changed: 80,           // plus magnitude, see below
  billing_unit_changed: 70,
  flag_changed: 60,
  seats_changed: 50,
  usage_rate_changed: 45,
  usage_rate_added: 45,
  usage_rate_removed: 45,
  tier_renamed: 35,            // below threshold: a rename is not a pricing event
  features_changed: 10,        // copy churn the large majority of the time
  notes_changed: 5,
};

function parse(json: string | null): unknown {
  if (json === null) return null;
  try { return JSON.parse(json); } catch { return null; }
}

/** A pure function. No LLM, no I/O, no judgement. */
export function scoreMateriality(change: ChangeEvent): number {
  const base = BASE[change.change_type] ?? 0;
  if (change.change_type !== 'price_changed') return base;

  const before = parse(change.before_json);
  const after = parse(change.after_json);
  if (typeof before !== 'number' || typeof after !== 'number' || before === 0) return base;

  const magnitude = Math.abs((after - before) / before) * 100;
  return Math.min(100, base + Math.min(20, Math.round(magnitude)));
}
