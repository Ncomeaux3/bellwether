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

/** Empty array means grounded. Each entry names one fabricated value. */
export function groundingViolations(data: PricingSnapshotData, sourceText: string): string[] {
  const violations: string[] = [];
  const check = (value: number | null, where: string) => {
    if (value === null) return;                    // "contact sales": nothing to ground
    if (!appearsIn(value, sourceText)) {
      violations.push(`${where} = ${value} does not appear in the page text`);
    }
  };

  for (const t of data.tiers) {
    check(t.monthly_price_usd, `tiers.${t.name}.monthly_price_usd`);
    check(t.annual_price_usd, `tiers.${t.name}.annual_price_usd`);
  }
  for (const r of data.usage_rates) {
    check(r.unit_price_usd, `usage_rates.${r.metric}.unit_price_usd`);
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
