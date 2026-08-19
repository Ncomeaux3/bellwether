import { describe, expect, it } from 'vitest';
import { matchTiers } from '../src/tools/tier_identity.js';
import { diffPricing } from '../src/tools/diff.js';
import { MATERIALITY_THRESHOLD, scoreMateriality } from '../src/tools/materiality.js';
import type { PricingSnapshotData, TierData } from '../src/schema/pricing.js';

function tier(over: Partial<TierData> = {}): TierData {
  return {
    name: 'Pro', monthly_price_usd: 20, annual_price_usd: 200,
    billing_unit: 'per_seat', included_seats: 1,
    is_free: false, is_enterprise: false, headline_features: [], ...over,
  };
}

function snap(tiers: TierData[], over: Partial<PricingSnapshotData> = {}): PricingSnapshotData {
  return {
    currency: 'USD', tiers, usage_rates: [], notes: null,
    extraction_confidence: 'high', ...over,
  };
}

const find = (cs: ReturnType<typeof diffPricing>, type: string) => cs.filter(c => c.change_type === type);

describe('matchTiers', () => {
  it('matches on exact name', () => {
    const m = matchTiers([tier({ name: 'Pro' })], [tier({ name: 'Pro', monthly_price_usd: 24 })]);
    expect(m).toHaveLength(1);
    expect(m[0]!.renamed).toBe(false);
    expect(m[0]!.after!.monthly_price_usd).toBe(24);
  });

  it('matches on normalized name — case, punctuation, "Plan" suffix', () => {
    const m = matchTiers([tier({ name: 'Pro Plan' })], [tier({ name: 'pro' })]);
    expect(m).toHaveLength(1);
    expect(m[0]!.before).not.toBeNull();
    expect(m[0]!.after).not.toBeNull();
  });

  it('matches a rename by position and price proximity', () => {
    const m = matchTiers(
      [tier({ name: 'Free', monthly_price_usd: 0, is_free: true }), tier({ name: 'Pro', monthly_price_usd: 20 })],
      [tier({ name: 'Free', monthly_price_usd: 0, is_free: true }), tier({ name: 'Professional', monthly_price_usd: 21 })],
    );
    const renamed = m.filter(x => x.renamed);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]!.before!.name).toBe('Pro');
    expect(renamed[0]!.after!.name).toBe('Professional');
  });

  it('does not call a >15% price move a rename', () => {
    const m = matchTiers([tier({ name: 'Pro', monthly_price_usd: 20 })], [tier({ name: 'Scale', monthly_price_usd: 90 })]);
    expect(m.some(x => x.renamed)).toBe(false);
    expect(m.filter(x => x.after === null)).toHaveLength(1);
    expect(m.filter(x => x.before === null)).toHaveLength(1);
  });

  it('reports a genuinely new tier as added', () => {
    const m = matchTiers([tier({ name: 'Pro' })], [tier({ name: 'Pro' }), tier({ name: 'Team', monthly_price_usd: 50 })]);
    expect(m.filter(x => x.before === null)).toHaveLength(1);
  });
});

describe('diffPricing', () => {
  it('finds no changes between identical snapshots', () => {
    expect(diffPricing(snap([tier()]), snap([tier()]))).toEqual([]);
  });

  it('detects a monthly price change', () => {
    const cs = diffPricing(snap([tier()]), snap([tier({ monthly_price_usd: 24 })]));
    const c = find(cs, 'price_changed')[0]!;
    expect(c.json_path).toBe('tiers.Pro.monthly_price_usd');
    expect(JSON.parse(c.before_json!)).toBe(20);
    expect(JSON.parse(c.after_json!)).toBe(24);
  });

  it('detects tier added and removed', () => {
    // price deliberately far apart (>15%) so stage 3 of matchTiers does not
    // treat this as a rename — see task-2-report.md for why the brief's
    // original same-priced fixture collided with its own rename heuristic.
    const cs = diffPricing(snap([tier({ name: 'Pro' })]), snap([tier({ name: 'Team', monthly_price_usd: 200 })]));
    expect(find(cs, 'tier_added')).toHaveLength(1);
    expect(find(cs, 'tier_removed')).toHaveLength(1);
  });

  it('emits tier_renamed instead of add+remove, preserving continuity', () => {
    const cs = diffPricing(
      snap([tier({ name: 'Pro', monthly_price_usd: 20 })]),
      snap([tier({ name: 'Professional', monthly_price_usd: 20 })]),
    );
    expect(find(cs, 'tier_renamed')).toHaveLength(1);
    expect(find(cs, 'tier_added')).toHaveLength(0);
    expect(find(cs, 'tier_removed')).toHaveLength(0);
  });

  it('detects billing_unit, seats, and flag flips', () => {
    const cs = diffPricing(
      snap([tier()]),
      snap([tier({ billing_unit: 'flat', included_seats: 5, is_enterprise: true })]),
    );
    expect(find(cs, 'billing_unit_changed')).toHaveLength(1);
    expect(find(cs, 'seats_changed')).toHaveLength(1);
    expect(find(cs, 'flag_changed')).toHaveLength(1);
  });

  it('detects usage rate changes', () => {
    const before = snap([tier()], { usage_rates: [{ metric: 'egress_gb', unit_price_usd: 0.09 }] });
    const after = snap([tier()], { usage_rates: [{ metric: 'egress_gb', unit_price_usd: 0.12 }] });
    expect(find(diffPricing(before, after), 'usage_rate_changed')).toHaveLength(1);
  });

  it('detects feature and notes changes', () => {
    const cs = diffPricing(
      snap([tier({ headline_features: ['a'] })], { notes: null }),
      snap([tier({ headline_features: ['a', 'b'] })], { notes: 'now with SSO' }),
    );
    expect(find(cs, 'features_changed')).toHaveLength(1);
    expect(find(cs, 'notes_changed')).toHaveLength(1);
  });

  it('treats null (contact sales) as distinct from 0 (free)', () => {
    const cs = diffPricing(snap([tier({ monthly_price_usd: null })]), snap([tier({ monthly_price_usd: 0 })]));
    expect(find(cs, 'price_changed')).toHaveLength(1);
  });
});

describe('usage-rate identity matching', () => {
  const rate = (metric: string, price = 5) => ({ metric, unit_price_usd: price });
  const withRates = (rates: { metric: string; unit_price_usd: number }[]) =>
    snap([tier({})], { usage_rates: rates });

  it('does not churn when the model re-words the same metric', () => {
    // Every pair here is real drift observed in the first backfill's archive.
    const pairs: [string, string][] = [
      ['AI credits overage (Enterprise tier)', 'AI credits overage (Enterprise)'],
      ['AI credits overages (Enterprise)', 'AI credits overage (Enterprise)'],
      ['Additional Mocks (per 1000 calls)', 'Additional Mocks per 1000 calls'],
      ['Advanced Multi-Factor Auth - Phone (Pro Plan)', 'Advanced Multi-Factor Auth - Phone - Pro plan'],
    ];
    for (const [a, b] of pairs) {
      const cs = diffPricing(withRates([rate(a)]), withRates([rate(b)]));
      expect(cs.filter(c => c.change_type.startsWith('usage_rate')), `${a} vs ${b}`).toHaveLength(0);
    }
  });

  it('still reports a real price move on a re-worded metric', () => {
    const cs = diffPricing(
      withRates([rate('AI credits overage (Enterprise tier)', 5)]),
      withRates([rate('AI credits overage (Enterprise)', 8)]),
    );
    const changed = cs.filter(c => c.change_type === 'usage_rate_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.before_json).toBe('5');
    expect(changed[0]!.after_json).toBe('8');
  });

  it('refuses to merge when normalization is ambiguous', () => {
    // "(first project)" and "(additional projects)" are genuinely different
    // rates; a greedy filler list must never fold them together.
    const before = [rate('MFA Phone (first project)', 75), rate('MFA Phone (additional projects)', 10)];
    const after = [rate('MFA Phone (first project)', 75), rate('MFA Phone (additional projects)', 10)];
    const cs = diffPricing(withRates(before), withRates(after));
    expect(cs.filter(c => c.change_type.startsWith('usage_rate'))).toHaveLength(0);

    // and when one side drops one of an ambiguous pair, it reads as removed
    const cs2 = diffPricing(withRates(before), withRates([rate('MFA Phone first project additional projects', 75)]));
    expect(cs2.some(c => c.change_type === 'usage_rate_removed')).toBe(true);
  });

  it('reports genuinely new and vanished metrics', () => {
    const cs = diffPricing(
      withRates([rate('Egress per GB', 0.09)]),
      withRates([rate('Compute per hour', 0.01)]),
    );
    expect(cs.map(c => c.change_type).sort()).toEqual(['usage_rate_added', 'usage_rate_removed']);
  });
});

describe('scoreMateriality', () => {
  const ev = (change_type: string, before: unknown = null, after: unknown = null) => ({
    change_type, json_path: 'tiers.Pro.x',
    before_json: JSON.stringify(before), after_json: JSON.stringify(after),
  });

  it('scores structural changes above the threshold', () => {
    expect(scoreMateriality(ev('tier_added'))).toBe(100);
    expect(scoreMateriality(ev('tier_removed'))).toBe(100);
    expect(scoreMateriality(ev('flag_changed'))).toBe(60);
    expect(scoreMateriality(ev('seats_changed'))).toBe(50);
  });

  it('scores a price change by magnitude, capped at 100', () => {
    expect(scoreMateriality(ev('price_changed', 20, 21))).toBe(85);   // 5% -> 80+5
    expect(scoreMateriality(ev('price_changed', 20, 40))).toBe(100);  // 100% -> capped
  });

  it('keeps a price appearing or disappearing below the threshold', () => {
    // Measured on the M3 backfill: every null transition was a page
    // rewording, not a pricing event — an optional annual figure stated one
    // month and omitted the next. Recorded, never published.
    expect(scoreMateriality(ev('price_changed', null, 20))).toBe(35);
    expect(scoreMateriality(ev('price_changed', 20, null))).toBe(35);
    expect(scoreMateriality(ev('price_changed', null, 20))).toBeLessThan(MATERIALITY_THRESHOLD);
  });

  it('keeps a billing unit moving to or from "unknown" below the threshold', () => {
    // "unknown" is the model declining to classify, not a page fact.
    expect(scoreMateriality(ev('billing_unit_changed', 'flat', 'unknown'))).toBe(35);
    expect(scoreMateriality(ev('billing_unit_changed', 'unknown', 'flat'))).toBe(35);
    // A real reclassification still publishes.
    expect(scoreMateriality(ev('billing_unit_changed', 'flat', 'per_seat'))).toBe(70);
  });

  it('keeps usage-rate churn below the threshold', () => {
    // Usage rates have no stable identity (spec 12.3 gave tiers matching and
    // never gave them the equivalent), so the same page enumerates them
    // differently between captures. 607 of 642 confirmed M3 changes were this.
    for (const t of ['usage_rate_changed', 'usage_rate_added', 'usage_rate_removed']) {
      expect(scoreMateriality(ev(t))).toBe(30);
      expect(scoreMateriality(ev(t))).toBeLessThan(MATERIALITY_THRESHOLD);
    }
  });

  it('scores copy churn below the threshold', () => {
    expect(scoreMateriality(ev('features_changed'))).toBe(10);
    expect(scoreMateriality(ev('notes_changed'))).toBe(5);
    expect(scoreMateriality(ev('tier_renamed'))).toBe(35);
    for (const t of ['features_changed', 'notes_changed', 'tier_renamed']) {
      expect(scoreMateriality(ev(t))).toBeLessThan(MATERIALITY_THRESHOLD);
    }
  });

  it('scores an unknown change type at 0 rather than throwing', () => {
    expect(scoreMateriality(ev('something_new'))).toBe(0);
  });
});
