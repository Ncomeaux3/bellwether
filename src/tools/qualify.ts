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
 * Fix round 8 live evidence: round 7's raw-body check was correct, but its
 * rarity-only preference produced Pinecone -> "Unlimited", Redis Cloud ->
 * "From", Upstash -> "Free", Render -> "Sites", Vercel -> "GB" — genuine raw
 * substrings, but generic fragments that would survive almost any redesign
 * and so can never detect one. And Clerk/Hasura/Resend fell all the way
 * through to null. Rare plus short is meaningless; the missing criterion is
 * SIGNIFICANCE. Selection order below is deliberate: significance first,
 * rarity second — reversing it is how "GB" won.
 *
 * Fix round 9 live evidence: round 8 only considered a plan name if it had
 * ALSO been detected as a heading in the normalized text first — so a plan
 * name present in the raw body but missed by the heading scan (an
 * attribute, a construct HEADING_ADJACENT_TO_PRICE doesn't match) was
 * invisible to it. GitHub, Netlify, and Clerk all had abundant plan names in
 * their raw bodies (GitHub: Enterprise 33x, Professional 1x, Business 2x,
 * Premium 22x, Standard 2x) that never surfaced because of this. Step 1 now
 * scans the raw body directly for every name in PLAN_NAMES, independent of
 * heading detection, and — among the ones present — prefers the FEWEST
 * occurrences: GitHub's Professional(1x) is a far better canary than
 * Enterprise(33x), equally significant and rare enough that losing it is a
 * real signal, not noise. This is the rule fix rounds 7-8 were reaching for:
 * significant AND rare — a plan name, chosen for scarcity.
 */
const PLAN_NAMES = [
  'Enterprise', 'Business', 'Professional', 'Team', 'Starter', 'Growth',
  'Scale', 'Premium', 'Standard', 'Individual', 'Organization', 'Developer',
  'Hobby', 'Solo', 'Basic', 'Plus', 'Pro',
];

/** A fragment shorter than this ("GB", "From") is meaningless as a canary even when rare. */
const MIN_CANARY_LENGTH = 8;

/**
 * 1. Every PLAN_NAMES entry that occurs at least once in the raw body,
 *    scanned directly (not filtered through heading detection — see fix
 *    round 9 above). Among those present, the fewest occurrences wins
 *    (rarer = a more meaningful signal when it disappears); ties break to
 *    the longer name (less likely incidental).
 * 2. Otherwise the round-7 rare-heading rule (prefer occurring 1-2 times in
 *    the raw body; fall back to a more common one only if nothing rare
 *    qualifies), restricted to detected headings at least MIN_CANARY_LENGTH
 *    long.
 * 3. Otherwise null — and null must stay a LOUD result: callers report it
 *    by name (never silently substitute a default, and never emit `''`,
 *    which is a canary that always passes and is worse than no canary).
 */
function pickCanary(headings: string[], rawHtml: string): string | null {
  const plansPresent = PLAN_NAMES
    .map(text => ({ text, count: countOccurrences(rawHtml, text) }))
    .filter(({ count }) => count >= 1);

  if (plansPresent.length > 0) {
    return plansPresent.reduce((best, c) =>
      c.count < best.count || (c.count === best.count && c.text.length > best.text.length) ? c : best
    ).text;
  }

  const candidates = headings
    .filter(h => !/\d/.test(h))
    .map(text => ({ text, count: countOccurrences(rawHtml, text) }))
    .filter(({ count }) => count >= 1); // must actually occur in the raw body collect() will check against

  const longEnough = candidates.filter(c => c.text.length >= MIN_CANARY_LENGTH);
  if (longEnough.length === 0) return null;

  const rare = longEnough.filter(c => c.count <= 2);
  const pool = rare.length > 0 ? rare : longEnough;

  const chosen = pool.reduce((longest, c) => c.text.length > longest.text.length ? c : longest).text;
  return chosen === '' ? null : chosen; // defensive: pickCanary must never return an empty string
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
