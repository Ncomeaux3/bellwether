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
 * Calibration set (spec 11.1): the six pages in competitors.public.ts
 * (3-4 priced tiers each) plus Vercel (prices present as feature line items,
 * real tier names absent from the HTML entirely). Floors of 2 for each
 * signal separate all six from Vercel on normalized text.
 */
export const MIN_PRICE_MATCHES = 2;
export const MIN_TIER_HEADINGS = 2;

/**
 * ponytail: this is a loose PRE-FILTER, not the admission gate — fix round 1
 * dropped the windowed-proximity discriminator this used to have. Tuning a
 * character-distance window to separate a tier table from a feature matrix
 * kept misclassifying real pages at the edges (a false negative on Figma),
 * and the edges are exactly where the dataset's boundary lives. `qualify
 * --verify` (real extraction via extractPricing) is now the authoritative
 * admission gate; this only decides "could this plausibly be a pricing
 * page", cheaply, before spending anything on that.
 *
 * "Tier heading" here means a short capitalized run with NO characters
 * between it and a following price in the flattened text — e.g. `Basic$10`,
 * which is exactly how node-html-parser's `.text` concatenates two sibling
 * elements (`<h2>Basic</h2><p>$10</p>`) that had no whitespace between them
 * in the source. A feature-matrix line item always has punctuation in
 * between ("SAML SSO — $300/mo") and never matches. A real tier with no
 * visible price ("Enterprise: Contact us") also never matches — an accepted
 * false negative for a pre-filter whose job is now recall, not precision.
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

/** Longest qualifying heading with no digit — a canary must survive a legitimate price change. */
function pickCanary(headings: string[]): string | null {
  const noDigit = headings.filter(h => !/\d/.test(h));
  if (noDigit.length === 0) return null;
  return noDigit.reduce((longest, h) => h.length > longest.length ? h : longest);
}

/**
 * Spec 11.2 + fix round 1: fetch once, count currency symbols and tier-like
 * headings present in the text `extract` actually consumes, emit a verdict
 * plus a proposed canary. Pure and synchronous — all network/IO lives in the
 * workflow layer. `pass` here means "worth spending a real extraction on"
 * (`qualify --verify`); it is no longer the admission decision itself.
 */
export function scoreCandidate(rawHtml: string): QualifyVerdict {
  const { text } = normalizeAndSlice(rawHtml);

  const priceMatches = countPriceMatches(text);
  const headings = findTierHeadings(text);
  const tierHeadings = headings.length;
  const proposedCanary = pickCanary(headings);

  const hasPrices = priceMatches >= MIN_PRICE_MATCHES;
  const hasHeadings = tierHeadings >= MIN_TIER_HEADINGS;

  if (hasPrices && hasHeadings) {
    return {
      verdict: 'pass',
      reason: `${priceMatches} price matches and ${tierHeadings} tier-like headings in the normalized text`,
      priceMatches, tierHeadings, proposedCanary,
    };
  }

  const missing: string[] = [];
  if (!hasPrices) missing.push(`fewer than ${MIN_PRICE_MATCHES} price matches (found ${priceMatches})`);
  if (!hasHeadings) missing.push(`fewer than ${MIN_TIER_HEADINGS} tier-like headings (found ${tierHeadings})`);

  return { verdict: 'fail', reason: missing.join('; '), priceMatches, tierHeadings, proposedCanary };
}
