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
  // Consecutive `User-agent:` lines (no rule line between them) name one
  // shared group. A rule line closes the group; the next `User-agent:`
  // line starts a fresh one. Without this, `current = [agent]` on every
  // User-agent line would attach a group's rules only to the last agent
  // named in it.
  let collectingAgents = false;

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
      if (collectingAgents) {
        current.push(agent);
      } else {
        current = [agent];
        collectingAgents = true;
      }
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    if (value === '') continue;

    collectingAgents = false;

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

/**
 * Compiles a robots.txt pattern into a matcher implementing the standard's
 * wildcard semantics: `*` matches any sequence of characters (including
 * none), and a trailing `$` anchors the match to the end of the path.
 * Every other character is matched literally.
 */
function compilePattern(pattern: string): RegExp {
  const hasEndAnchor = pattern.endsWith('$');
  const body = hasEndAnchor ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${hasEndAnchor ? '$' : ''}`);
}

/** Longest matching rule wins (by pattern length); Allow beats Disallow at equal length. */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  const longest = (patterns: string[]): number => {
    let best = -1;
    for (const p of patterns) {
      if (compilePattern(p).test(path) && p.length > best) best = p.length;
    }
    return best;
  };

  const allow = longest(rules.allow);
  const disallow = longest(rules.disallow);

  if (disallow === -1) return true;
  return allow >= disallow;
}
