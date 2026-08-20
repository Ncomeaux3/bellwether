import type { Metadata } from 'next';
import { StateBadge } from '@/components/StateBadge';
import { Stamp } from '@/components/Stamp';
import { loadMechanics } from '@/lib/data';

export const metadata: Metadata = {
  title: 'How it works — Bellwether',
  description:
    'The pipeline, the layered filter that keeps most pages away from the model, per-source health, ' +
    'and cumulative spend — every number on this page comes from a query run at export time.',
};

const fmtMoney = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

const PIPELINE: { step: string; body: string }[] = [
  { step: 'Collect', body: 'Fetches each watched pricing page once daily and stores it only if its bytes changed since the last fetch — a repeat is a pointer, not a copy.' },
  { step: 'Extract', body: 'Sends the page text to a schema-constrained model that returns tiers and prices as structured data. Every number it returns must be findable as a numeral in the page text it was given, or the extraction is discarded — the model cannot invent a price.' },
  { step: 'Detect', body: 'Diffs consecutive extractions of the same source and scores each difference by materiality. Below threshold, a difference is recorded but never reaches an LLM.' },
  { step: 'Confirm', body: 'Holds a candidate change until a second, independent observation repeats it, then promotes it to confirmed. One observation is never enough to publish.' },
  { step: 'Synthesize', body: 'Writes a plain-language annotation for each confirmed change and rolls a weekly digest once enough of them have accumulated.' },
  { step: 'Publish', body: 'Exports the archive to static JSON and commits it to the public site. A guard refuses the publish if any file shrank or a query looks broken.' },
];

export default function HowItWorksPage() {
  const { generated_at, filter, coverage, health, cost } = loadMechanics();

  return (
    <main>
      <header className="border-b border-rule-strong pb-10">
        <h1 className="font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          How it works
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-secondary">
          Every number below is derived from a query run against the live database at export time.
          Nothing here is a hand-written figure, and nothing that cannot be computed is estimated —
          it is left off the page instead.
        </p>
      </header>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">The pipeline</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          Six steps, run nightly. The model fills in a schema at one step only — it never decides
          what happens next. Every branch (skip, retry, degrade, confirm, publish) is a deterministic
          check against stored data, not a judgment call handed to the LLM.
        </p>
        <ol className="mt-6 grid gap-4 sm:grid-cols-2">
          {PIPELINE.map((p, i) => (
            <li key={p.step} className="rounded-lg border border-rule bg-surface-raised p-4">
              <p className="font-mono text-sm text-ink-muted">{String(i + 1).padStart(2, '0')}</p>
              <p className="mt-1 font-display text-lg font-medium text-ink">{p.step}</p>
              <p className="mt-1 text-sm text-ink-secondary">{p.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">The filter</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          Every observation ends in exactly one of five states below, and the five always sum to
          the total — nothing is counted twice, nothing is left out. Only the first three are
          genuine savings; the last two are real, billed model calls (one recorded, one not) and are
          excluded from the avoided count above.
        </p>

        <dl className="mt-6 flex flex-wrap gap-x-10 gap-y-4 font-mono text-sm">
          <div>
            <dt className="text-ink-muted">Observations</dt>
            <dd className="mt-1 text-2xl text-ink">{filter.total_snapshots}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Model calls made</dt>
            <dd className="mt-1 text-2xl text-ink">{filter.extractions_performed}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Model calls avoided</dt>
            <dd className="mt-1 text-2xl text-ink">
              {filter.llm_calls_avoided}
              {filter.llm_calls_avoided_pct !== undefined && (
                <span className="text-ink-muted"> ({filter.llm_calls_avoided_pct}%)</span>
              )}
            </dd>
          </div>
        </dl>

        <div className="mt-6 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">
              Each filter gate, how many observations it eliminated, and how many survived to the next gate
            </caption>
            <thead>
              <tr className="border-b border-rule-strong">
                <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Gate</th>
                <th scope="col" className="py-3 pr-4 text-right text-sm font-medium text-ink-secondary">Eliminated</th>
                <th scope="col" className="py-3 pr-4 text-right text-sm font-medium text-ink-secondary">Remaining</th>
                <th scope="col" className="py-3 text-sm font-medium text-ink-secondary">What it means</th>
              </tr>
            </thead>
            <tbody>
              {filter.gates.map(gate => (
                <tr key={gate.name} className="border-b border-rule align-top">
                  <th scope="row" className="py-3 pr-4 font-medium text-ink whitespace-nowrap">{gate.name}</th>
                  <td className="py-3 pr-4 text-right font-mono text-ink-secondary">{gate.eliminated}</td>
                  <td className="py-3 pr-4 text-right font-mono text-ink-secondary">{gate.remaining}</td>
                  <td className="py-3 text-sm text-ink-secondary">{gate.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-sm text-ink-muted">
          {coverage.first_observed_at !== null && coverage.last_observed_at !== null ? (
            <>
              Spans <Stamp iso={coverage.first_observed_at} /> to <Stamp iso={coverage.last_observed_at} /> —{' '}
              {coverage.months_covered} calendar month{coverage.months_covered === 1 ? '' : 's'},{' '}
              {coverage.live_snapshots} live observation{coverage.live_snapshots === 1 ? '' : 's'} and{' '}
              {coverage.backfilled_snapshots} backfilled from the Internet Archive.
            </>
          ) : (
            <>
              {filter.total_snapshots} snapshot{filter.total_snapshots === 1 ? '' : 's'} collected
              so far; none has produced a priced observation yet.
            </>
          )}
        </p>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">Source health</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          State is never color alone — every row carries a text label alongside its marker.
        </p>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Every watched source, its current state, and when it was last verified</caption>
            <thead>
              <tr className="border-b border-rule-strong">
                <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Source</th>
                <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">State</th>
                <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Last verified</th>
                <th scope="col" className="py-3 text-sm font-medium text-ink-secondary">Note</th>
              </tr>
            </thead>
            <tbody>
              {health.sources.map(s => (
                <tr key={`${s.slug}-${s.kind}`} className="border-b border-rule align-top">
                  <th scope="row" className="py-3 pr-4 font-medium text-ink whitespace-nowrap">
                    {s.slug} <span className="font-mono text-sm text-ink-muted">· {s.kind}</span>
                  </th>
                  <td className="py-3 pr-4"><StateBadge state={s.state} /></td>
                  <td className="py-3 pr-4"><Stamp iso={s.last_ok_at} /></td>
                  <td className="py-3 text-sm text-state-degraded">{s.degraded_reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">Spend</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          Money actually spent — not a projection — on successful extractions and digests, tracked
          per call. A call that failed grounding or schema validation still consumed real tokens,
          and that cost is not yet metered anywhere in this system, so every figure below is a
          floor, not a total. Recurring extraction and synthesis costs are separate from the
          one-time cost of backfilling history.
        </p>
        <dl className="mt-6 flex flex-wrap gap-x-10 gap-y-4 font-mono text-sm">
          <div>
            <dt className="text-ink-muted">Cumulative, all time</dt>
            <dd className="mt-1 text-2xl text-ink">{fmtMoney(cost.cumulative_micros)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">This month, recurring</dt>
            <dd className="mt-1 text-2xl text-ink">{fmtMoney(cost.month_micros)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Backfill, one-time</dt>
            <dd className="mt-1 text-2xl text-ink">{fmtMoney(cost.backfill_micros)}</dd>
          </div>
          {cost.per_confirmed_change_micros !== undefined && (
            <div>
              <dt className="text-ink-muted">Per confirmed change</dt>
              <dd className="mt-1 text-2xl text-ink">{fmtMoney(cost.per_confirmed_change_micros)}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">Run history</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          The most recent completed run of each pipeline step.
        </p>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">The latest completed run of each pipeline step, its state, and when it finished</caption>
            <thead>
              <tr className="border-b border-rule-strong">
                <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Step</th>
                <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">State</th>
                <th scope="col" className="py-3 text-sm font-medium text-ink-secondary">Finished</th>
              </tr>
            </thead>
            <tbody>
              {health.runs.map(r => (
                <tr key={r.kind} className="border-b border-rule align-top">
                  <th scope="row" className="py-3 pr-4 font-mono text-sm font-medium text-ink whitespace-nowrap">{r.kind}</th>
                  <td className="py-3 pr-4 text-sm text-ink-secondary">{r.state}</td>
                  <td className="py-3"><Stamp iso={r.ended_at} /></td>
                </tr>
              ))}
              {health.runs.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-3 text-sm text-ink-muted">
                    No pipeline step has completed yet, as of{' '}
                    <Stamp iso={generated_at || null} empty="the last export" />.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
