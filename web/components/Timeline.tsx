import type { TimelineCompetitor } from '@/lib/types';

const WIDTH = 720;
const HEIGHT = 132;
const PAD_X = 8;
const PAD_Y = 14;
const SERIES_COLORS = [
  'var(--color-series-1)', 'var(--color-series-2)', 'var(--color-series-3)',
  'var(--color-series-4)', 'var(--color-series-5)',
];

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

  const x = (iso: string) =>
    PAD_X + (tMax === tMin ? 0 : (Date.parse(iso) - tMin) / (tMax - tMin)) * (WIDTH - PAD_X * 2);
  const y = (price: number) =>
    HEIGHT - PAD_Y - (pMax === pMin ? 0.5 : (price - pMin) / (pMax - pMin)) * (HEIGHT - PAD_Y * 2);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={
          `${competitor.name} monthly prices from ${month(competitor.first_observed_at!)} ` +
          `to ${month(competitor.last_observed_at!)}, ${money(pMin)} to ${money(pMax)}.`
        }
      >
        {competitor.markers.map(marker => (
          <line
            key={`${marker.observed_at}-${marker.label}`}
            x1={x(marker.observed_at)} x2={x(marker.observed_at)}
            y1={PAD_Y - 6} y2={HEIGHT - PAD_Y + 6}
            stroke="var(--color-rule-strong)" strokeWidth="1" strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {competitor.series.map((s, i) =>
          s.segments.map((segment, j) => (
            <g key={`${s.tier}-${j}`}>
              <polyline
                points={segment.map(p => `${x(p.observed_at)},${y(p.price)}`).join(' ')}
                fill="none" stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              {segment.map(p => (
                <circle
                  key={p.observed_at} cx={x(p.observed_at)} cy={y(p.price)} r="2.5"
                  fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                />
              ))}
            </g>
          )),
        )}
      </svg>

      <figcaption className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 font-mono text-xs text-ink-muted">
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          {competitor.series.map((s, i) => {
            const last = s.segments[s.segments.length - 1]?.at(-1);
            return (
              <span key={s.tier} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                />
                <span className="text-ink-secondary">{s.tier}</span>
                {last && <span>{money(last.price)}</span>}
              </span>
            );
          })}
        </span>
        <span>
          {month(competitor.first_observed_at!)} to {month(competitor.last_observed_at!)}
          {' · '}{money(pMin)}-{money(pMax)}
        </span>
      </figcaption>
    </figure>
  );
}
