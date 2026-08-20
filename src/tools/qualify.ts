import { normalizeAndSlice } from './normalize.js';
import { PRICE_PATTERN } from '../workflow/collect.js';

export interface QualifyVerdict {
  verdict: 'pass' | 'fail';
  reason: string;
  priceMatches: number;
  tierHeadings: number;
  proposedCanary: string | null;
}

/**
 * Fix round 1 (2026-08-20). Live evidence: vercel.com/pricing scored 177 raw
 * price matches (117 inside a <script> JSON blob) against Linear's 11, even
 * though Vercel is the spec's named qualification failure — raw HTML makes a
 * client-rendered page look MORE extractable, because its prices live in a
 * data blob the extractor never sees. Counting now runs over
 * `normalizeAndSlice(raw).text` — the exact text extract.ts feeds the model
 * — which strips <script> along with everything else STRIP_TAGS removes.
 * Measured: Vercel normalized to 55 price matches, not 177.
 *
 * Fix round 2 (2026-08-20). Live evidence: Figma FAILED this pre-filter
 * (0 tier headings found by the round-1 heuristic) while a direct extraction
 * against the very same normalized text returned four priced tiers at high
 * confidence. A pre-filter rejection means `--verify` never runs — silently
 * excluding a source that works today is the worst failure mode this tool
 * has, far worse than spending $0.01 verifying a page with no real tiers.
 * The gate is now price matches ALONE: this pre-filter's only job is to
 * avoid spending on a page with no prices at all. Tier headings are still
 * counted and recorded (useful published signal about the boundary — see
 * spec 11.2) but no longer block a `pass`.
 */
export const MIN_PRICE_MATCHES = 2;
/** Recorded, no longer gates — see fix round 2 above. */
export const MIN_TIER_HEADINGS = 2;

/**
 * ponytail: recorded signal only (fix round 2), not a gate. "Tier heading"
 * means a short capitalized run with NO characters between it and a
 * following price in the flattened text — e.g. `Basic$10`, which is exactly
 * how node-html-parser's `.text` concatenates two sibling elements
 * (`<h2>Basic</h2><p>$10</p>`) that had no whitespace between them in the
 * source. A feature-matrix line item always has punctuation in between
 * ("SAML SSO — $300/mo") and never matches; a real tier with no visible
 * price ("Enterprise: Contact us") never matches either. Both are expected
 * undercounts for a signal that is no longer load-bearing.
 */
const HEADING_ADJACENT_TO_PRICE = /([A-Z][a-zA-Z]{1,24})(?=[$€£]\s?\d)/g;

/** Exact (not substring) matches so a real tier name that happens to contain one of these words is never excluded. */
const NAV_BOILERPLATE = new Set([
  'home', 'about', 'blog', 'careers', 'contact', 'sign in', 'sign up',
  'log in', 'login', 'logout', 'docs', 'documentation', 'support', 'help',
  'menu', 'search', 'privacy', 'terms', 'cookie', 'cookies', 'faq',
  'pricing', 'features', 'products', 'product', 'resources', 'community',
  'status', 'changelog', 'sales', 'company', 'legal', 'security',
  'partners', 'customers',
]);

function qualifiesAsHeading(text: string): boolean {
  return !NAV_BOILERPLATE.has(text.toLowerCase());
}

function findTierHeadings(text: string): string[] {
  return [...text.matchAll(HEADING_ADJACENT_TO_PRICE)]
    .map(m => m[1]!)
    .filter(qualifiesAsHeading);
}

/** PRICE_PATTERN has no /g/ flag (it's also used with .test()); derive a global copy rather than defining a second pattern. */
function countPriceMatches(text: string): number {
  const re = new RegExp(PRICE_PATTERN.source, 'g');
  return (text.match(re) ?? []).length;
}

function countOccurrences(haystack: string, needle: string): number {
  return needle === '' ? 0 : haystack.split(needle).length - 1;
}

/**
 * INVARIANT: `collect.ts`'s `healthProblem` checks a source's canary against
 * the RAW response body it just fetched — not any normalized or sliced
 * representation of it. A canary must therefore be selected against the raw
 * body too, or it can never be found there and the source degrades on its
 * first fetch, permanently. This is the same bug class that keeps recurring
 * here (M3's normalizer, M6's timeline/dataset date split): a value derived
 * from one representation of a page, checked against a different one.
 *
 * Fix round 7 live evidence: `normalizeAndSlice`'s whitespace collapsing
 * merges adjacent elements with nothing between them in the source
 * (`<h2>Business</h2><span>Monthly</span>` -> "BusinessMonthlyAnnual" in the
 * flattened text — see HEADING_ADJACENT_TO_PRICE's own doc comment for why
 * that merge happens). That concatenated fragment is a real match in the
 * normalized text but can never occur in the raw HTML, where the tags are
 * still between the words — 9 of 27 admitted sources degraded on their very
 * first collection this way.
 *
 * Longest qualifying heading, preferring one that occurs 1-2 times in the
 * raw body (specific enough to prove nothing changed) over one that occurs
 * many times (boilerplate/nav chrome present on every page, which would
 * still be present after a redesign and so would never catch one).
 */
function pickCanary(headings: string[], rawHtml: string): string | null {
  const candidates = headings
    .filter(h => !/\d/.test(h))
    .map(text => ({ text, count: countOccurrences(rawHtml, text) }))
    .filter(({ count }) => count >= 1); // must actually occur in the raw body collect() will check against

  if (candidates.length === 0) return null;

  const rare = candidates.filter(c => c.count <= 2);
  const pool = rare.length > 0 ? rare : candidates;

  return pool.reduce((longest, c) => c.text.length > longest.text.length ? c : longest).text;
}

/**
 * Spec 11.2 + fix rounds 1-2: fetch once, count currency symbols present in
 * the text `extract` actually consumes, emit a verdict plus a proposed
 * canary. Pure and synchronous — all network/IO lives in the workflow layer.
 *
 * Gates on price matches alone (fix round 2) — recall over precision. A
 * false negative here is silent and permanent (a working source never gets
 * screened again); a false positive costs one $0.01 `--verify` call. Tier
 * headings are still counted and returned as signal but never block a pass.
 */
export function scoreCandidate(rawHtml: string): QualifyVerdict {
  const { text } = normalizeAndSlice(rawHtml);

  const priceMatches = countPriceMatches(text);
  const headings = findTierHeadings(text);
  const tierHeadings = headings.length;
  const proposedCanary = pickCanary(headings, rawHtml);

  if (priceMatches >= MIN_PRICE_MATCHES) {
    return {
      verdict: 'pass',
      reason: `${priceMatches} price matches in the normalized text (${tierHeadings} tier-like headings)`,
      priceMatches, tierHeadings, proposedCanary,
    };
  }

  return {
    verdict: 'fail',
    reason: `fewer than ${MIN_PRICE_MATCHES} price matches (found ${priceMatches})`,
    priceMatches, tierHeadings, proposedCanary,
  };
}
