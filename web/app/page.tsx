import { BoardTable } from '@/components/BoardTable';
import { month, observationMoments, Ribbon } from '@/components/Ribbon';
import { StateBadge } from '@/components/StateBadge';
import { Stamp } from '@/components/Stamp';
import { changeLabel, loadBoard, loadChanges, loadDigest, loadStatus, loadTimeline } from '@/lib/data';
import { renderMarkdown } from '@/lib/markdown';
import type { SourceState, TimelineCompetitor } from '@/lib/types';

// R4 (M3.5 plan): above this many competitors, one full-width hero ribbon
// each no longer reads as one screen — the board switches to a small-
// multiple grid (spec 14.3's third scale). One named constant makes that
// switch a decision the code states, not a redesign the next milestone
// re-litigates.
const HERO_LIMIT = 8;

// The exporter classifies each competitor's cheapest priced (non-free) tier
// as 'entry' (src/workflow/export.ts's classifyTiers) — read the same field
// the ribbon already colors by, rather than re-deriving "entry" from
// board.json's tier list a second way.
function entryPriceOf(competitor: TimelineCompetitor): number | null {
  const entry = competitor.series.find(s => s.tier_class === 'entry');
  const last = entry?.segments[entry.segments.length - 1]?.at(-1);
  return last?.price ?? null;
}

export default function HomePage() {
  const board = loadBoard();
  const status = loadStatus();
  const timeline = loadTimeline();
  const digest = loadDigest();
  const changes = loadChanges();
  const recentChanges = changes.changes.slice(0, 10);
  // Real datum for the "no confirmed changes" empty state below: the
  // earliest observation on file across every competitor, already loaded
  // via loadTimeline() — no new payload field needed.
  const earliestObservedAt = timeline.competitors
    .map(c => c.first_observed_at)
    .filter((d): d is string => d !== null)
    .sort()[0] ?? null;

  // State and last-checked per competitor for the grid card: board.json is
  // the state authority BoardTable already reads, keyed by slug since every
  // watched competitor has exactly one source (the 27-source config admits
  // one `pricing` source each).
  const boardBySlug = new Map(board.competitors.map(c => [c.slug, c]));
  const stateOf = (slug: string): SourceState => boardBySlug.get(slug)?.sources[0]?.state ?? 'pending';
  const lastCheckedOf = (slug: string): string | null => boardBySlug.get(slug)?.sources[0]?.last_checked_at ?? null;

  const useGrid = timeline.competitors.length > HERO_LIMIT;

  return (
    <main>
      <header className="border-b border-rule-strong pb-10">
        <h1 className="font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          Bellwether
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-secondary">
          The open archive of developer-infrastructure pricing. Bellwether checks every watched
          page daily and reports whether the source is still readable.
        </p>

        <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4 font-mono text-sm">
          <div>
            <dt className="text-ink-muted">Sources watched</dt>
            <dd className="mt-1 text-2xl text-ink">{status.total_sources}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Verified now</dt>
            <dd className="mt-1 text-2xl text-ink">
              {status.healthy_sources}<span className="text-ink-muted">/{status.total_sources}</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">Spend this month</dt>
            <dd className="mt-1 text-2xl text-ink">
              ${(status.cost_micros_month / 1_000_000).toFixed(2)}
            </dd>
          </div>
        </dl>
      </header>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">The record</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          Current tiers for every watched source, and whether the page is still readable.
          Confirmed price changes appear once a second observation agrees.
        </p>
        <div className="mt-6">
          <BoardTable competitors={board.competitors} />
        </div>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">The timeline</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          Monthly price per tier, seeded from the Internet Archive. Historical captures are monthly,
          so a change is dated to within a month of when it happened. Where the archive has no
          capture the line breaks — nothing here is interpolated. The price axis is logarithmic, so
          tiers that differ by orders of magnitude stay readable on one chart.
        </p>

        {timeline.observation_count === 0 ? (
          <p className="mt-6 text-sm text-ink-muted">
            No observations recorded yet across {status.total_sources} watched source
            {status.total_sources === 1 ? '' : 's'}. Run{' '}
            <span className="font-mono">bellwether backfill</span> to seed history, or{' '}
            <span className="font-mono">bellwether collect</span> for the first live observation.
          </p>
        ) : useGrid ? (
          <>
            <p className="mt-2 max-w-2xl text-ink-secondary">
              {timeline.competitors.length} competitors is too many for one full chart each, so
              this is a small-multiple index: a compact price line, current entry price, and
              state per competitor. The record above remains the authoritative view of every tier.
            </p>
            <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {timeline.competitors.map(competitor => {
                const moments = observationMoments(competitor);
                const entryPrice = entryPriceOf(competitor);
                return (
                  <li key={competitor.slug}>
                    <a
                      href={`/c/${competitor.slug}/`}
                      className="block rounded-lg border border-rule bg-surface-raised p-4 hover:border-rule-strong"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-display text-base font-medium text-ink">
                          {competitor.name}
                        </span>
                        <StateBadge state={stateOf(competitor.slug)} />
                      </div>
                      <p className="mt-1 font-mono text-sm text-ink-secondary">
                        {entryPrice === null
                          ? 'no priced entry tier on file'
                          : entryPrice === 0 ? 'Free' : `$${entryPrice}/mo entry`}
                      </p>
                      <div className="mt-3">
                        {moments >= 2 ? (
                          <Ribbon competitor={competitor} scale="spark" />
                        ) : (
                          <p className="text-xs text-ink-muted">
                            {moments === 0 ? (
                              'Not yet observed.'
                            ) : (
                              <>
                                One observation, {month(competitor.first_observed_at!)} — not
                                yet enough for a trend line. Last checked{' '}
                                <Stamp iso={lastCheckedOf(competitor.slug)} empty="not yet" />.
                              </>
                            )}
                          </p>
                        )}
                      </div>
                    </a>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <div className="mt-8 grid gap-10">
            {timeline.competitors.map((competitor, index) => (
              <article key={`${competitor.slug}-${index}`} className="rounded-lg border border-rule bg-surface-raised p-5">
                <h3 className="font-display text-lg font-medium text-ink">
                  <a
                    href={`/c/${competitor.slug}/`}
                    className="underline decoration-rule-strong underline-offset-4 hover:text-ink-secondary"
                  >
                    {competitor.name}
                  </a>
                </h3>
                <div className="mt-4">
                  <Ribbon competitor={competitor} scale="hero" />
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">The brief</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          A digest fires once three confirmed changes are pending, or every 30 days — whichever
          comes first.
        </p>

        {digest.digest === null ? (
          <p className="mt-6 text-sm text-ink-muted">
            {/* digest.digest === null means no digest has ever fired, so every
                confirmed change on file is still pending — changes.changes.length
                is exactly that count, no separate datum required. */}
            {changes.changes.length >= 3 ? (
              <>
                {changes.changes.length} confirmed changes are pending — the next digest fires
                the following Monday.
              </>
            ) : (
              <>
                {changes.changes.length} of 3 confirmed changes recorded — the first digest fires
                once a third arrives, or after 30 days, whichever comes first.
              </>
            )}
          </p>
        ) : (
          <article className="mt-6 rounded-lg border border-rule bg-surface-raised p-5">
            <p className="font-mono text-xs text-ink-muted">
              {/* item_count counts digest SECTIONS, not confirmed changes (a
                  section can roll up several) — labeled for what it actually
                  is (final-fixes round, task 7) rather than implying it is
                  the change count. */}
              Published <Stamp iso={digest.digest.created_at} /> · {digest.digest.item_count} item
              {digest.digest.item_count === 1 ? '' : 's'}
            </p>
            <div
              className="mt-4 max-w-2xl text-ink-secondary [&_h2]:mt-4 [&_h2]:font-display [&_h2]:text-lg [&_h2]:font-medium [&_h2]:text-ink [&_h3]:mt-3 [&_h3]:font-display [&_h3]:text-base [&_h3]:font-medium [&_h3]:text-ink [&_p]:mt-2 [&_p:first-child]:mt-0 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_strong]:text-ink"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(digest.digest.body_markdown) }}
            />
          </article>
        )}
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">Recent confirmed changes</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          The last {recentChanges.length === 1 ? 'change' : `${recentChanges.length} changes`} to
          clear confirmation, most recent first. Full history is in{' '}
          <a href="/data/" className="underline decoration-rule-strong underline-offset-4 hover:text-ink">
            the dataset
          </a>.
        </p>

        {recentChanges.length === 0 ? (
          <p className="mt-6 text-sm text-ink-muted">
            No confirmed changes
            {earliestObservedAt && <> since <Stamp iso={earliestObservedAt} /></>}. Last checked{' '}
            <Stamp iso={status.generated_at || null} empty="not yet" />.
          </p>
        ) : (
          <ul className="mt-6 divide-y divide-rule">
            {recentChanges.map(c => (
              <li key={`${c.slug}-${c.json_path}-${c.observed_at}`} className="py-3">
                <p className="font-mono text-sm text-ink">
                  <span className="text-ink-secondary">{c.competitor}</span> · {changeLabel(c)}
                </p>
                {c.annotation && (
                  <p className="mt-1 text-sm italic text-ink-secondary">{c.annotation.implication}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-12 border-t border-rule pt-6">
        <p className="text-sm text-ink-muted">
          Last published <Stamp iso={status.generated_at || null} empty="not yet" />.
          {status.last_run && (
            <> Last <span className="font-mono">{status.last_run.kind}</span> run finished{' '}
              <Stamp iso={status.last_run.ended_at} empty="still running" />.</>
          )}
        </p>
        <p className="mt-2 text-sm text-ink-muted">
          <a href="/how-it-works/" className="text-ink-secondary underline decoration-rule-strong underline-offset-4 hover:text-ink">
            How it works
          </a>
          {' — the pipeline, the live filter rates, source health, and cumulative spend. See also '}
          <a href="/data/" className="text-ink-secondary underline decoration-rule-strong underline-offset-4 hover:text-ink">
            the dataset
          </a>.
        </p>
      </section>
    </main>
  );
}
