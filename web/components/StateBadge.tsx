import type { SourceState } from '@/lib/types';

const PRESENTATION: Record<SourceState, { label: string; glyph: string; className: string }> = {
  ok:       { label: 'Verified',  glyph: '●', className: 'text-state-ok' },
  degraded: { label: 'Degraded',  glyph: '◐', className: 'text-state-degraded' },
  failing:  { label: 'Failing',   glyph: '○', className: 'text-state-failing' },
  pending:  { label: 'Not yet checked', glyph: '·', className: 'text-ink-muted' },
};

export function StateBadge({ state }: { state: SourceState }) {
  const { label, glyph, className } = PRESENTATION[state];
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-sm ${className}`}>
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </span>
  );
}
