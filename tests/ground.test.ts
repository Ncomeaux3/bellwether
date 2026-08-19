import { describe, expect, it } from 'vitest';
import { groundingViolations } from '../src/tools/ground.js';
import type { PricingSnapshotData } from '../src/schema/pricing.js';

function snap(over: Partial<PricingSnapshotData> = {}): PricingSnapshotData {
  return {
    currency: 'USD', tiers: [], usage_rates: [], notes: null,
    extraction_confidence: 'high', ...over,
  };
}
const tier = (price: number | null, annual: number | null = null) => ({
  name: 'Pro', monthly_price_usd: price, annual_price_usd: annual,
  billing_unit: 'per_seat' as const, included_seats: null,
  is_free: false, is_enterprise: false, headline_features: [],
});

describe('groundingViolations', () => {
  it('passes when every price appears in the source', () => {
    expect(groundingViolations(snap({ tiers: [tier(20, 200)] }), 'Pro $20/mo or $200/yr')).toEqual([]);
  });

  it('catches a fabricated price', () => {
    const v = groundingViolations(snap({ tiers: [tier(99)] }), 'Pro $20/mo');
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('99');
  });

  it('catches a fabricated usage rate', () => {
    const v = groundingViolations(
      snap({ usage_rates: [{ metric: 'egress_gb', unit_price_usd: 0.42 }] }),
      'egress billed at $0.09 per GB',
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('0.42');
  });

  it('accepts a decimal written without its trailing zero', () => {
    expect(groundingViolations(snap({ tiers: [tier(20.0)] }), 'Pro $20/mo')).toEqual([]);
  });

  it('accepts a price written with a thousands separator', () => {
    expect(groundingViolations(snap({ tiers: [tier(1200)] }), 'Enterprise from $1,200/mo')).toEqual([]);
  });

  it('ignores null prices — "contact sales" has no numeral to ground', () => {
    expect(groundingViolations(snap({ tiers: [tier(null, null)] }), 'Contact sales')).toEqual([]);
  });

  it('accepts zero when the page says free', () => {
    expect(groundingViolations(snap({ tiers: [tier(0)] }), 'Free $0/mo')).toEqual([]);
  });

  it('reports every violation, not just the first', () => {
    const v = groundingViolations(
      snap({ tiers: [tier(99), { ...tier(77), name: 'Team' }] }),
      'Pro $20/mo, Team $50/mo',
    );
    expect(v).toHaveLength(2);
  });
});
