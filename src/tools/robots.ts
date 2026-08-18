export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

/**
 * Minimal robots.txt parser — deliberately dependency-free.
 * Picks the group naming our token if present, otherwise the wildcard group.
 */
export function parseRobots(text: string, agentToken: string): RobotsRules {
  const groups = new Map<string, RobotsRules>();
  let current: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      const agent = value.toLowerCase();
      if (!groups.has(agent)) groups.set(agent, { allow: [], disallow: [] });
      current = [agent];
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    if (value === '') continue;

    for (const agent of current) {
      const group = groups.get(agent);
      if (!group) continue;
      if (field === 'allow') group.allow.push(value);
      else group.disallow.push(value);
    }
  }

  return groups.get(agentToken.toLowerCase())
    ?? groups.get('*')
    ?? { allow: [], disallow: [] };
}

/** Longest matching rule wins; Allow beats Disallow at equal length. */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  const longest = (patterns: string[]): number => {
    let best = -1;
    for (const p of patterns) {
      if (path.startsWith(p) && p.length > best) best = p.length;
    }
    return best;
  };

  const allow = longest(rules.allow);
  const disallow = longest(rules.disallow);

  if (disallow === -1) return true;
  return allow >= disallow;
}
