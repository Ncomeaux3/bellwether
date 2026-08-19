import { describe, expect, it } from 'vitest';
import { consistencyViolations, groundingViolations } from '../src/tools/ground.js';
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

  describe('digit-boundary matching', () => {
    it('rejects 20 hiding inside 2026 — a digit follows', () => {
      const v = groundingViolations(snap({ tiers: [tier(20)] }), 'Copyright 2026');
      expect(v).toHaveLength(1);
    });

    it('rejects 20 hiding inside 20.50 — the real price is 20.50, not 20', () => {
      const v = groundingViolations(snap({ tiers: [tier(20)] }), 'Pro $20.50/mo');
      expect(v).toHaveLength(1);
    });

    it('accepts 20 in "$20/mo"', () => {
      expect(groundingViolations(snap({ tiers: [tier(20)] }), '$20/mo')).toEqual([]);
    });

    it('accepts 20 in "Pro $20 per seat"', () => {
      expect(groundingViolations(snap({ tiers: [tier(20)] }), 'Pro $20 per seat')).toEqual([]);
    });

    it('accepts 0.09 in "$0.09 per GB"', () => {
      const v = groundingViolations(
        snap({ usage_rates: [{ metric: 'egress_gb', unit_price_usd: 0.09 }] }),
        '$0.09 per GB',
      );
      expect(v).toEqual([]);
    });

    it('accepts 1200 in "$1,200/mo"', () => {
      expect(groundingViolations(snap({ tiers: [tier(1200)] }), '$1,200/mo')).toEqual([]);
    });

    it('rejects a fabricated 0 when the page has no standalone zero, only 2026 and $120', () => {
      const v = groundingViolations(snap({ tiers: [tier(0)] }), 'Copyright 2026. Was $120/mo.');
      expect(v).toHaveLength(1);
    });
  });

  describe('word-only "Free" tiers, anchored to the tier\'s own name', () => {
    it("grounds Figma's real shape: the tier name glued directly to \"Free\", no separator", () => {
      const v = groundingViolations(
        snap({ tiers: [{ ...tier(0), is_free: true, name: 'Starter' }] }),
        'StarterFree limited access to Figma products',
      );
      expect(v).toEqual([]);
    });

    it('rejects a free-sounding phrase elsewhere on the page not anchored to this tier\'s name', () => {
      const v = groundingViolations(
        snap({ tiers: [{ ...tier(0), is_free: true, name: 'Pro' }] }),
        'HassleFreeSetup included with every plan',
      );
      expect(v).toHaveLength(1);
    });

    it('tolerates an ordinary separator between the tier name and "Free"', () => {
      const v = groundingViolations(
        snap({ tiers: [{ ...tier(0), is_free: true, name: 'Pro' }] }),
        'Pro — Free forever',
      );
      expect(v).toEqual([]);
    });

    it('still rejects a free tier priced at 0 when the page says neither "free" nor "0"', () => {
      const v = groundingViolations(
        snap({ tiers: [{ ...tier(0), is_free: true, name: 'Starter' }] }),
        'Starter\nNo cost to start',
      );
      expect(v).toHaveLength(1);
    });

    it('still rejects when is_free is false, even with the name glued to "Free"', () => {
      const v = groundingViolations(snap({ tiers: [{ ...tier(0), name: 'Starter' }] }), 'StarterFree');
      expect(v).toHaveLength(1);
    });

    it('does not treat "freelance" as a free indicator, even right after the tier name', () => {
      const v = groundingViolations(
        snap({ tiers: [{ ...tier(0), is_free: true, name: 'Pro' }] }),
        'Pro Freelance services',
      );
      expect(v).toHaveLength(1);
    });

    it('does not treat "freedom" as a free indicator', () => {
      const v = groundingViolations(
        snap({ tiers: [{ ...tier(0), is_free: true, name: 'Pro' }] }),
        'Pro Freedom to grow',
      );
      expect(v).toHaveLength(1);
    });

    it('still rejects a fabricated non-zero price on a free tier — the free-indicator only ever applies to 0', () => {
      const v = groundingViolations(
        snap({ tiers: [{ ...tier(99), is_free: true, name: 'Starter' }] }),
        'StarterFree',
      );
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('99');
    });

    it('grounds a tier literally named "Free" on a page that never writes "$0" — the name alone is the assertion', () => {
      const v = groundingViolations(
        snap({ tiers: [{ ...tier(0), is_free: true, name: 'Free' }] }),
        'Free\nGreat for solo projects. No credit card required.',
      );
      expect(v).toEqual([]);
    });

    it('still rejects a "Free"-named tier when only a compound like "HassleFreeSetup" appears, never the standalone word', () => {
      const v = groundingViolations(
        snap({ tiers: [{ ...tier(0), is_free: true, name: 'Free' }] }),
        'HassleFreeSetup included with every plan',
      );
      expect(v).toHaveLength(1);
    });
  });
});

describe('consistencyViolations', () => {
  it('rejects is_free = true paired with a null price', () => {
    const v = consistencyViolations(snap({ tiers: [{ ...tier(null), is_free: true }] }));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('is_free');
  });

  it('rejects is_free = true paired with a nonzero price', () => {
    const v = consistencyViolations(snap({ tiers: [{ ...tier(20), is_free: true }] }));
    expect(v).toHaveLength(1);
  });

  it('accepts is_free = true paired with monthly_price_usd = 0', () => {
    expect(consistencyViolations(snap({ tiers: [{ ...tier(0), is_free: true }] }))).toEqual([]);
  });

  it('accepts is_free = false regardless of price', () => {
    expect(consistencyViolations(snap({ tiers: [tier(null), tier(20)] }))).toEqual([]);
  });

  it('rejects is_free = true paired with a non-zero annual_price_usd', () => {
    const v = consistencyViolations(snap({ tiers: [{ ...tier(0, 120), is_free: true }] }));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('annual_price_usd');
  });

  it('accepts is_free = true paired with annual_price_usd = null (annual simply not stated)', () => {
    expect(consistencyViolations(snap({ tiers: [{ ...tier(0, null), is_free: true }] }))).toEqual([]);
  });
});
