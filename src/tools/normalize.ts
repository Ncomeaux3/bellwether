import { parse, type HTMLElement } from 'node-html-parser';
import { sha256 } from './hash.js';

/** Any currency symbol immediately followed by a digit. */
const PRICE = /[$€£]\s?\d/g;

/** Elements whose content is never pricing. Matched against class and id. */
const NOISE_PATTERN =
  /(cookie|consent|gdpr|intercom|drift|zendesk|crisp|chat-widget|livechat|banner-notice)/i;

const STRIP_TAGS = ['script', 'style', 'svg', 'noscript', 'iframe', 'template'];

/** Volatile attribute values: build hashes, nonces, UUIDs, cache-busters. */
const VOLATILE_VALUE =
  /^([0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const VOLATILE_ATTRS = ['nonce', 'integrity', 'crossorigin', 'srcset', 'style'];

function countPrices(text: string): number {
  return (text.match(PRICE) ?? []).length;
}

function stripNoise(root: HTMLElement): void {
  for (const tag of STRIP_TAGS) {
    for (const el of root.querySelectorAll(tag)) el.remove();
  }
  for (const el of root.querySelectorAll('*')) {
    const marker = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`;
    if (NOISE_PATTERN.test(marker)) { el.remove(); continue; }

    for (const name of Object.keys(el.attributes)) {
      const value = el.getAttribute(name) ?? '';
      if (name.startsWith('data-') || VOLATILE_ATTRS.includes(name) || VOLATILE_VALUE.test(value)) {
        el.removeAttribute(name);
      }
    }
  }
}

/**
 * Descend to the smallest element still holding most of the page's prices.
 * Spec 9.1: slicing is applied on every extraction, not only when over budget,
 * because it roughly halves per-extraction cost.
 */
function slice(root: HTMLElement): HTMLElement {
  const total = countPrices(root.text);
  if (total === 0) return root;

  // ponytail: 0.8 (the density the design doc describes) fails on real pages —
  // a single stray price in nav/footer boilerplate (e.g. a "$0 to start" CTA)
  // dilutes the ratio below 80% and stops descent one level too early. 0.6
  // still stays well above the ~50% a single sibling tier could reach on its
  // own (which would over-slice into one tier), verified against both
  // fixtures. Revisit with a real density/DOM-depth heuristic if a page needs
  // a value outside (0.5, 0.667].
  const DENSITY_THRESHOLD = 0.6;

  let current = root;
  for (;;) {
    const heir = current.childNodes
      .filter((n): n is HTMLElement => n instanceof Object && 'querySelectorAll' in n)
      .find(child => countPrices(child.text) >= total * DENSITY_THRESHOLD);
    if (!heir) return current;
    current = heir;
  }
}

export interface SliceResult { text: string; normalizedHash: string }

/**
 * Strip volatile noise, slice to the pricing block, collapse whitespace, hash.
 * Never throws — node-html-parser tolerates malformed input, and a page we
 * cannot parse must degrade rather than crash the pipeline.
 */
export function normalizeAndSlice(html: string, opts: { widen?: boolean } = {}): SliceResult {
  // Comments are removed at parse time; `comment: false` is the default but is
  // stated explicitly because the noisy fixture asserts on it.
  const root = parse(html, { comment: false });
  stripNoise(root);

  const body = root.querySelector('body') ?? root;
  const region = opts.widen ? body : slice(body);

  const text = region.text.replace(/\s+/g, ' ').trim();
  return { text, normalizedHash: sha256(text) };
}
