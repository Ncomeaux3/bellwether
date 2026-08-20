import { parse, type HTMLElement } from 'node-html-parser';
import { PRICE_PATTERN } from '../workflow/collect.js';
import { normalizeCloseTags } from './normalize.js';

export interface QualifyVerdict {
  verdict: 'pass' | 'fail';
  reason: string;
  priceMatches: number;
  tierHeadings: number;
  proposedCanary: string | null;
}

/**
 * Calibration set (spec 11.1, 2026-08-18): the six pages already in
 * `competitors.public.ts` (Linear/Notion/Figma/Supabase/Sentry/Postman —
 * each verified with 3-4 priced tiers close together in the raw HTML) plus
 * Vercel (a 24 KB shell that hydrates pricing client-side: ~0 prices, ~0
 * tier headings in raw HTML). Floors of 2 for each signal, plus proximity,
 * cleanly separate the six passes from the Vercel fail without either floor
 * doing so alone — see the two-signal note below.
 */
export const MIN_PRICE_MATCHES = 2;
export const MIN_TIER_HEADINGS = 2;

/**
 * R1: a price and a tier heading must occur within this many characters of
 * each other for the two counts to be "about the same block". Without this,
 * a blog post that mentions a dollar figure once and links to an unrelated
 * "Enterprise" nav item elsewhere on the page would pass on raw counts alone.
 */
export const PROXIMITY_WINDOW_CHARS = 2_000;

/** R2 floor: longer than this reads as body copy, not a tier name. */
export const MAX_HEADING_CHARS = 40;

/**
 * Exact (not substring) matches so a real tier name that happens to contain
 * one of these words — "Enterprise Support", "Business" — is never excluded.
 */
const NAV_BOILERPLATE = new Set([
  'home', 'about', 'about us', 'blog', 'careers', 'contact', 'contact us',
  'contact sales', 'sign in', 'sign up', 'log in', 'login', 'logout',
  'docs', 'documentation', 'support', 'help', 'menu', 'search', 'privacy',
  'privacy policy', 'terms', 'terms of service', 'cookie', 'cookies', 'faq',
  'pricing', 'features', 'products', 'product', 'resources', 'community',
  'status', 'changelog', 'get started', 'try free', 'try for free',
  'book a demo', 'request a demo', 'sales', 'company', 'legal', 'security',
  'partners', 'customers', 'skip to content', 'skip to main content',
]);

const TIER_SELECTOR =
  'h1, h2, h3, h4, [class*="tier"], [class*="plan"], [class*="price"], ' +
  '[id*="tier"], [id*="plan"], [id*="price"]';

function qualifiesAsHeading(text: string): boolean {
  if (text.length === 0 || text.length > MAX_HEADING_CHARS) return false;
  if (!/[a-zA-Z]/.test(text)) return false; // non-numeric: must have a letter
  if (NAV_BOILERPLATE.has(text.toLowerCase())) return false;
  return true;
}

interface HeadingCandidate { text: string; range: readonly [number, number] }

/**
 * A wrapper (`<div class="tier">`) and the heading it wraps (`<h3>Pro</h3>`)
 * both match TIER_SELECTOR, so the raw querySelectorAll result double-counts
 * every heading that sits inside a tier/plan/price-classed container. Keep
 * only the innermost element of any nested pair.
 */
function tierHeadingCandidates(root: HTMLElement): HeadingCandidate[] {
  const matches = root.querySelectorAll(TIER_SELECTOR)
    .map(el => ({ el, text: el.text.replace(/\s+/g, ' ').trim() }))
    .filter(({ text }) => qualifiesAsHeading(text));

  // Drop any candidate that strictly contains another candidate's range —
  // that keeps the innermost (the H2) and discards the wrapper (the DIV).
  return matches
    .filter(({ el }, i) => !matches.some(({ el: other }, j) =>
      i !== j &&
      el.range[0] <= other.range[0] && el.range[1] >= other.range[1] &&
      (el.range[1] - el.range[0]) > (other.range[1] - other.range[0])
    ))
    .map(({ el, text }) => ({ text, range: el.range }));
}

/** PRICE_PATTERN has no /g/ flag (it's also used with .test()); derive a global copy rather than defining a second pattern. */
function priceMatchIndexes(html: string): number[] {
  const re = new RegExp(PRICE_PATTERN.source, 'g');
  return [...html.matchAll(re)].map(m => m.index);
}

function withinProximity(priceIndexes: number[], headings: HeadingCandidate[]): boolean {
  return priceIndexes.some(price => headings.some(h => {
    const distance = price < h.range[0] ? h.range[0] - price
      : price > h.range[1] ? price - h.range[1]
      : 0;
    return distance <= PROXIMITY_WINDOW_CHARS;
  }));
}

/** Longest qualifying heading with no digit — a canary must survive a legitimate price change. */
function pickCanary(headings: HeadingCandidate[]): string | null {
  const noDigit = headings.filter(h => !/\d/.test(h.text));
  if (noDigit.length === 0) return null;
  return noDigit.reduce((longest, h) => h.text.length > longest.text.length ? h : longest).text;
}

/**
 * Spec 11.2: fetch once, count currency symbols and tier-like headings
 * present in the raw HTML, emit a verdict plus a proposed canary. Pure and
 * synchronous — all network/IO lives in the workflow layer.
 *
 * Counts run over the raw markup (post whitespace-closer fix), not the
 * rendered text: a client-hydrated shell's prices live only in a JS bundle,
 * never in the HTML the server actually sent, which is exactly the
 * distinction this screen exists to make (Vercel).
 */
export function scoreCandidate(rawHtml: string): QualifyVerdict {
  const html = normalizeCloseTags(rawHtml);

  const priceIndexes = priceMatchIndexes(html);
  const priceMatches = priceIndexes.length;

  const root = parse(html, { comment: false });
  const headings = tierHeadingCandidates(root);
  const tierHeadings = headings.length;

  const proposedCanary = pickCanary(headings);

  const hasPrices = priceMatches >= MIN_PRICE_MATCHES;
  const hasHeadings = tierHeadings >= MIN_TIER_HEADINGS;
  const proximate = hasPrices && hasHeadings && withinProximity(priceIndexes, headings);

  if (hasPrices && hasHeadings && proximate) {
    return {
      verdict: 'pass',
      reason: `${priceMatches} price matches and ${tierHeadings} tier-like headings, ` +
        `within ${PROXIMITY_WINDOW_CHARS} chars of each other`,
      priceMatches, tierHeadings, proposedCanary,
    };
  }

  const missing: string[] = [];
  if (!hasPrices) missing.push(`fewer than ${MIN_PRICE_MATCHES} price matches (found ${priceMatches})`);
  if (!hasHeadings) missing.push(`fewer than ${MIN_TIER_HEADINGS} tier-like headings (found ${tierHeadings})`);
  if (hasPrices && hasHeadings && !proximate) {
    missing.push(`no price fell within ${PROXIMITY_WINDOW_CHARS} chars of a tier heading`);
  }

  return { verdict: 'fail', reason: missing.join('; '), priceMatches, tierHeadings, proposedCanary };
}
