import type { TierClass, TimelineCompetitor } from '@/lib/types';

const WIDTH = 720;
const HEIGHT = 132;
const PAD_X = 8;
const PAD_Y = 14;
// Spec 14.3: color encodes tier rung, in fixed ordinal order, never a
// competitor or a cycled index. tier_class is computed once in the exporter
// (src/workflow/export.ts) so this component holds no judgement about it.
const TIER_COLORS: Record<TierClass, string> = {
  free: 'var(--color-series-free)',
  entry: 'var(--color-series-entry)',
  mid: 'var(--color-series-mid)',
  enterprise: 'var(--color-series-enterprise)',
};

const money = (n: number) => (n === 0 ? '$0' : `$${n.toLocaleString('en-US')}`);
const month = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function Timeline({ competitor }: { competitor: TimelineCompetitor }) {
  const points = competitor.series.flatMap(s => s.segments.flat());

  // One point cannot be a line, and saying so is more useful than an empty box.
  if (points.length < 2) {
    return (
      <p className="text-sm text-ink-muted">
        Not enough history yet — a line needs at least two observations.
      </p>
    );
  }

  const times = points.map(p => Date.parse(p.observed_at));
  const prices = points.map(p => p.price);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);

  // Log scale: a linear y-axis puts $0/$25/$599 within a few px of each
  // other at the bottom of the plot — a 40% move on the cheap tiers would be
  // invisible. log10(1 + price) handles the $0 free tier (log10(1) = 0)
  // without a special case. Disclosed in the caption below — a log scale
  // that isn't labeled misleads.
  const scale = (price: number) => Math.log10(1 + price);
  const sMin = scale(pMin);
  const sMax = scale(pMax);

  const x = (iso: string) =>
    PAD_X + (tMax === tMin ? 0 : (Date.parse(iso) - tMin) / (tMax - tMin)) * (WIDTH - PAD_X * 2);
  const y = (price: number) =>
    HEIGHT - PAD_Y - (sMax === sMin ? 0.5 : (scale(price) - sMin) / (sMax - sMin)) * (HEIGHT - PAD_Y * 2);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={
          `${competitor.name} monthly prices from ${month(competitor.first_observed_at!)} ` +
          `to ${month(competitor.last_observed_at!)}, ${money(pMin)} to ${money(pMax)}` +
          (competitor.markers.length > 0
            ? `, ${competitor.markers.length} confirmed change${competitor.markers.length === 1 ? '' : 's'}.`
            : '.')
        }
      >
        {competitor.markers.map(marker => (
          <g key={`${marker.observed_at}-${marker.label}`}>
            <title>{marker.label}</title>
            <line
              x1={x(marker.observed_at)} x2={x(marker.observed_at)}
              y1={PAD_Y - 6} y2={HEIGHT - PAD_Y + 6}
              stroke="var(--color-rule-strong)" strokeWidth="1" strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}

        {competitor.series.map(s =>
          s.segments.map((segment, j) => (
            <g key={`${s.tier}-${j}`}>
              <polyline
                points={segment.map(p => `${x(p.observed_at)},${y(p.price)}`).join(' ')}
                fill="none" stroke={TIER_COLORS[s.tier_class]}
                strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              {segment.map(p => (
                <circle
                  key={p.observed_at} cx={x(p.observed_at)} cy={y(p.price)} r="2.5"
                  fill={TIER_COLORS[s.tier_class]}
                />
              ))}
            </g>
          )),
        )}
      </svg>

      <figcaption className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 font-mono text-xs text-ink-muted">
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          {competitor.series.map(s => {
            const last = s.segments[s.segments.length - 1]?.at(-1);
            return (
              <span key={s.tier} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: TIER_COLORS[s.tier_class] }}
                />
                <span className="text-ink-secondary">{s.tier}</span>
                {last && <span>{money(last.price)}</span>}
              </span>
            );
          })}
        </span>
        <span>
          {month(competitor.first_observed_at!)} to {month(competitor.last_observed_at!)}
          {' · '}{money(pMin)}-{money(pMax)} · log scale
        </span>
      </figcaption>

      {competitor.markers.length > 0 && (
        <ul className="mt-2 list-none space-y-0.5 font-mono text-xs text-ink-muted">
          {competitor.markers.map(marker => (
            <li key={`${marker.observed_at}-${marker.label}`}>
              {month(marker.observed_at)} · {marker.label}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
