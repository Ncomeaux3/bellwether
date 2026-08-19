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
  // Below threshold, deliberately. Usage rates have no stable identity: the
  // model composes the list freshly from each capture, so two observations of
  // the SAME page enumerate them differently and every wording difference
  // becomes an add/remove pair. Measured on the M3 backfill: 607 of 642
  // confirmed material changes (94.5%) were this churn, against 19 price
  // changes. Spec 12.3 solved exactly this problem for tiers — exact ->
  // normalized -> positional matching, so a rename is not remove+add — and
  // usage rates never got the equivalent. Until they do, these stay recorded
  // and unpublished. Restore to 45 once identity matching exists.
  usage_rate_changed: 30,
  usage_rate_added: 30,
  usage_rate_removed: 30,
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

  // "unknown" is the model declining to classify, not a fact about the page,
  // so a transition to or from it is an extraction wobble rather than a
  // billing change. Same principle as a null price below. Measured on the M3
  // backfill: 6 of the 20 surviving confirmed changes were this flip-flop, on
  // pages whose billing terms never moved.
  if (change.change_type === 'billing_unit_changed') {
    const from = parse(change.before_json);
    const to = parse(change.after_json);
    if (from === 'unknown' || to === 'unknown' || from === null || to === null) return 35;
    return base;
  }

  if (change.change_type !== 'price_changed') return base;

  const before = parse(change.before_json);
  const after = parse(change.after_json);

  // A price appearing or disappearing is usually the page rewording, not a
  // pricing event — an optional annual figure stated one month and omitted the
  // next. On the M3 backfill every such transition was noise. A genuine move
  // to "contact sales" is real and rare, and is indistinguishable from copy
  // churn at this layer, so it lands at 35: recorded, below the threshold of
  // 40, and one tuning step from visible if that proves too blunt.
  if (before === null || after === null) return 35;

  if (typeof before !== 'number' || typeof after !== 'number' || before === 0) return base;

  const magnitude = Math.abs((after - before) / before) * 100;
  return Math.min(100, base + Math.min(20, Math.round(magnitude)));
}
