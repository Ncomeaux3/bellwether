import type { PricingSnapshotData } from '../schema/pricing.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Spec 12.6. `extraction_confidence` is self-reported, and a model confident
 * enough to hallucinate a price is confident enough to report "high". This is
 * the deterministic check that actually holds: a price the model produced but
 * the page never contained is fabricated by construction.
 *
 * Matching is anchored on both sides to a digit-or-decimal-point boundary, so
 * a fabricated "20" cannot hide inside "2026" or inside "20.50" (a different
 * price). A plain substring test would accept both.
 */
function appearsIn(value: number, text: string): boolean {
  const digitsOnly = text.replace(/,/g, '');       // "$1,200" -> "$1200"
  const forms = new Set<string>([
    String(value),
    value.toFixed(2).replace(/\.?0+$/, ''),        // 20.00 -> "20"
    value.toFixed(2),                              // 0.09 -> "0.09"
  ]);
  return [...forms].some(f => {
    const boundary = new RegExp(`(?<![\\d.])${escapeRegExp(f)}(?![\\d.])`);
    return boundary.test(digitsOnly);
  });
}

// "Free" is itself an assertion that the price is zero — "freelance"/
// "freedom" don't count. Only ever consulted for value === 0 on a tier
// already marked is_free, so a fabricated zero would still need two
// independent lies (a false price AND a false is_free) to slip through —
// see consistencyViolations below for the other half of that gate.
//
// A plain \bfree\b is not enough: normalizeAndSlice's `.text` concatenates
// sibling block elements with no separating whitespace, so "<h4>Free</h4>
// <p>Free limited...</p>" under a "Starter" heading normalizes to
// "StarterFreeFree limited...", with no ordinary word boundary before or
// after either "Free". A lowercase-letter-into-uppercase-letter transition
// is itself a boundary in that squished text (the same signal a reader uses
// to split a run-together label), so it counts alongside the ordinary
// non-letter boundary. "Freelance"/"Freedom" still fail: nothing after
// "Free" transitions case, so neither branch fires.
const BOUNDARY_BEFORE = String.raw`(?:(?<![a-zA-Z])|(?<=[a-z])(?=[A-Z]))`;
const BOUNDARY_AFTER = String.raw`(?:(?![a-zA-Z])|(?<=[a-z])(?=[A-Z]))`;
const FREE_WORD = new RegExp(`${BOUNDARY_BEFORE}[fF][rR][eE][eE]${BOUNDARY_AFTER}`);

/** Empty array means grounded. Each entry names one fabricated value. */
export function groundingViolations(data: PricingSnapshotData, sourceText: string): string[] {
  const violations: string[] = [];
  const check = (value: number | null, where: string, freeTier: boolean) => {
    if (value === null) return;                    // "contact sales": nothing to ground
    if (value === 0 && freeTier && FREE_WORD.test(sourceText)) return;
    if (!appearsIn(value, sourceText)) {
      violations.push(`${where} = ${value} does not appear in the page text`);
    }
  };

  for (const t of data.tiers) {
    check(t.monthly_price_usd, `tiers.${t.name}.monthly_price_usd`, t.is_free);
    check(t.annual_price_usd, `tiers.${t.name}.annual_price_usd`, t.is_free);
  }
  for (const r of data.usage_rates) {
    check(r.unit_price_usd, `usage_rates.${r.metric}.unit_price_usd`, false);
  }
  return violations;
}

/**
 * Spec: the schema comment on `monthly_price_usd` is explicit that null means
 * "contact sales" — NOT free, and NOT zero. A model can satisfy Zod and
 * grounding while still asserting `is_free: true` alongside a null or nonzero
 * price, which is a self-contradiction no text-presence check catches.
 * Empty array means consistent.
 */
export function consistencyViolations(data: PricingSnapshotData): string[] {
  const violations: string[] = [];
  for (const t of data.tiers) {
    if (t.is_free && t.monthly_price_usd !== 0) {
      violations.push(
        `tiers.${t.name}.is_free = true but monthly_price_usd = ${t.monthly_price_usd} (free tiers must price at 0)`
      );
    }
  }
  return violations;
}
