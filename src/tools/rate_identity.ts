import type { PricingSnapshotData } from '../schema/pricing.js';

type Rate = PricingSnapshotData['usage_rates'][number];

export interface RateMatch {
  before: Rate | null;
  after: Rate | null;
}

/**
 * The usage-rate counterpart of spec 12.3's tier matching. Without it the
 * model's re-wording of the same metric between captures reads as a
 * remove+add pair: measured on the first backfill, 607 of 642 confirmed
 * material changes were exactly that. Real drift observed in the archive:
 *   "AI credits overage (Enterprise tier)" / "(Enterprise)" / "overages (Enterprise)"
 *   "Additional Mocks (per 1000 calls)" / "Additional Mocks per 1000 calls"
 *   "Advanced MFA - Phone (Pro Plan)" / "(Pro)" / "- Pro plan"
 * Lowercase, strip punctuation, drop filler words, crude-singularize.
 */
const FILLER = new Set(['plan', 'tier', 'the', 'a', 'an', 'billed', 'monthly', 'annually']);

export function normalizeMetric(metric: string): string {
  return metric
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w.length > 0 && !FILLER.has(w))
    .map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .join(' ');
}

/**
 * Stage 1: exact metric. Stage 2: normalized metric. Rest is genuinely
 * added/removed. A normalized key that appears more than once on either side
 * is ambiguous, so those rates only ever match exactly — merging "(first
 * project)" with "(additional projects)" because a filler list got greedy
 * would be worse than the churn this exists to stop.
 */
export function matchRates(before: Rate[], after: Rate[]): RateMatch[] {
  const matches: RateMatch[] = [];
  const unmatchedBefore = new Set(before.keys());
  const unmatchedAfter = new Set(after.keys());

  // Stage 1: exact.
  for (const i of [...unmatchedBefore]) {
    for (const j of [...unmatchedAfter]) {
      if (before[i]!.metric === after[j]!.metric) {
        matches.push({ before: before[i]!, after: after[j]! });
        unmatchedBefore.delete(i);
        unmatchedAfter.delete(j);
        break;
      }
    }
  }

  // Stage 2: normalized, but only when unambiguous on both sides.
  const countByKey = (rates: Rate[], indices: Set<number>) => {
    const counts = new Map<string, number>();
    for (const i of indices) {
      const key = normalizeMetric(rates[i]!.metric);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const beforeCounts = countByKey(before, unmatchedBefore);
  const afterCounts = countByKey(after, unmatchedAfter);

  for (const i of [...unmatchedBefore]) {
    const key = normalizeMetric(before[i]!.metric);
    if (beforeCounts.get(key) !== 1 || afterCounts.get(key) !== 1) continue;
    for (const j of [...unmatchedAfter]) {
      if (normalizeMetric(after[j]!.metric) === key) {
        matches.push({ before: before[i]!, after: after[j]! });
        unmatchedBefore.delete(i);
        unmatchedAfter.delete(j);
        break;
      }
    }
  }

  for (const i of unmatchedBefore) matches.push({ before: before[i]!, after: null });
  for (const j of unmatchedAfter) matches.push({ before: null, after: after[j]! });
  return matches;
}
