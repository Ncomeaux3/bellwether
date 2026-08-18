import { describe, expect, it } from 'vitest';
import { isPathAllowed, parseRobots } from '../src/tools/robots.js';

const SAMPLE = `
User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /admin
Disallow: /internal/
Allow: /internal/public

Sitemap: https://example.test/sitemap.xml
`;

describe('parseRobots', () => {
  it('uses the wildcard group when our token has no group', () => {
    const rules = parseRobots(SAMPLE, 'Bellwether');
    expect(rules.disallow).toContain('/admin');
    expect(rules.allow).toContain('/internal/public');
  });

  it('prefers a group naming our token over the wildcard', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: Bellwether\nDisallow: /nope\n',
      'Bellwether'
    );
    expect(rules.disallow).toEqual(['/nope']);
  });

  it('treats an empty file as fully permissive', () => {
    const rules = parseRobots('', 'Bellwether');
    expect(rules.disallow).toEqual([]);
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobots('# comment\nUser-agent: *\n\n  Disallow: /x  \n', 'Bellwether');
    expect(rules.disallow).toEqual(['/x']);
  });

  it('applies a group\'s rules to every agent named by consecutive User-agent lines', () => {
    const rules = parseRobots(
      'User-agent: BadBot\nUser-agent: Bellwether\nDisallow: /shared\n',
      'Bellwether'
    );
    expect(rules.disallow).toEqual(['/shared']);
  });
});

describe('isPathAllowed', () => {
  const rules = parseRobots(SAMPLE, 'Bellwether');

  it('allows a path no rule matches', () => {
    expect(isPathAllowed(rules, '/pricing')).toBe(true);
  });

  it('blocks a disallowed prefix', () => {
    expect(isPathAllowed(rules, '/admin/users')).toBe(false);
  });

  it('lets a longer Allow override a shorter Disallow', () => {
    expect(isPathAllowed(rules, '/internal/public/doc')).toBe(true);
    expect(isPathAllowed(rules, '/internal/secret')).toBe(false);
  });

  it('blocks everything under a bare Disallow: /', () => {
    const all = parseRobots('User-agent: *\nDisallow: /\n', 'Bellwether');
    expect(isPathAllowed(all, '/pricing')).toBe(false);
  });

  it('blocks a wildcard Disallow — a literal-only matcher would under-block here', () => {
    const wildcard = parseRobots('User-agent: *\nDisallow: /*/pricing\n', 'Bellwether');
    expect(isPathAllowed(wildcard, '/en/pricing')).toBe(false);
    expect(isPathAllowed(wildcard, '/fr/pricing')).toBe(false);
    expect(isPathAllowed(wildcard, '/pricing')).toBe(true);
  });

  it('anchors a $-terminated rule to the end of the path', () => {
    const anchored = parseRobots('User-agent: *\nDisallow: /pricing.json$\n', 'Bellwether');
    expect(isPathAllowed(anchored, '/pricing.json')).toBe(false);
    expect(isPathAllowed(anchored, '/pricing.json.bak')).toBe(true);
    expect(isPathAllowed(anchored, '/pricing.jsonx')).toBe(true);
  });
});
