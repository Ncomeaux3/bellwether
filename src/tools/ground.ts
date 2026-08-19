import type { PricingSnapshotData } from '../schema/pricing.js';

/**
 * Spec 12.6. `extraction_confidence` is self-reported, and a model confident
 * enough to hallucinate a price is confident enough to report "high". This is
 * the deterministic check that actually holds: a price the model produced but
 * the page never contained is fabricated by construction.
 */
function appearsIn(value: number, text: string): boolean {
  const digitsOnly = text.replace(/,/g, '');       // "$1,200" -> "$1200"
  const forms = new Set<string>([
    String(value),
    value.toFixed(2).replace(/\.?0+$/, ''),        // 20.00 -> "20"
    value.toFixed(2),                              // 0.09 -> "0.09"
  ]);
  return [...forms].some(f => digitsOnly.includes(f));
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
