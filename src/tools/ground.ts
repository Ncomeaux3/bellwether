import type { PricingSnapshotData } from '../schema/pricing.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Spec 12.6. `extraction_confidence` is self-reported, and a model confident
 * enough to hallucinate a price is confident enough to report "high". This is
 * the deterministic check that actually holds: a price the model produced but
 * the page never contained is fabricated by construction.
 *
 * Matching is anchored on both sides to a digit-or-decimal-point boundary, so
 * a fabricated "20" cannot hide inside "2026" or inside "20.50" (a different
 * price). A plain substring test would accept both.
 */
function appearsIn(value: number, text: string): boolean {
  const digitsOnly = text.replace(/,/g, '');       // "$1,200" -> "$1200"
  const forms = new Set<string>([
    String(value),
    value.toFixed(2).replace(/\.?0+$/, ''),        // 20.00 -> "20"
    value.toFixed(2),                              // 0.09 -> "0.09"
  ]);
  return [...forms].some(f => {
    const boundary = new RegExp(`(?<![\\d.])${escapeRegExp(f)}(?![\\d.])`);
    return boundary.test(digitsOnly);
  });
}

// Case-fold a literal string into a pattern without the `i` flag, by turning
// each letter into a [xX] class. Needed because the "free"-ending lookahead
// below must stay case-sensitive (see FREE_AFTER) while the tier name still
// has to match regardless of case — a single regex can't mix the two under
// one `i` flag.
function caseInsensitiveLiteral(s: string): string {
  return s.replace(/[a-zA-Z]/g, c => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

// "Free" is itself an assertion that the price is zero — but only when it is
// describing *this* tier. The word appears page-wide in ordinary marketing
// copy ("Risk-free guarantee", "Hassle-free setup") that has nothing to do
// with any tier's price, so the signal that actually disambiguates is the
// tier's own name sitting immediately before it: Figma's Starter tier reads
// "StarterFree limited access...", where "risk-free"/"hassle-free" phrases
// elsewhere on the page never have a tier name immediately in front of them.
//
// "Immediately before" tolerates up to a handful of whitespace/punctuation
// characters between the name and "free" (normalizeAndSlice concatenates
// sibling elements with no separator at all — "StarterFree" — but a page can
// just as easily write "Pro — Free forever"), not arbitrary distance.
//
// The word itself still can't be a continuation of a longer word: nothing
// after "free" may be a lowercase letter, so "Freelance"/"Freedom" fail right
// after a matching tier name exactly as they would anywhere else. Matching is
// case-sensitive by construction (no `i` flag) so that check holds; the tier
// name and "free" are case-folded manually instead.
const FREE_AFTER = '(?![a-z])';
const FREE_SEPARATOR = String.raw`[\s\p{P}]{0,6}`;

function tierNamePrecedesFree(tierName: string, text: string): boolean {
  const name = caseInsensitiveLiteral(escapeRegExp(tierName));
  const re = new RegExp(`(?<![a-zA-Z])${name}${FREE_SEPARATOR}[fF][rR][eE][eE]${FREE_AFTER}`, 'u');
  return re.test(text);
}

// A tier literally named "Free" doesn't need the word "free" to appear again
// after it — the name itself already is the assertion. Four of the six live
// competitors (Linear, Notion, Postman, Supabase) name their zero-cost tier
// exactly "Free", where tierNamePrecedesFree would need the page to read
// "Free Free". Same word-boundary rules as tierNamePrecedesFree so
// "HassleFreeSetup"/"Freelance"-style compounds still don't count.
function tierNameIsWordFree(tierName: string): boolean {
  return tierName.trim().toLowerCase() === 'free';
}

function freeWordAppears(text: string): boolean {
  const re = /(?<![a-zA-Z])[fF][rR][eE][eE](?![a-z])/;
  return re.test(text);
}

/** Empty array means grounded. Each entry names one fabricated value. */
export function groundingViolations(data: PricingSnapshotData, sourceText: string): string[] {
  const violations: string[] = [];
  const check = (value: number | null, where: string, tier: { name: string; is_free: boolean } | null) => {
    if (value === null) return;                    // "contact sales": nothing to ground
    if (value === 0 && tier?.is_free) {
      const grounded = tierNameIsWordFree(tier.name)
        ? freeWordAppears(sourceText)
        : tierNamePrecedesFree(tier.name, sourceText);
      if (grounded) return;
    }
    if (!appearsIn(value, sourceText)) {
      violations.push(`${where} = ${value} does not appear in the page text`);
    }
  };

  for (const t of data.tiers) {
    check(t.monthly_price_usd, `tiers.${t.name}.monthly_price_usd`, t);
    check(t.annual_price_usd, `tiers.${t.name}.annual_price_usd`, t);
  }
  for (const r of data.usage_rates) {
    check(r.unit_price_usd, `usage_rates.${r.metric}.unit_price_usd`, null);  // never for usage_rates
  }
  return violations;
}

/**
 * Spec: the schema comment on `monthly_price_usd` is explicit that null means
 * "contact sales" — NOT free, and NOT zero. A model can satisfy Zod and
 * grounding while still asserting `is_free: true` alongside a null or nonzero
 * price, which is a self-contradiction no text-presence check catches.
 * Empty array means consistent.
 */
export function consistencyViolations(data: PricingSnapshotData): string[] {
  const violations: string[] = [];
  for (const t of data.tiers) {
    if (t.is_free && t.monthly_price_usd !== 0) {
      violations.push(
        `tiers.${t.name}.is_free = true but monthly_price_usd = ${t.monthly_price_usd} (free tiers must price at 0)`
      );
    }
    if (t.is_free && t.annual_price_usd !== null && t.annual_price_usd !== 0) {
      violations.push(
        `tiers.${t.name}.is_free = true but annual_price_usd = ${t.annual_price_usd} (free tiers must price at 0)`
      );
    }
  }
  return violations;
}
