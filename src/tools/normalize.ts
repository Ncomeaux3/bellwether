import { parse, type HTMLElement } from 'node-html-parser';
import { sha256 } from './hash.js';

/** Any currency symbol immediately followed by a digit. */
const PRICE = /[$€£]\s?\d/g;

/** Elements whose content is never pricing. Matched against class and id. */
const NOISE_PATTERN =
  /(cookie|consent|gdpr|intercom|drift|zendesk|crisp|chat-widget|livechat|banner-notice)/i;

const STRIP_TAGS = ['script', 'style', 'svg', 'noscript', 'iframe', 'template', 'nav', 'header', 'footer'];

function countPrices(text: string): number {
  return (text.match(PRICE) ?? []).length;
}

function stripNoise(root: HTMLElement): void {
  for (const tag of STRIP_TAGS) {
    for (const el of root.querySelectorAll(tag)) el.remove();
  }
  // No attribute stripping here: HTMLElement.text never includes attribute
  // values (verified: parse('<div id="x" nonce="y">visible</div>').text ===
  // 'visible'), so build hashes, nonces, and cache-busters in attributes
  // already can't reach normalizedHash. Only class/id are read below to
  // decide removal, and only element text ever feeds the hash. Would become
  // necessary again if slicing ever switched to outerHTML.
  for (const el of root.querySelectorAll('*')) {
    const marker = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`;
    if (NOISE_PATTERN.test(marker)) el.remove();
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

  const DENSITY_THRESHOLD = 0.8;

  let current = root;
  for (;;) {
    const heir = current.childNodes
      .filter((n): n is HTMLElement => 'querySelectorAll' in n)
      .find(child => countPrices(child.text) >= total * DENSITY_THRESHOLD);
    if (!heir) return current;
    current = heir;
  }
}

/**
 * Bounded by worst-case token density, not average. Ordinary prose tokenizes
 * at roughly 0.28 tokens/char, but Linear's mangled markup measured at
 * roughly 0.53 tokens/char — nearly double. At 40k chars that pushed Linear
 * to 21,355 tokens, over the 20,000-token extraction guard. 30k chars keeps
 * Linear around 16k tokens (~20% under budget) while still giving a normal
 * page roughly 8.5k tokens of pricing content. Raise this only after
 * measuring token density on the densest known page, not the average one.
 */
const MAX_SLICE_CHARS = 30_000;

/**
 * Deterministic last-resort cap for pages where density-descent stops near
 * the root (prices spread across siblings on some DOMs) and still hands back
 * more than the token budget can take. Picks the contiguous MAX_SLICE_CHARS
 * window with the most currency matches instead of an arbitrary truncation.
 *
 * ponytail: stride-40000/8 scan is O(n) but coarse — it can miss the true
 * best window by up to one stride and never checks the exact tail window.
 * Fine for a deterministic safety net; upgrade to an exact O(n) sliding-window
 * count if a page ever needs pixel-perfect window selection.
 */
function densestWindow(text: string, size: number): string {
  if (text.length <= size) return text;
  const stride = Math.max(1, Math.floor(size / 8));
  let bestStart = 0;
  let bestCount = -1;
  for (let start = 0; start + size <= text.length; start += stride) {
    const count = countPrices(text.slice(start, start + size));
    if (count > bestCount) {
      bestCount = count;
      bestStart = start;
    }
  }
  return text.slice(bestStart, bestStart + size);
}

export interface SliceResult { text: string; normalizedHash: string }

/**
 * Strip volatile noise, slice to the pricing block, collapse whitespace, hash.
 * Never throws — node-html-parser tolerates malformed input, and a page we
 * cannot parse must degrade rather than crash the pipeline.
 */
/**
 * node-html-parser handles block-text elements (script/style/pre/noscript) by
 * scanning for the EXACT literal closer via indexOf — `</style>` and nothing
 * else. A closer written with whitespace before the `>` (Linear's formatted
 * shadow-DOM CSS emits `</style\n\t\t\t>`) is invisible to that scan, so the
 * parser swallows everything up to the next literal closer — or EOF — as one
 * giant text node. On Linear's archived captures that turned 1.19 MB of the
 * document into unstructured text, slicing degraded to "densest 30k window of
 * a JSON payload", and every extraction came back wrong. Proven with a
 * 60-byte reproduction: `<div>A</div><style>x</style\n><div>B</div>` parses
 * to ONE div. Normalizing the closers before parse is the whole fix.
 */
const WHITESPACE_CLOSER = /<\/(script|style|pre|noscript|textarea|template|title)\s+>/gi;

/**
 * Rewrites a block-text closer with whitespace before the `>` (e.g.
 * `</style\n\t>`) to the exact literal node-html-parser scans for. Exported
 * so any other raw-HTML consumer (qualify) gets the same fix instead of
 * re-deriving it and risking a second, subtly different regex.
 */
export function normalizeCloseTags(html: string): string {
  return html.replace(WHITESPACE_CLOSER, '</$1>');
}

export function normalizeAndSlice(html: string, opts: { widen?: boolean } = {}): SliceResult {
  // Comments are removed at parse time; `comment: false` is the default but is
  // stated explicitly because the noisy fixture asserts on it.
  const root = parse(normalizeCloseTags(html), { comment: false });
  stripNoise(root);

  const body = root.querySelector('body') ?? root;
  const region = opts.widen ? body : slice(body);

  let text = region.text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_SLICE_CHARS) text = densestWindow(text, MAX_SLICE_CHARS);
  return { text, normalizedHash: sha256(text) };
}
