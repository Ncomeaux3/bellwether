export function Stamp({ iso, empty = 'never' }: { iso: string | null; empty?: string }) {
  if (!iso) return <span className="font-mono text-ink-muted">{empty}</span>;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <span className="font-mono text-ink-muted">{empty}</span>;

  const display = date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  return (
    <time dateTime={iso} className="font-mono text-sm text-ink-secondary whitespace-nowrap">
      {display}
    </time>
  );
}
