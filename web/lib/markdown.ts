function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escaped first, so **bold** is the only markup this function can ever add.
const inline = (s: string): string => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

/**
 * Minimal digest-body renderer: paragraphs, ##/### headings, **bold**, and
 * '-' lists. No dependency — every line is HTML-escaped before any markup is
 * added, so a model-generated body can't inject markup of its own.
 */
export function renderMarkdown(md: string): string {
  const html: string[] = [];
  let list: string[] = [];

  const flushList = () => {
    if (list.length === 0) return;
    html.push(`<ul>${list.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`);
    list = [];
  };

  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (line === '') { flushList(); continue; }

    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }

    const item = /^-\s+(.*)$/.exec(line);
    if (item) { list.push(item[1]!); continue; }

    flushList();
    html.push(`<p>${inline(line)}</p>`);
  }
  flushList();

  return html.join('\n');
}
