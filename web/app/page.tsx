import { BoardTable } from '@/components/BoardTable';
import { Ribbon } from '@/components/Ribbon';
import { Stamp } from '@/components/Stamp';
import { changeLabel, loadBoard, loadChanges, loadDigest, loadStatus, loadTimeline } from '@/lib/data';
import { renderMarkdown } from '@/lib/markdown';

export default function HomePage() {
  const board = loadBoard();
  const status = loadStatus();
  const timeline = loadTimeline();
  const digest = loadDigest();
  const changes = loadChanges();
  const recentChanges = changes.changes.slice(0, 10);

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
            No history yet. Run <span className="font-mono">bellwether backfill</span> to seed it.
          </p>
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
            No digest yet — the first one fires after three confirmed changes.
          </p>
        ) : (
          <article className="mt-6 rounded-lg border border-rule bg-surface-raised p-5">
            <p className="font-mono text-xs text-ink-muted">
              Published <Stamp iso={digest.digest.created_at} /> · {digest.digest.item_count} change
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
          <p className="mt-6 text-sm text-ink-muted">No confirmed changes yet.</p>
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
      </section>
    </main>
  );
}
