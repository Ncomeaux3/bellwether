import type { DB } from '../ops/db.js';
import { observationsFor } from './detect.js';

export interface DatasetRow {
  competitor: string;
  tier: string;
  first_observed_at: string;
  last_observed_at: string;
  monthly_price_usd: number | null;
  annual_price_usd: number | null;
  billing_unit: string;
  included_seats: number | null;
  is_free: boolean;
  is_enterprise: boolean;
  currency: 'USD';
  provenance: 'live' | 'wayback' | 'mixed';
}

export interface FeedChange {
  competitor: string;
  slug: string;
  change_type: string;
  json_path: string;
  before: unknown;
  after: unknown;
  observed_at: string;
  annotation: { implication: string; so_what: string } | null;
}

/**
 * SQL NULL and the JSON string "null" are different things here: diff.ts
 * always writes JSON.stringify(v ?? null), so an absent value is the
 * four-character string 'null', never a SQL-NULL column. Both must read as
 * "none" — a contact-sales tier is not the word "null".
 */
export const value = (raw: string | null): string => {
  if (raw === null) return 'none';
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null ? 'none' : String(parsed);
  } catch {
    return 'none';
  }
};

/** Short, literal marker text. No adjectives — the number is the story. */
export function describeChange(row: {
  json_path: string; change_type: string; before_json: string | null; after_json: string | null;
}): string {
  const parts = row.json_path.split('.');
  const field = parts[parts.length - 1] ?? '';
  const tier = row.json_path.startsWith('tiers.')
    ? (parts.slice(1, -1).join('.') || parts.slice(1).join('.'))
    : row.json_path;

  // diff.ts writes 'price_changed' (past tense) at both .monthly_price_usd
  // and .annual_price_usd with identical materiality — the field name must
  // stay in the label or an annual move reads as a monthly one.
  if (row.change_type === 'price_changed') {
    // The chart's axis is already dollars, so "usd" is noise in a marker
    // label: "Pro annual price 96 to 120", not "Pro annual price usd 96 to 120".
    const label = field === 'monthly_price_usd'
      ? ''
      : `${field.replace(/_usd$/, '').replace(/_/g, ' ')} `;
    return `${tier} ${label}${value(row.before_json)} to ${value(row.after_json)}`;
  }
  return `${tier} ${row.change_type.replace(/_/g, ' ')}`;
}

/**
 * Spec 14.5: one row per (competitor, tier, observed_at) collapses to one row
 * per contiguous run of identical tier state (ruling R4) — a price held for a
 * year is one row, not 365. Runs are per tier name: a tier's disappearance
 * from an observation (renamed, retired, page reshuffled) closes its run,
 * so a later reappearance with the same numbers starts a fresh row rather
 * than silently bridging the gap where it was not observed at all.
 *
 * provenance collapses the run's observations (spec 14.5: reconstructed vs
 * observed must stay distinguishable) — 'live' only if every observation in
 * the run was live, 'wayback' only if every one was a capture, else 'mixed'.
 */
export function buildDatasetRows(db: DB): DatasetRow[] {
  const sources = db.prepare(`
    SELECT s.id AS source_id, c.name, c.slug
    FROM sources s JOIN competitors c ON c.id = s.competitor_id
    WHERE s.active = 1 AND c.active = 1 AND s.kind = 'pricing'
    ORDER BY c.name
  `).all() as { source_id: number; name: string; slug: string }[];

  const rows: DatasetRow[] = [];

  for (const source of sources) {
    const observations = observationsFor(db, source.source_id);

    interface Run { row: DatasetRow; key: string; provKinds: Set<'live' | 'wayback'> }
    const building = new Map<string, Run>();

    const finalize = (run: Run): void => {
      run.row.provenance = run.provKinds.size === 1 ? [...run.provKinds][0]! : 'mixed';
      rows.push(run.row);
    };

    for (const observation of observations) {
      const obsProv: 'live' | 'wayback' = observation.provenance.startsWith('wayback:') ? 'wayback' : 'live';
      const seen = new Set<string>();

      for (const tier of observation.data.tiers) {
        seen.add(tier.name);
        const key = JSON.stringify([
          tier.monthly_price_usd, tier.annual_price_usd, tier.billing_unit,
          tier.included_seats, tier.is_free, tier.is_enterprise,
        ]);

        const existing = building.get(tier.name);
        if (existing !== undefined && existing.key === key) {
          existing.row.last_observed_at = observation.observedAt;
          existing.provKinds.add(obsProv);
          continue;
        }

        if (existing !== undefined) finalize(existing);

        building.set(tier.name, {
          key,
          provKinds: new Set([obsProv]),
          row: {
            competitor: source.name,
            tier: tier.name,
            first_observed_at: observation.observedAt,
            last_observed_at: observation.observedAt,
            monthly_price_usd: tier.monthly_price_usd,
            annual_price_usd: tier.annual_price_usd,
            billing_unit: tier.billing_unit,
            included_seats: tier.included_seats,
            is_free: tier.is_free,
            is_enterprise: tier.is_enterprise,
            currency: 'USD',
            provenance: 'live', // overwritten by finalize()
          },
        });
      }

      // A tier absent from this observation was not observed holding any
      // state — its run closes here rather than bridging the silence.
      for (const [name, run] of building) {
        if (!seen.has(name)) { finalize(run); building.delete(name); }
      }
    }

    for (const run of building.values()) finalize(run);
  }

  return rows;
}

const CSV_HEADER = [
  'competitor', 'tier', 'first_observed_at', 'last_observed_at',
  'monthly_price_usd', 'annual_price_usd', 'billing_unit', 'included_seats',
  'is_free', 'is_enterprise', 'currency', 'provenance',
];

/** RFC-4180: quote a field only when it needs it; embedded quotes double up. */
function csvField(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** null is an empty field, never the string "null" and never 0 — a contact-sales price is not free. */
function csvValue(v: string | number | boolean | null): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return csvField(String(v));
}

export function toCsv(rows: DatasetRow[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push([
      csvField(r.competitor), csvField(r.tier), r.first_observed_at, r.last_observed_at,
      csvValue(r.monthly_price_usd), csvValue(r.annual_price_usd), csvField(r.billing_unit),
      csvValue(r.included_seats), csvValue(r.is_free), csvValue(r.is_enterprise),
      r.currency, r.provenance,
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

/** & first, or escaping & itself would double-escape the entities it produces. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const formatValue = (v: unknown): string => (v === null || v === undefined ? 'none' : String(v));

/**
 * Spec 14.4: RSS 2.0 feed of confirmed changes, the subscribe channel for
 * readers who will never bookmark a dashboard. Titles reuse describeChange
 * so the feed and the timeline chart's markers speak identically about the
 * same event.
 */
export function buildRssXml(changes: FeedChange[], generatedAt: string, siteUrl: string): string {
  const items = [...changes]
    .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))
    .slice(0, 50)
    .map(change => {
      const title = `${change.competitor} ${describeChange({
        json_path: change.json_path,
        change_type: change.change_type,
        before_json: JSON.stringify(change.before ?? null),
        after_json: JSON.stringify(change.after ?? null),
      })}`;

      const description = change.annotation !== null
        ? `${change.annotation.implication} — ${change.annotation.so_what}`
        : `${formatValue(change.before)} -> ${formatValue(change.after)}`;

      const guid = [change.slug, change.json_path, change.observed_at].map(escapeXml).join('|');
      const pubDate = new Date(change.observed_at).toUTCString();
      const link = `${siteUrl}/c/${change.slug}`;

      return [
        '<item>',
        `<title>${escapeXml(title)}</title>`,
        `<link>${escapeXml(link)}</link>`,
        `<description>${escapeXml(description)}</description>`,
        `<guid isPermaLink="false">${guid}</guid>`,
        `<pubDate>${pubDate}</pubDate>`,
        '</item>',
      ].join('');
    });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    '<title>Bellwether — pricing changes</title>',
    `<link>${escapeXml(siteUrl)}</link>`,
    '<description>Confirmed SaaS pricing changes tracked by Bellwether.</description>',
    `<lastBuildDate>${new Date(generatedAt).toUTCString()}</lastBuildDate>`,
    ...items,
    '</channel></rss>',
  ].join('');
}

/**
 * Spec 14.4: describes the dataset and points AI assistants at the stable
 * JSON endpoints they can cite. Deterministic on purpose — no timestamp —
 * so it does not churn on every export the way the JSON payloads do.
 */
export function buildLlmsTxt(siteUrl: string, competitors: { name: string; slug: string }[]): string {
  const lines = [
    '# Bellwether',
    '',
    'Bellwether tracks confirmed SaaS pricing changes and publishes the underlying ' +
      'dataset as static, structured files, licensed under CC BY 4.0 ' +
      '(https://creativecommons.org/licenses/by/4.0/).',
    '',
    '## Endpoints',
    `- ${siteUrl}/data/board.json — current pricing snapshot per competitor`,
    `- ${siteUrl}/data/changes.json — confirmed change log with annotations`,
    `- ${siteUrl}/data/timeline.json — per-competitor price history series`,
    `- ${siteUrl}/data/dataset.json — the full dataset, nested`,
    `- ${siteUrl}/data/dataset.csv — the full dataset, flat`,
    `- ${siteUrl}/changes.xml — RSS feed of confirmed changes`,
    '',
    '## Competitors',
    ...competitors.map(c => `- ${c.name}: ${siteUrl}/#${c.slug}`),
  ];
  return lines.join('\n') + '\n';
}
