import type { TierData } from '../schema/pricing.js';

export interface TierMatch {
  before: TierData | null;
  after: TierData | null;
  /** True only for stage-3 positional matches — a rename, not a pricing event. */
  renamed: boolean;
}

/** Case-folded, punctuation stripped, common suffixes removed. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(plan|tier)\b/g, '').trim();
}

/** Within 15%, or both null ("contact sales" on both sides). */
function priceIsClose(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a === 0 && b === 0) return true;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 ? true : Math.abs(a - b) / base <= 0.15;
}

/**
 * Spec 12.3. Naive name-keyed matching turns a rename into tier_removed +
 * tier_added — materiality 200, two spurious entries, and a severed price
 * series exactly where the timeline needs continuity most.
 */
export function matchTiers(before: TierData[], after: TierData[]): TierMatch[] {
  const matches: TierMatch[] = [];
  const unmatchedBefore = new Set(before.keys());
  const unmatchedAfter = new Set(after.keys());

  const pair = (i: number, j: number, renamed: boolean) => {
    matches.push({ before: before[i]!, after: after[j]!, renamed });
    unmatchedBefore.delete(i);
    unmatchedAfter.delete(j);
  };

  // Stage 1: exact name.
  for (const i of [...unmatchedBefore]) {
    for (const j of [...unmatchedAfter]) {
      if (before[i]!.name === after[j]!.name) { pair(i, j, false); break; }
    }
  }

  // Stage 2: normalized name.
  for (const i of [...unmatchedBefore]) {
    for (const j of [...unmatchedAfter]) {
      if (normalizeName(before[i]!.name) === normalizeName(after[j]!.name)) { pair(i, j, false); break; }
    }
  }

  // Stage 3: same ordinal position AND price within 15% -> a rename.
  for (const i of [...unmatchedBefore]) {
    if (!unmatchedAfter.has(i)) continue;
    if (priceIsClose(before[i]!.monthly_price_usd, after[i]!.monthly_price_usd)) pair(i, i, true);
  }

  // Stage 4: whatever is left is genuinely added or removed.
  for (const i of unmatchedBefore) matches.push({ before: before[i]!, after: null, renamed: false });
  for (const j of unmatchedAfter) matches.push({ before: null, after: after[j]!, renamed: false });

  return matches;
}
