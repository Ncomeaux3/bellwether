import type { BoardCompetitor } from '@/lib/types';
import { StateBadge } from './StateBadge';
import { Stamp } from './Stamp';

export function BoardTable({ competitors }: { competitors: BoardCompetitor[] }) {
  if (competitors.length === 0) {
    return (
      <div className="rounded border border-rule bg-surface-raised p-8">
        <p className="text-ink">Nothing recorded yet.</p>
        <p className="mt-2 text-ink-secondary">
          Run <code className="font-mono text-ink">bellwether collect</code> to take the first
          observation, then <code className="font-mono text-ink">bellwether export</code> to publish it.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">
          Every watched source, its current state, and when it was last verified
        </caption>
        <thead>
          <tr className="border-b border-rule-strong">
            <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Company</th>
            <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Source</th>
            <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">State</th>
            <th scope="col" className="py-3 pr-4 text-sm font-medium text-ink-secondary">Last verified</th>
            <th scope="col" className="py-3 text-right text-sm font-medium text-ink-secondary">
              States seen
            </th>
          </tr>
        </thead>
        <tbody>
          {competitors.flatMap(c =>
            c.sources.map(s => (
              <tr key={`${c.slug}-${s.kind}`} className="border-b border-rule align-top">
                <th scope="row" className="py-4 pr-4 font-display text-lg font-medium text-ink">
                  {c.name}
                </th>
                <td className="py-4 pr-4">
                  <a
                    href={s.url}
                    rel="nofollow noreferrer"
                    className="font-mono text-sm text-ink-secondary underline decoration-rule-strong underline-offset-4 hover:text-ink"
                  >
                    {s.kind}
                  </a>
                  {s.degraded_reason && (
                    <p className="mt-1 max-w-xs text-sm text-state-degraded">{s.degraded_reason}</p>
                  )}
                  {s.current_pricing && s.current_pricing.tiers.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {s.current_pricing.tiers.map(t => (
                        <li key={t.name} className="font-mono text-sm text-ink">
                          <span className="text-ink-secondary">{t.name}</span>{' '}
                          {t.is_free
                            ? <span>Free</span>
                            : t.monthly_price_usd === null
                              ? <span className="text-ink-muted">contact sales</span>
                              : <span>${t.monthly_price_usd}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="py-4 pr-4"><StateBadge state={s.state} /></td>
                <td className="py-4 pr-4"><Stamp iso={s.last_ok_at} /></td>
                <td className="py-4 text-right font-mono text-sm text-ink-secondary">
                  {s.distinct_states}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
