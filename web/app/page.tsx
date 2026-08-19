import { BoardTable } from '@/components/BoardTable';
import { Stamp } from '@/components/Stamp';
import { loadBoard, loadStatus } from '@/lib/data';

export default function HomePage() {
  const board = loadBoard();
  const status = loadStatus();

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
