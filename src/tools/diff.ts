import type { PricingSnapshotData } from '../schema/pricing.js';
import { matchTiers } from './tier_identity.js';

export interface ChangeEvent {
  change_type: string;
  json_path: string;
  before_json: string | null;
  after_json: string | null;
}

const j = (v: unknown): string => JSON.stringify(v ?? null);

/**
 * Spec 9 gate 5: we never produce a text diff. Comparing typed objects is what
 * makes a marketing-copy rewrite invisible and a price move unmissable.
 */
export function diffPricing(
  before: PricingSnapshotData,
  after: PricingSnapshotData,
): ChangeEvent[] {
  const changes: ChangeEvent[] = [];
  const push = (change_type: string, path: string, b: unknown, a: unknown) =>
    changes.push({ change_type, json_path: path, before_json: j(b), after_json: j(a) });

  for (const m of matchTiers(before.tiers, after.tiers)) {
    if (m.before === null && m.after !== null) {
      push('tier_added', `tiers.${m.after.name}`, null, m.after);
      continue;
    }
    if (m.after === null && m.before !== null) {
      push('tier_removed', `tiers.${m.before.name}`, m.before, null);
      continue;
    }
    const b = m.before!, a = m.after!;
    const path = `tiers.${a.name}`;

    if (m.renamed) push('tier_renamed', path, b.name, a.name);

    // null (contact sales) is deliberately distinct from 0 (free).
    if (b.monthly_price_usd !== a.monthly_price_usd) {
      push('price_changed', `${path}.monthly_price_usd`, b.monthly_price_usd, a.monthly_price_usd);
    }
    if (b.annual_price_usd !== a.annual_price_usd) {
      push('price_changed', `${path}.annual_price_usd`, b.annual_price_usd, a.annual_price_usd);
    }
    if (b.billing_unit !== a.billing_unit) {
      push('billing_unit_changed', `${path}.billing_unit`, b.billing_unit, a.billing_unit);
    }
    if (b.included_seats !== a.included_seats) {
      push('seats_changed', `${path}.included_seats`, b.included_seats, a.included_seats);
    }
    if (b.is_free !== a.is_free || b.is_enterprise !== a.is_enterprise) {
      push('flag_changed', `${path}.flags`,
        { is_free: b.is_free, is_enterprise: b.is_enterprise },
        { is_free: a.is_free, is_enterprise: a.is_enterprise });
    }
    if (JSON.stringify(b.headline_features) !== JSON.stringify(a.headline_features)) {
      push('features_changed', `${path}.headline_features`, b.headline_features, a.headline_features);
    }
  }

  const rates = (s: PricingSnapshotData) => new Map(s.usage_rates.map(r => [r.metric, r.unit_price_usd]));
  const rb = rates(before), ra = rates(after);
  for (const [metric, price] of ra) {
    const prior = rb.get(metric);
    if (prior === undefined) push('usage_rate_added', `usage_rates.${metric}`, null, price);
    else if (prior !== price) push('usage_rate_changed', `usage_rates.${metric}`, prior, price);
  }
  for (const [metric, price] of rb) {
    if (!ra.has(metric)) push('usage_rate_removed', `usage_rates.${metric}`, price, null);
  }

  if (before.notes !== after.notes) push('notes_changed', 'notes', before.notes, after.notes);

  return changes;
}
