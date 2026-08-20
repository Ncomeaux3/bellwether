import type { Metadata } from 'next';
import { Ribbon } from '@/components/Ribbon';
import { Stamp } from '@/components/Stamp';
import { changeLabel, competitorPayloadPath, loadBoard, loadCompetitor } from '@/lib/data';

// Same value layout.tsx's metadataBase and src/workflow/export.ts's SITE_URL
// use — not imported (web/ cannot import from src/, and Next has no clean
// way to read metadataBase back out at render time), so it is restated here.
const SITE_URL = 'https://bellwether-nicholas-projects-cdfeb046.vercel.app';

/**
 * Fix round 1, finding 2: a slug board.json lists but whose
 * competitors/<slug>.json never got exported (or is corrupt) used to build
 * silently, publishing a citable page whose title and JSON-LD read the raw
 * slug as the company name and an empty temporalCoverage. Fail the build
 * loudly instead — naming the slug and the exact file the pipeline was
 * supposed to write — since that is strictly better than shipping a wrong
 * citation. A competitor with a real payload but zero observed history is a
 * different, legitimate case and is unaffected (its `name` is never empty).
 */
export function generateStaticParams() {
  const slugs = loadBoard().competitors.map(c => c.slug);
  for (const slug of slugs) {
    if (loadCompetitor(slug).name === '') {
      throw new Error(
        `Missing competitor payload for "${slug}": expected ${competitorPayloadPath(slug)} ` +
        `to exist (board.json lists this competitor but export never wrote its JSON, or it ` +
        `failed to parse). Run \`bellwether export\` before building.`
      );
    }
  }
  return slugs.map(slug => ({ slug }));
}

/** The exact framing spec 14.4 names: "Linear pricing history — every change since 2025". */
function titleFor(name: string, sinceYear: number): string {
  return `${name} pricing history — every change since ${sinceYear}`;
}

function sinceYearOf(competitor: { first_observed_at: string | null; generated_at: string }): number {
  const source = competitor.first_observed_at ?? competitor.generated_at;
  const year = source ? new Date(source).getFullYear() : new Date().getFullYear();
  return Number.isNaN(year) ? new Date().getFullYear() : year;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const competitor = loadCompetitor(slug);
  const year = sinceYearOf(competitor);
  const title = titleFor(competitor.name, year);
  const description =
    `${competitor.name}'s full pricing history, tracked by Bellwether: confirmed price changes ` +
    `since ${year}, current tiers, and a citable, structured dataset. Licensed CC BY 4.0.`;

  return { title, description };
}

export default async function CompetitorPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const competitor = loadCompetitor(slug);
  const year = sinceYearOf(competitor);
  const hasHistory = competitor.first_observed_at !== null;
  const pageUrl = `${SITE_URL}/c/${competitor.slug}/`;
  const jsonUrl = `${SITE_URL}/data/competitors/${competitor.slug}.json`;
  const csvUrl = `${SITE_URL}/data/dataset.csv`;

  const citationPlain = `Bellwether. ${competitor.name} pricing history [dataset]. ${pageUrl}`;
  const citationBibtex = `@misc{bellwether_${competitor.slug},
  title  = {Bellwether: ${competitor.name} pricing history},
  author = {{Bellwether}},
  url    = {${pageUrl}},
  note   = {CC BY 4.0}
}`;

  const datasetLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: titleFor(competitor.name, year),
    description:
      `Confirmed pricing changes for ${competitor.name}, tracked by Bellwether since ${year}.`,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    creator: { '@type': 'Organization', name: 'Bellwether' },
    url: pageUrl,
    ...(hasHistory ? {
      temporalCoverage: `${competitor.first_observed_at}/${competitor.last_observed_at}`,
    } : {}),
    distribution: [
      { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: jsonUrl },
      { '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: csvUrl },
    ],
  };

  return (
    <main>
      {/* Built as an object and JSON.stringify'd — never a template string.
          Every `<` is escaped to the < unicode form: names in this
          payload trace back to a third-party pricing page via the model, and
          an unescaped `</script>` inside one would otherwise break out of
          this tag. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetLd).replace(/</g, '\\u003c') }}
      />

      <header className="border-b border-rule-strong pb-10">
        <p className="font-mono text-sm text-ink-muted">
          <a href="/" className="underline decoration-rule-strong underline-offset-4 hover:text-ink">
            Bellwether
          </a>
          {' / '}{competitor.name}
        </p>
        <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          {titleFor(competitor.name, year)}
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-secondary">
          Every confirmed price change for{' '}
          <a
            href={competitor.homepage}
            rel="nofollow noreferrer"
            className="text-ink underline decoration-rule-strong underline-offset-4 hover:text-ink"
          >
            {competitor.name}
          </a>
          , recorded as it happened and checkable against the source.
        </p>
      </header>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">Price history</h2>
        {hasHistory ? (
          <div className="mt-6 rounded-lg border border-rule bg-surface-raised p-5">
            <Ribbon
              competitor={{
                slug: competitor.slug,
                name: competitor.name,
                first_observed_at: competitor.first_observed_at,
                last_observed_at: competitor.last_observed_at,
                series: competitor.series,
                markers: competitor.markers,
              }}
              scale="hero"
            />
          </div>
        ) : (
          <p className="mt-6 text-sm text-ink-muted">
            No pricing observations recorded yet for {competitor.name}. The source is watched but
            has not yet been observed holding a state, as of{' '}
            <Stamp iso={competitor.generated_at || null} empty="the last export" />.
          </p>
        )}
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">Current tiers</h2>
        {competitor.current_tiers.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">
            No current pricing has been extracted for {competitor.name} yet.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">{competitor.name}&apos;s current pricing tiers</caption>
              <thead>
                <tr className="border-b border-rule-strong">
                  <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Tier</th>
                  <th scope="col" className="py-3 pr-4 text-right text-sm font-medium text-ink-secondary">Monthly</th>
                  <th scope="col" className="py-3 pr-4 text-right text-sm font-medium text-ink-secondary">Annual</th>
                  <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Billing</th>
                  <th scope="col" className="py-3 text-right text-sm font-medium text-ink-secondary">Seats included</th>
                </tr>
              </thead>
              <tbody>
                {competitor.current_tiers.map(t => (
                  <tr key={t.name} className="border-b border-rule align-top">
                    <th scope="row" className="py-3 pr-4 font-mono text-sm font-medium text-ink whitespace-nowrap">
                      {t.name}
                    </th>
                    <td className="py-3 pr-4 text-right font-mono text-sm text-ink">
                      {t.is_free ? 'Free' : t.monthly_price_usd === null ? (
                        <span className="text-ink-muted">contact sales</span>
                      ) : `$${t.monthly_price_usd}`}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono text-sm text-ink">
                      {t.annual_price_usd === null
                        ? <span className="text-ink-muted">—</span>
                        : `$${t.annual_price_usd}`}
                    </td>
                    <td className="py-3 pr-4 font-mono text-sm text-ink-secondary">{t.billing_unit}</td>
                    <td className="py-3 text-right font-mono text-sm text-ink-secondary">
                      {t.included_seats === null
                        ? <span className="text-ink-muted">—</span>
                        : t.included_seats}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">Confirmed changes</h2>
        {competitor.changes.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">
            No confirmed changes recorded yet for {competitor.name}
            {hasHistory && <> since <Stamp iso={competitor.first_observed_at} /></>}.
          </p>
        ) : (
          <ul className="mt-6 divide-y divide-rule">
            {competitor.changes.map(c => (
              <li key={`${c.json_path}-${c.observed_at}`} className="py-3">
                <p className="font-mono text-sm text-ink">
                  <Stamp iso={c.observed_at} /> · {changeLabel(c)}
                </p>
                {c.annotation && (
                  <p className="mt-1 text-sm italic text-ink-secondary">{c.annotation.implication}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">Coverage</h2>
        <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-4 font-mono text-sm">
          <div>
            <dt className="text-ink-muted">First observed</dt>
            <dd className="mt-1 text-ink"><Stamp iso={competitor.first_observed_at} /></dd>
          </div>
          <div>
            <dt className="text-ink-muted">Last observed</dt>
            <dd className="mt-1 text-ink"><Stamp iso={competitor.last_observed_at} /></dd>
          </div>
        </dl>
        <p className="mt-4 max-w-2xl text-sm text-ink-secondary">
          {competitor.provenance.live} observation{competitor.provenance.live === 1 ? '' : 's'} came
          from a direct fetch of the source page (live); {competitor.provenance.wayback}{' '}
          {competitor.provenance.wayback === 1 ? 'was' : 'were'} reconstructed from an Internet
          Archive capture (wayback); {competitor.provenance.mixed}{' '}
          {competitor.provenance.mixed === 1 ? 'spans' : 'span'} both. See{' '}
          <a href="/data/" className="underline decoration-rule-strong underline-offset-4 hover:text-ink">
            the dataset page
          </a>{' '}
          for the full provenance legend.
        </p>
      </section>

      <section className="mt-12 border-t border-rule pt-8">
        <h2 className="font-display text-2xl font-medium text-ink">License, citation, and data</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          Licensed <span className="text-ink">CC BY 4.0</span> — reuse it anywhere, with
          attribution. Raw JSON for {competitor.name} is at{' '}
          <a
            href={`/data/competitors/${competitor.slug}.json`}
            className="font-mono underline decoration-rule-strong underline-offset-4 hover:text-ink"
          >
            /data/competitors/{competitor.slug}.json
          </a>.
        </p>

        <h3 className="mt-6 font-display text-base font-medium text-ink">Citation</h3>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-rule bg-surface-raised p-4 font-mono text-sm text-ink-secondary">
{citationPlain}
        </pre>

        <h3 className="mt-6 font-display text-base font-medium text-ink">BibTeX</h3>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-rule bg-surface-raised p-4 font-mono text-sm text-ink-secondary">
{citationBibtex}
        </pre>
      </section>
    </main>
  );
}
