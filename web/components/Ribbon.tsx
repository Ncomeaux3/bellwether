import { stepPoints } from '@/lib/data';
import type { TierClass, TimelineCompetitor, TimelineMarker, TimelinePoint, TimelineSeries } from '@/lib/types';

// Spec 14.3: "One primitive at three scales is what makes fifty companies
// legible on a single screen." Row = a table-cell-height band (ticks +
// notches, no text). Hero = full price chart with a ticks/notches band
// beneath it, labelled. Spark = the price line alone, no decoration.
export type RibbonScale = 'row' | 'hero' | 'spark';

// Spec 14.3: color encodes tier rung, in fixed ordinal order, never a
// competitor or a cycled index. tier_class is computed once in the exporter
// (src/workflow/export.ts) so this component holds no judgement about it.
const TIER_COLORS: Record<TierClass, string> = {
  free: 'var(--color-series-free)',
  entry: 'var(--color-series-entry)',
  mid: 'var(--color-series-mid)',
  enterprise: 'var(--color-series-enterprise)',
};

// Spec 14.3: the diverging pair's only sanctioned use — whether a confirmed
// change was a price increase, decrease, or (a non-numeric change) neutral.
const DIRECTION_COLORS = {
  rise: 'var(--color-rise)',
  fall: 'var(--color-fall)',
  flat: 'var(--color-flat)',
} as const;
type Direction = keyof typeof DIRECTION_COLORS;

const money = (n: number) => (n === 0 ? '$0' : `$${n.toLocaleString('en-US')}`);
const month = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

// The exporter (src/workflow/export.ts) ships TimelineMarker as
// { observed_at, label } — a formatted string, not raw before/after numbers.
// Adding a numeric field is outside this task's touched-files list, so
// direction is read back out of describeChange()'s own grammar instead:
// every price_changed label it emits ends in "<number> to <number>"
// ("Basic 8 to 10"); tier added/removed, seats/billing changes, and a
// "none" (contact-sales) side don't match, and correctly fall to neutral.
const PRICE_CHANGE_RE = /(-?\d+(?:\.\d+)?)\s+to\s+(-?\d+(?:\.\d+)?)$/;

function parseMarker(marker: TimelineMarker): { direction: Direction; displayLabel: string } {
  const match = PRICE_CHANGE_RE.exec(marker.label);
  if (!match) return { direction: 'flat', displayLabel: marker.label };
  const before = Number(match[1]);
  const after = Number(match[2]);
  return {
    direction: after > before ? 'rise' : after < before ? 'fall' : 'flat',
    displayLabel: `${money(before)} → ${money(after)}`,
  };
}

const lastPointOf = (s: TimelineSeries): TimelinePoint | undefined => s.segments[s.segments.length - 1]?.at(-1);

const HERO = {
  width: 720, height: 160,
  padX: 8, rightPadPlain: 8, rightPadLabels: 74,
  chartTop: 10, chartBottom: 96,
  bandY: 112, labelY: 132, dateY: 146,
};
const ROW = { width: 200, height: 28, padX: 4, bandY: 14 };
const SPARK = { width: 120, height: 28, padX: 2, chartTop: 3, chartBottom: 25 };

export function Ribbon({ competitor, scale }: { competitor: TimelineCompetitor; scale: RibbonScale }) {
  const points = competitor.series.flatMap(s => s.segments.flat());

  // Counted in DISTINCT MOMENTS, not points. A competitor observed once but
  // priced across four tiers has four points and no line — every x collapses
  // onto one coordinate and the chart is a meaningless column of dots. A line
  // needs two moments in time, and saying so is more useful than an empty box.
  const moments = new Set(points.map(p => p.observed_at)).size;
  if (moments < 2) {
    if (scale !== 'hero') return null;
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

  // Log scale: log10(1 + price) handles the $0 free tier (log10(1) = 0)
  // without a special case. Carried forward from Timeline.tsx.
  const logScale = (price: number) => Math.log10(1 + price);
  const sMin = logScale(pMin);
  const sMax = logScale(pMax);

  const xScale = (left: number, right: number) => (iso: string) =>
    left + (tMax === tMin ? 0 : (Date.parse(iso) - tMin) / (tMax - tMin)) * (right - left);
  const yScale = (top: number, bottom: number) => (price: number) =>
    bottom - (sMax === sMin ? 0.5 : (logScale(price) - sMin) / (sMax - sMin)) * (bottom - top);

  const distinctMoments = [...new Set(points.map(p => p.observed_at))].sort(
    (a, b) => Date.parse(a) - Date.parse(b),
  );

  if (scale === 'spark') {
    const x = xScale(SPARK.padX, SPARK.width - SPARK.padX);
    const y = yScale(SPARK.chartTop, SPARK.chartBottom);
    return (
      <svg viewBox={`0 0 ${SPARK.width} ${SPARK.height}`} className="h-auto w-full" aria-hidden="true">
        {competitor.series.map(s =>
          s.segments.map((segment, j) => (
            <polyline
              key={`${s.tier}-${j}`}
              points={stepPoints(segment).map(p => `${x(p.observed_at)},${y(p.price)}`).join(' ')}
              fill="none" stroke={TIER_COLORS[s.tier_class]}
              strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )),
        )}
      </svg>
    );
  }

  if (scale === 'row') {
    const x = xScale(ROW.padX, ROW.width - ROW.padX);
    const ariaLabel =
      `${competitor.name}: ${moments} observations` +
      (competitor.markers.length > 0
        ? `, ${competitor.markers.length} confirmed change${competitor.markers.length === 1 ? '' : 's'}.`
        : '.');
    return (
      <svg viewBox={`0 0 ${ROW.width} ${ROW.height}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
        <g tabIndex={0}>
          <title>{`${moments} observations, ${month(competitor.first_observed_at!)} to ${month(competitor.last_observed_at!)}`}</title>
          <rect x="0" y="0" width={ROW.width} height={ROW.height} fill="transparent" />
          <line
            x1={ROW.padX} x2={ROW.width - ROW.padX} y1={ROW.bandY} y2={ROW.bandY}
            stroke="var(--color-rule)" strokeWidth="1" vectorEffect="non-scaling-stroke"
          />
          {distinctMoments.map(iso => (
            <line
              key={iso} x1={x(iso)} x2={x(iso)} y1={ROW.bandY - 3} y2={ROW.bandY + 3}
              stroke="var(--color-rule-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        {competitor.markers.map(marker => {
          const { direction, displayLabel } = parseMarker(marker);
          const mx = x(marker.observed_at);
          return (
            <g key={`${marker.observed_at}-${marker.label}`}>
              <title>{displayLabel}</title>
              <rect
                x={mx - 5} y="0" width="10" height={ROW.height} fill="transparent"
                tabIndex={0}
              />
              <line
                x1={mx} x2={mx} y1={ROW.bandY - 8} y2={ROW.bandY + 8}
                stroke={DIRECTION_COLORS[direction]} strokeWidth="2" vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>
    );
  }

  // Hero. Spec: legend at two-or-more series, direct labels preferred at
  // four-or-fewer — check the last plotted point of every series for a
  // y-collision before committing to direct labels, so two tiers priced
  // within a few px of each other don't print overlapping text.
  const yPrice = yScale(HERO.chartTop, HERO.chartBottom);
  const seriesCount = competitor.series.length;
  let useDirectLabels = seriesCount >= 1 && seriesCount <= 4;
  if (useDirectLabels && seriesCount >= 2) {
    const MIN_GAP = 12;
    const ys = competitor.series
      .map(lastPointOf)
      .filter((p): p is TimelinePoint => p !== undefined)
      .map(p => yPrice(p.price))
      .sort((a, b) => a - b);
    if (ys.some((v, i) => i > 0 && v - ys[i - 1]! < MIN_GAP)) useDirectLabels = false;
  }
  const useLegend = !useDirectLabels;

  const plotRight = HERO.width - (useDirectLabels ? HERO.rightPadLabels : HERO.rightPadPlain);
  const x = xScale(HERO.padX, plotRight);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${HERO.width} ${HERO.height}`}
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
        <g tabIndex={0}>
          <title>{`${moments} observations, ${month(competitor.first_observed_at!)} to ${month(competitor.last_observed_at!)}`}</title>
          <rect x={HERO.padX} y={HERO.bandY - 8} width={plotRight - HERO.padX} height={16} fill="transparent" />
          <line
            x1={HERO.padX} x2={plotRight} y1={HERO.bandY} y2={HERO.bandY}
            stroke="var(--color-rule)" strokeWidth="1" vectorEffect="non-scaling-stroke"
          />
          {distinctMoments.map(iso => (
            <line
              key={iso} x1={x(iso)} x2={x(iso)} y1={HERO.bandY - 3} y2={HERO.bandY + 3}
              stroke="var(--color-rule-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>

        {competitor.markers.map(marker => {
          const { direction, displayLabel } = parseMarker(marker);
          const mx = x(marker.observed_at);
          return (
            <g key={`${marker.observed_at}-${marker.label}`}>
              <title>{marker.label}</title>
              <rect
                x={mx - 6} y={HERO.chartTop} width="12" height={HERO.bandY - HERO.chartTop + 8}
                fill="transparent" tabIndex={0}
              />
              <line
                x1={mx} x2={mx} y1={HERO.chartTop} y2={HERO.bandY + 6}
                stroke={DIRECTION_COLORS[direction]} strokeWidth="2" vectorEffect="non-scaling-stroke"
              />
              <text x={mx} y={HERO.labelY} textAnchor="middle" fontSize="11" fill="var(--color-ink-secondary)" className="font-mono">
                {displayLabel}
              </text>
              <text x={mx} y={HERO.dateY} textAnchor="middle" fontSize="11" fill="var(--color-ink-muted)" className="font-mono">
                {month(marker.observed_at)}
              </text>
            </g>
          );
        })}

        {competitor.series.map(s =>
          s.segments.map((segment, j) => (
            <g key={`${s.tier}-${j}`}>
              <polyline
                points={stepPoints(segment).map(p => `${x(p.observed_at)},${yPrice(p.price)}`).join(' ')}
                fill="none" stroke={TIER_COLORS[s.tier_class]}
                strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              {segment.map(p => (
                <circle
                  key={p.observed_at} cx={x(p.observed_at)} cy={yPrice(p.price)} r="2.5"
                  fill={TIER_COLORS[s.tier_class]}
                />
              ))}
            </g>
          )),
        )}

        {useDirectLabels && competitor.series.map(s => {
          const last = lastPointOf(s);
          if (!last) return null;
          return (
            <text
              key={`label-${s.tier}`} x={plotRight + 6} y={yPrice(last.price) + 4}
              fontSize="11" fill={TIER_COLORS[s.tier_class]} className="font-mono"
            >
              {s.tier}
            </text>
          );
        })}
      </svg>

      {useLegend && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-muted">
          {competitor.series.map(s => {
            const last = lastPointOf(s);
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
        </div>
      )}

      <p className="mt-2 font-mono text-xs text-ink-muted">
        {month(competitor.first_observed_at!)} to {month(competitor.last_observed_at!)}
        {' · '}{money(pMin)}-{money(pMax)} · log scale
      </p>
    </figure>
  );
}
