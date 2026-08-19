import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeAndSlice } from '../src/tools/normalize.js';

const fixture = (n: string) => readFileSync(join(process.cwd(), 'tests/fixtures', n), 'utf8');

describe('normalizeAndSlice', () => {
  it('keeps tier names and prices', () => {
    const { text } = normalizeAndSlice(fixture('pricing-simple.html'));
    for (const s of ['Free', 'Pro', 'Enterprise', '$0', '$20', 'Contact sales']) {
      expect(text).toContain(s);
    }
  });

  it('strips scripts, styles, svg, and comments', () => {
    const { text } = normalizeAndSlice(fixture('pricing-noisy.html'));
    expect(text).not.toContain('__DATA__');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('M1 1 L2 2');
    expect(text).not.toContain('build 2026-08-18');
  });

  it('strips cookie banners and chat widgets', () => {
    const { text } = normalizeAndSlice(fixture('pricing-noisy.html'));
    expect(text).not.toContain('We use cookies');
    expect(text).not.toContain('Chat with us');
  });

  it('slices away nav and footer, keeping the pricing block', () => {
    const { text } = normalizeAndSlice(fixture('pricing-noisy.html'));
    expect(text).not.toContain('Home');
    expect(text).not.toContain('© 2026 Example');
    expect(text).toContain('$20');
  });

  it('hash ignores everything STRIP_TAGS/NOISE_PATTERN remove, but reacts to a real price change in main', () => {
    const original = fixture('pricing-noisy.html');
    const a = normalizeAndSlice(original);

    // Mutate content that would only reach .text if STRIP_TAGS (script, nav,
    // footer) and NOISE_PATTERN (cookie-banner, intercom-widget) were not
    // doing their job: the script body, the nav link text, the cookie-banner
    // copy, the chat-widget copy, and the footer text (including its own
    // stray price) — none of this is reachable via attributes, so it proves
    // the tag/class removal itself, not the (now-deleted) attribute logic.
    const noiseMutated = original
      .replace(
        'window.__DATA__={build:"9f2a1c4d8e7b6a5f4321"};',
        'window.__DATA__={build:"totally different script body"};',
      )
      .replace('>Home<', '>Away<')
      .replace('We use cookies.', 'We absolutely love cookies.')
      .replace('Chat with us', 'Talk to our team right now')
      .replace('© 2026 Example. Pay $0 to start.', '© 2099 Nobody. Pay $77 to start.');
    const b = normalizeAndSlice(noiseMutated);
    expect(b.normalizedHash).toBe(a.normalizedHash);

    // Paired case: main is never stripped, so a real price change there must
    // still change the hash.
    const priceMutated = original.replace('$20/mo', '$24/mo');
    const c = normalizeAndSlice(priceMutated);
    expect(c.normalizedHash).not.toBe(a.normalizedHash);
  });

  it('produces a different hash when a price changes', () => {
    const a = normalizeAndSlice(fixture('pricing-simple.html'));
    const b = normalizeAndSlice(fixture('pricing-simple.html').replace('$20', '$24'));
    expect(b.normalizedHash).not.toBe(a.normalizedHash);
  });

  it('collapses whitespace', () => {
    const { text } = normalizeAndSlice('<body><main>$1   \n\n  $2</main></body>');
    expect(text).not.toMatch(/\s{2,}/);
  });

  it('widen: true returns the whole body', () => {
    const narrow = normalizeAndSlice(fixture('pricing-noisy.html'));
    const wide = normalizeAndSlice(fixture('pricing-noisy.html'), { widen: true });
    expect(wide.text.length).toBeGreaterThan(narrow.text.length);
    expect(wide.text).toContain('Loved by teams everywhere');
  });

  it('falls back to the body when no prices are present', () => {
    const { text } = normalizeAndSlice('<body><main>No prices here at all</main></body>');
    expect(text).toContain('No prices here at all');
  });

  it('never throws on malformed html', () => {
    expect(() => normalizeAndSlice('<div><p>$5<//div>')).not.toThrow();
  });

  it('caps oversized flat text to the densest pricing window', () => {
    const filler = (n: number) => 'x'.repeat(n);
    const cluster = Array.from({ length: 50 }, (_, i) => `$${(i % 9) + 1}`).join(' ');
    // Two lone stray prices, each separated from the dense cluster by more
    // than MAX_SLICE_CHARS (40,000) of filler, so no single 40k window can
    // straddle a stray and the cluster together.
    const html = `<body><main>${filler(50000)} STRAYONE $1 STRAYONE ${filler(45000)}` +
      ` CLUSTERSTART ${cluster} CLUSTEREND ${filler(45000)}` +
      ` STRAYTWO $2 STRAYTWO ${filler(50000)}</main></body>`;

    const { text } = normalizeAndSlice(html);
    expect(text.length).toBeLessThanOrEqual(40_000);
    expect(text).toContain('CLUSTERSTART');
    expect(text).toContain('CLUSTEREND');
    expect(text).not.toContain('STRAYONE');
    expect(text).not.toContain('STRAYTWO');
  });

  it('windowing stays deterministic: identical input hashes identically', () => {
    const filler = (n: number) => 'x'.repeat(n);
    const cluster = Array.from({ length: 50 }, (_, i) => `$${(i % 9) + 1}`).join(' ');
    const html = `<body><main>${filler(50000)} STRAYONE $1 STRAYONE ${filler(45000)}` +
      ` CLUSTERSTART ${cluster} CLUSTEREND ${filler(45000)}` +
      ` STRAYTWO $2 STRAYTWO ${filler(50000)}</main></body>`;

    const a = normalizeAndSlice(html);
    const b = normalizeAndSlice(html);
    expect(b.normalizedHash).toBe(a.normalizedHash);
  });
});
