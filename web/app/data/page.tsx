import type { Metadata } from 'next';
import { Stamp } from '@/components/Stamp';
import { loadCompetitor, loadDatasetMeta, loadMechanics } from '@/lib/data';

/** Verified by hand on 2026-08-18 (spec 11.1) — predates `candidates` (M3.5)
 * and so is not itself a screening result; kept as a fixed list rather than
 * derived. */
const ORIGINAL_SIX = ['Linear', 'Notion', 'Figma', 'Supabase', 'Sentry', 'Postman'];

const tierPrice = (t: { is_free: boolean; monthly_price_usd: number | null }): string =>
  t.is_free ? '$0' : t.monthly_price_usd === null ? 'contact' : `$${t.monthly_price_usd}`;

export const metadata: Metadata = {
  title: 'The dataset — Bellwether',
  description:
    'Every field, every null, every source, and the license. Download dataset.csv or dataset.json directly.',
};

const SCHEMA: { field: string; type: string; note: string }[] = [
  { field: 'competitor', type: 'string', note: 'The company name.' },
  { field: 'tier', type: 'string', note: 'The pricing tier name as it appears on the source page.' },
  { field: 'first_observed_at', type: 'ISO 8601 timestamp', note: 'When this tier state was first observed.' },
  { field: 'last_observed_at', type: 'ISO 8601 timestamp', note: 'The last observation still holding this same state — one row covers the whole run, not one row per check.' },
  { field: 'monthly_price_usd', type: 'number | null', note: 'Empty / null means contact sales, never free. A free tier is $0, written explicitly.' },
  { field: 'annual_price_usd', type: 'number | null', note: 'Same null semantics as monthly_price_usd.' },
  { field: 'billing_unit', type: '"per_seat" | "flat" | "usage" | "unknown"', note: '"unknown" means the source page did not state it, not that none applies.' },
  { field: 'included_seats', type: 'number | null', note: 'Null when the tier has no seat limit or the page does not state one.' },
  { field: 'is_free', type: 'boolean', note: 'True only for an explicit $0 tier.' },
  { field: 'is_enterprise', type: 'boolean', note: 'The source page\'s own enterprise/custom-pricing tier, not an inference from price.' },
  { field: 'currency', type: 'string', note: 'Always "USD" — non-USD extractions are recorded internally but excluded from the published dataset.' },
  { field: 'provenance', type: '"live" | "wayback" | "mixed"', note: 'See the legend below.' },
];

const PROVENANCE: { value: string; note: string }[] = [
  { value: 'live', note: 'Every observation in this row\'s run was a direct fetch of the source page.' },
  { value: 'wayback', note: 'Every observation in this run was reconstructed from an Internet Archive capture.' },
  { value: 'mixed', note: 'The run spans both — a live fetch confirmed a state first seen in a Wayback capture, or vice versa.' },
];

const CITATION_PLAIN = 'Bellwether. Developer-infrastructure pricing archive [dataset]. https://bellwether-nicholas-projects-cdfeb046.vercel.app/data/';
const CITATION_BIBTEX = `@misc{bellwether,
  title  = {Bellwether: developer-infrastructure pricing archive},
  author = {{Bellwether}},
  url    = {https://bellwether-nicholas-projects-cdfeb046.vercel.app/data/},
  note   = {CC BY 4.0}
}`;

export default function DataPage() {
  const meta = loadDatasetMeta();
  const { screening } = loadMechanics();
  const vercel = screening ? loadCompetitor('vercel') : null;

  // One flat, name-sorted list for the exclusions table — every rejected
  // company tagged with the kind that excluded it, plus the pre-filter
  // failures tagged with their own (single, fixed) kind.
  const excluded = screening
    ? [
        ...screening.rejected_by_kind.flatMap(k => k.companies.map(c => ({ ...c, kind: k.kind }))),
        ...screening.failed_companies.map(c => ({ ...c, kind: 'No price signal found in the raw page' })),
      ].sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return (
    <main>
      <header className="border-b border-rule-strong pb-10">
        <h1 className="font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          The dataset
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-secondary">
          Every field, every null, and the boundary of what is watched — so the data is checkable,
          not just readable.
        </p>
      </header>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">Download</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          One row per (competitor, tier, price state). Regenerated and committed on every export,
          so any past state is retrievable from git history.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {(['dataset.csv', 'dataset.json'] as const).map(name => (
            <a
              key={name}
              href={`/data/${name}`}
              className="block rounded-lg border border-rule bg-surface-raised p-5 hover:border-rule-strong"
            >
              <p className="font-mono text-base text-ink">{name}</p>
              <p className="mt-2 font-mono text-sm text-ink-muted">
                {meta.rowCount} row{meta.rowCount === 1 ? '' : 's'} · generated{' '}
                <Stamp iso={meta.generatedAt || null} empty="not yet" />
              </p>
            </a>
          ))}
        </div>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">Schema</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          Field names, types, and null semantics — the same on both files.
        </p>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Dataset field names, types, and null semantics</caption>
            <thead>
              <tr className="border-b border-rule-strong">
                <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Field</th>
                <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Type</th>
                <th scope="col" className="py-3 text-sm font-medium text-ink-secondary">Notes</th>
              </tr>
            </thead>
            <tbody>
              {SCHEMA.map(row => (
                <tr key={row.field} className="border-b border-rule align-top">
                  <th scope="row" className="py-3 pr-4 font-mono text-sm font-medium text-ink whitespace-nowrap">
                    {row.field}
                  </th>
                  <td className="py-3 pr-4 font-mono text-sm text-ink-secondary whitespace-nowrap">{row.type}</td>
                  <td className="py-3 text-sm text-ink-secondary">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="mt-8 font-display text-lg font-medium text-ink">Provenance legend</h3>
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          {PROVENANCE.map(p => (
            <div key={p.value} className="rounded-lg border border-rule bg-surface-raised p-4">
              <dt className="font-mono text-sm font-medium text-ink">{p.value}</dt>
              <dd className="mt-1 text-sm text-ink-secondary">{p.note}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">Methodology</h2>
        <ul className="mt-4 max-w-2xl list-disc space-y-3 pl-5 text-ink-secondary">
          <li>
            Every watched source is checked once daily at 07:00 CT (±30m jitter), plus a weekly
            synthesis run.
          </li>
          <li>
            Pricing is extracted from the raw page HTML by a schema-constrained LLM call. Every
            numeric price in the output must be findable as a numeral in the page text it was
            given — a price the model produced but the page never contained fails this grounding
            check and is never written.
          </li>
          <li>
            A candidate change is not published until its new value is observed a second time:
            live changes confirm the next day, backfilled changes confirm against the following
            capture. This is the single confirmation rule for both paths.
          </li>
          <li>
            Curation policy: a change observed only once, with no persisting second observation,
            is re-checked by re-extracting both snapshots. Agreement confirms it; disagreement
            retracts it — and the exclusion is recorded, not silently dropped.
          </li>
          <li>
            Resolution differs by source: backfilled history comes from monthly Internet Archive
            captures, so a change is dated to within a month of when it actually happened, and two
            changes inside one month can appear as one. Live observations are daily. The{' '}
            <span className="font-mono">provenance</span> column tells you which applies to any
            given row.
          </li>
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">Boundary</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          Six developer-infrastructure companies were verified by hand as server-rendering their
          prices in raw HTML: <span className="text-ink">{ORIGINAL_SIX.join(', ')}</span>.
        </p>

        {screening ? (
          <>
            <p className="mt-6 font-display text-xl text-ink">
              Screened {screening.total_screened} companies; {screening.admitted} publish
              comparable plan pricing.
            </p>
            <p className="mt-3 max-w-2xl text-ink-secondary">
              A further {screening.total_screened} developer-infrastructure companies were
              screened programmatically (<span className="font-mono">bellwether qualify</span>):
              each candidate&apos;s pricing page was fetched, scored for a plausible
              price-and-tier signal, then run through two independent live extractions.{' '}
              {screening.admitted} admitted — both extractions agreeing on a plausible tier
              count ({screening.pass_rate_pct}% of the pool) — bringing the watch list to{' '}
              {ORIGINAL_SIX.length + screening.admitted} sources. Naming the exclusions is what
              makes the inclusions credible.
            </p>

            <h3 className="mt-8 font-display text-lg font-medium text-ink">Admitted, by category</h3>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {screening.admitted_by_category.map(g => (
                <div key={g.category} className="rounded-lg border border-rule bg-surface-raised p-4">
                  <dt className="font-mono text-sm font-medium text-ink">
                    {g.category} <span className="text-ink-muted">({g.count})</span>
                  </dt>
                  <dd className="mt-1 text-sm text-ink-secondary">{g.companies.join(', ')}</dd>
                </div>
              ))}
            </dl>

            {vercel !== null && vercel.current_tiers.length > 0 && (
              <p className="mt-8 max-w-2xl text-ink-secondary">
                <span className="text-ink">Vercel now qualifies.</span> This project&apos;s own
                spec named Vercel the canonical qualification failure: a client-rendered shell
                with no price in the raw HTML. The screen tests that claim rather than assuming
                it, and on {' '}<Stamp iso={vercel.first_observed_at} />{' '} it no longer held —
                Vercel&apos;s page is server-rendered and extracts as{' '}
                <span className="text-ink">
                  {vercel.current_tiers.map((t, i) => (
                    <span key={t.name}>
                      {i > 0 ? ' / ' : ''}
                      {t.name} {tierPrice(t)}
                    </span>
                  ))}
                </span>
                . That is why it is in the watch list, not an exception to the boundary.
              </p>
            )}

            <p className="mt-3 max-w-2xl text-ink-secondary">
              <span className="text-ink">Datadog, Cloudflare, and Fastly publish server-rendered
              pricing</span> — the screen found real prices in their raw HTML, same as every
              admitted source. Each is excluded because it prices per product or per unit of
              usage rather than per plan, so neither extraction attempt reproduced a plan table
              comparable to the rest of the watch list. They are excluded for comparability, not
              because they publish nothing.
            </p>

            <h3 className="mt-8 font-display text-lg font-medium text-ink">
              Excluded ({screening.rejected + screening.failed})
            </h3>
            <p className="mt-2 max-w-2xl text-ink-secondary">
              {screening.rejected} reached extraction but did not qualify:{' '}
              {screening.rejected_by_kind
                .filter(k => k.count > 0)
                .map(k => `${k.kind.toLowerCase()} (${k.count})`)
                .join('; ')}
              . {screening.failed} more never reached extraction — the pre-filter found
              essentially no price signal on the page at all.
            </p>

            <div className="mt-6 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <caption className="sr-only">
                  Every screened-out company, its category, and why it was excluded
                </caption>
                <thead>
                  <tr className="border-b border-rule-strong">
                    <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Company</th>
                    <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Category</th>
                    <th scope="col" className="py-3 text-sm font-medium text-ink-secondary">Why excluded</th>
                  </tr>
                </thead>
                <tbody>
                  {excluded.map(row => (
                    <tr key={row.name} className="border-b border-rule align-top">
                      <th scope="row" className="py-3 pr-4 font-medium text-ink whitespace-nowrap">
                        {row.name}
                      </th>
                      <td className="py-3 pr-4 text-sm text-ink-secondary whitespace-nowrap">{row.category}</td>
                      <td className="py-3 text-sm text-ink-secondary">
                        <details>
                          <summary className="cursor-pointer text-ink">{row.kind}</summary>
                          <p className="mt-1">{row.reason}</p>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="mt-3 max-w-2xl text-ink-secondary">
            Screening results have not been published yet — run{' '}
            <span className="font-mono">bellwether qualify --all</span> and export.
          </p>
        )}
      </section>

      <section className="mt-12 border-t border-rule pt-8">
        <h2 className="font-display text-2xl font-medium text-ink">License and citation</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          Licensed <span className="text-ink">CC BY 4.0</span> — reuse it anywhere, with
          attribution.
        </p>

        <h3 className="mt-6 font-display text-base font-medium text-ink">Citation</h3>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-rule bg-surface-raised p-4 font-mono text-sm text-ink-secondary">
{CITATION_PLAIN}
        </pre>

        <h3 className="mt-6 font-display text-base font-medium text-ink">BibTeX</h3>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-rule bg-surface-raised p-4 font-mono text-sm text-ink-secondary">
{CITATION_BIBTEX}
        </pre>
      </section>
    </main>
  );
}
