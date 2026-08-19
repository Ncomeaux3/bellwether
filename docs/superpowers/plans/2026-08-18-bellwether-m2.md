# Bellwether M2 — Extraction and Change Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the archive of raw HTML into structured pricing facts, and turn consecutive facts into confirmed, scored change events — so the board stops reporting *that* a page changed and starts reporting that Linear moved Business from $16 to $18.

**Architecture:** Normalize and slice each snapshot to the pricing block, extract it into a Zod-validated `PricingSnapshot` with one Haiku call cached by content hash, then diff consecutive *distinct* extractions as objects rather than text. Every LLM output passes a deterministic grounding assertion before it is stored, and no change is published until a second observation agrees. All branching is code; the model only fills in a schema.

**Tech Stack:** Node 24, TypeScript ESM strict, pnpm, `better-sqlite3`, Zod, `@anthropic-ai/sdk`, `node-html-parser`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-bellwether-design.md` (sections 8, 9, 10, 12.2–12.6, 15.1–15.2)

## Global Constraints

- **The LLM never decides control flow. It only fills in a schema.** (spec 5.1) Every branch, threshold, retry, and skip is deterministic code. `extract_pricing` is a single-shot call, never an agentic loop.
- **Grounding is absolute** (spec 12.6): every numeric price in an extraction must appear as a numeral in the sliced text the model was given. Failure retries once naming the violation, then marks the source degraded. **Never write an ungrounded row.**
- **Only `currency === 'USD'` extractions participate in diffing** (spec 12.4). Others are stored, flagged, and excluded. Three consecutive mismatches degrade the source.
- **A candidate change is not published until its new value is observed a second time** (spec 12.5). State machine: `candidate -> confirmed | disputed | retracted`, and `disputed -> confirmed | retracted`.
- **A change where either side reports `extraction_confidence: 'low'` never leaves `candidate`.**
- **Detection is a pure function of the snapshot set** (spec 12.2). Pair only rows with `ok=1` and non-null `normalized_hash`; pair each *distinct* consecutive hash; a change's `from`/`to` name the **first** snapshot exhibiting each hash.
- **Kill switch:** `LLM_ENABLED=false` runs the whole pipeline with extraction skipped and no API calls. CI runs in this mode. (spec 15.1)
- **Hard cost ceiling, $5/month recurring** (spec 15.2): before any LLM call, sum `cost_micros` for the current month across `extractions` and `digests`, **excluding `is_backfill=1` rows**. Over the cap: refuse, log, continue.
- **Token guard, 20,000 input tokens hard cap** (spec 9.2), checked with the real `countTokens` endpoint. Over budget: widen the slice once, re-check, then degrade and skip. **Never send an oversized request.**
- Model for extraction: `claude-haiku-4-5`. Pricing for the cost ledger: **$1.00 per Mtok input, $5.00 per Mtok output.**
- **Extraction is cached by `(normalized_hash, prompt_version)`** — the same page state is never extracted twice.
- All stored timestamps are ISO 8601 UTC strings. No date library.
- **No network access in tests.** Every LLM test injects a fake client; every HTML test uses a local fixture.
- TypeScript ESM, `strict: true`, `noUncheckedIndexedAccess: true`. Imports use `.js` extensions.
- Nothing in this milestone may `UPDATE` a `snapshots` row except to backfill `normalized_hash` (spec 11's insert-only guarantee otherwise stands).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/schema/pricing.ts` | `PricingSnapshot`, `Tier`, prompt-version constants |
| `src/tools/normalize.ts` | Strip noise, slice to the pricing subtree, hash |
| `src/tools/tier_identity.ts` | Match tiers across snapshots (4-stage) |
| `src/tools/diff.ts` | Two `PricingSnapshot`s → `ChangeEvent[]` |
| `src/tools/materiality.ts` | Score a `ChangeEvent` |
| `src/tools/ground.ts` | Assert every extracted price exists in the source text |
| `src/agents/_client.ts` | Anthropic client, kill switch, cost ceiling, token guard, cost ledger |
| `src/agents/extract_pricing.ts` | The single extraction call + Zod retry + grounding retry |
| `src/workflow/extract.ts` | Queue snapshots needing extraction; cache; currency rule |
| `src/workflow/detect.ts` | Pairing, diff, materiality, confirmation |
| `src/workflow/export.ts` | *(modify)* board carries tiers; new `changes.json` |
| `src/cli.ts` | *(modify)* `extract`, `detect` commands |

---

## Task 1: Schemas, normalization, and slicing

**Files:**
- Create: `src/schema/pricing.ts`, `src/tools/normalize.ts`
- Create: `tests/fixtures/pricing-simple.html`, `tests/fixtures/pricing-noisy.html`
- Test: `tests/normalize.test.ts`

**Interfaces:**
- Consumes: `sha256` from `src/tools/hash.js`.
- Produces:
  - `EXTRACT_PROMPT_VERSION: string`, `Tier`, `PricingSnapshot` (Zod), `type PricingSnapshotData = z.infer<typeof PricingSnapshot>`
  - `normalizeAndSlice(html: string, opts?: { widen?: boolean }): { text: string; normalizedHash: string }`

- [ ] **Step 1: Add the HTML parser**

```bash
cd "/Users/ncomeaux/VsCode/Competitor Watcher"
npx pnpm add node-html-parser
```

Subtree selection genuinely needs a parse tree; regex cannot express "the smallest element containing 80% of the prices". `node-html-parser` has no transitive dependencies.

- [ ] **Step 2: Write `src/schema/pricing.ts`**

```ts
import { z } from 'zod';

/**
 * Stored on every row this prompt produces, so any extraction traces to the
 * exact prompt behind it and can be reprocessed independently (spec 7.1).
 * Bump this to re-extract all history under a better prompt.
 */
export const EXTRACT_PROMPT_VERSION = 'extract-pricing-v1';

export const Tier = z.object({
  name: z.string(),
  /** null means "contact sales" — NOT free, and NOT zero. */
  monthly_price_usd: z.number().nullable(),
  annual_price_usd: z.number().nullable(),
  billing_unit: z.enum(['per_seat', 'flat', 'usage', 'unknown']),
  included_seats: z.number().nullable(),
  is_free: z.boolean(),
  is_enterprise: z.boolean(),
  headline_features: z.array(z.string()).max(8),
});

export const PricingSnapshot = z.object({
  currency: z.string(),
  tiers: z.array(Tier),
  /** Supabase and Sentry price on consumption; without this they extract to almost nothing. */
  usage_rates: z.array(z.object({
    metric: z.string(),
    unit_price_usd: z.number(),
  })).max(12),
  notes: z.string().nullable(),
  /** Self-reported. A useful signal, never a validator — see ground.ts. */
  extraction_confidence: z.enum(['high', 'medium', 'low']),
});

export type TierData = z.infer<typeof Tier>;
export type PricingSnapshotData = z.infer<typeof PricingSnapshot>;
```

- [ ] **Step 3: Write the fixtures**

`tests/fixtures/pricing-simple.html`:

```html
<html><body>
<main id="pricing">
  <div class="tier"><h2>Free</h2><p>$0/mo</p></div>
  <div class="tier"><h2>Pro</h2><p>$20/mo</p></div>
  <div class="tier"><h2>Enterprise</h2><p>Contact sales</p></div>
</main>
</body></html>
```

`tests/fixtures/pricing-noisy.html` — same prices, buried in everything the normalizer must strip:

```html
<html><head>
<script nonce="a3f9">window.__DATA__={build:"9f2a1c4d8e7b6a5f4321"};</script>
<style>.x{color:red}</style>
</head><body>
<div class="cookie-banner">We use cookies. <button>Accept</button></div>
<nav data-testid="nav-8f3a" data-build="9f2a1c4d8e7b6a5f"><a href="/x?v=8f3a2b1c">Home</a></nav>
<!-- build 2026-08-18T00:00:00Z -->
<svg viewBox="0 0 24 24"><path d="M1 1 L2 2"/></svg>
<main id="pricing">
  <div class="tier"><h2>Free</h2><p>$0/mo</p></div>
  <div class="tier"><h2>Pro</h2><p>$20/mo</p></div>
  <div class="tier"><h2>Enterprise</h2><p>Contact sales</p></div>
</main>
<div class="intercom-widget">Chat with us</div>
<footer>© 2026 Example. Pay $0 to start.</footer>
</body></html>
```

- [ ] **Step 4: Write the failing test**

`tests/normalize.test.ts`:

```ts
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

  it('produces the same hash for noise-only differences', () => {
    const a = normalizeAndSlice(fixture('pricing-noisy.html'));
    // Same page, different build hash, different nonce, different cache-buster.
    const mutated = fixture('pricing-noisy.html')
      .replace(/9f2a1c4d8e7b6a5f[0-9a-f]*/g, 'deadbeefdeadbeef')
      .replace('nonce="a3f9"', 'nonce="zz11"')
      .replace('?v=8f3a2b1c', '?v=11112222');
    const b = normalizeAndSlice(mutated);
    expect(b.normalizedHash).toBe(a.normalizedHash);
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
    expect(wide.text).toContain('© 2026 Example');
  });

  it('falls back to the body when no prices are present', () => {
    const { text } = normalizeAndSlice('<body><main>No prices here at all</main></body>');
    expect(text).toContain('No prices here at all');
  });

  it('never throws on malformed html', () => {
    expect(() => normalizeAndSlice('<div><p>$5<//div>')).not.toThrow();
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx pnpm test tests/normalize.test.ts`
Expected: FAIL — cannot resolve `../src/tools/normalize.js`.

- [ ] **Step 6: Write `src/tools/normalize.ts`**

```ts
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

  let current = root;
  for (;;) {
    const heir = current.childNodes
      .filter((n): n is HTMLElement => n instanceof Object && 'querySelectorAll' in n)
      .find(child => countPrices(child.text) >= total * 0.8);
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
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx pnpm test tests/normalize.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 8: Sanity-check against a real archived page**

```bash
npx tsx -e "
import Database from 'better-sqlite3';
import { normalizeAndSlice } from './src/tools/normalize.js';
const db = new Database('./data/bellwether.db', { readonly: true });
for (const r of db.prepare(\"SELECT c.slug, s.raw_content FROM snapshots s JOIN sources src ON src.id=s.source_id JOIN competitors c ON c.id=src.competitor_id WHERE s.raw_content IS NOT NULL\").all()) {
  const { text } = normalizeAndSlice(r.raw_content);
  console.log(r.slug.padEnd(10), String(r.raw_content.length).padStart(9), '->', String(text.length).padStart(7), '|', text.slice(0, 70).replace(/\n/g,' '));
}"
```

Report the table in your report. Every row should shrink by at least 90%, and the excerpt should visibly contain tier names and prices. **If any competitor's excerpt is navigation or legal boilerplate rather than pricing, say so** — that is a real slicing defect, not cosmetic.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml src/schema/pricing.ts src/tools/normalize.ts tests/normalize.test.ts tests/fixtures
git commit -m "feat: pricing schema, HTML normalization, and price-density slicing"
```

---

## Task 2: Tier identity, object diff, and materiality

**Files:**
- Create: `src/tools/tier_identity.ts`, `src/tools/diff.ts`, `src/tools/materiality.ts`
- Test: `tests/diff.test.ts`

All three are pure functions over plain objects with no I/O and no LLM. This is the highest logic density in the milestone and the easiest place to be quietly wrong, so it gets table-driven tests and its own review gate.

**Interfaces:**
- Consumes: `PricingSnapshotData`, `TierData` from `src/schema/pricing.js`.
- Produces:
  - `matchTiers(before: TierData[], after: TierData[]): TierMatch[]`
  - `interface TierMatch { before: TierData | null; after: TierData | null; renamed: boolean }`
  - `diffPricing(before: PricingSnapshotData, after: PricingSnapshotData): ChangeEvent[]`
  - `interface ChangeEvent { change_type: string; json_path: string; before_json: string | null; after_json: string | null }`
  - `scoreMateriality(change: ChangeEvent): number`
  - `MATERIALITY_THRESHOLD = 40`

- [ ] **Step 1: Write the failing test**

`tests/diff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { matchTiers } from '../src/tools/tier_identity.js';
import { diffPricing } from '../src/tools/diff.js';
import { MATERIALITY_THRESHOLD, scoreMateriality } from '../src/tools/materiality.js';
import type { PricingSnapshotData, TierData } from '../src/schema/pricing.js';

function tier(over: Partial<TierData> = {}): TierData {
  return {
    name: 'Pro', monthly_price_usd: 20, annual_price_usd: 200,
    billing_unit: 'per_seat', included_seats: 1,
    is_free: false, is_enterprise: false, headline_features: [], ...over,
  };
}

function snap(tiers: TierData[], over: Partial<PricingSnapshotData> = {}): PricingSnapshotData {
  return {
    currency: 'USD', tiers, usage_rates: [], notes: null,
    extraction_confidence: 'high', ...over,
  };
}

const find = (cs: ReturnType<typeof diffPricing>, type: string) => cs.filter(c => c.change_type === type);

describe('matchTiers', () => {
  it('matches on exact name', () => {
    const m = matchTiers([tier({ name: 'Pro' })], [tier({ name: 'Pro', monthly_price_usd: 24 })]);
    expect(m).toHaveLength(1);
    expect(m[0]!.renamed).toBe(false);
    expect(m[0]!.after!.monthly_price_usd).toBe(24);
  });

  it('matches on normalized name — case, punctuation, "Plan" suffix', () => {
    const m = matchTiers([tier({ name: 'Pro Plan' })], [tier({ name: 'pro' })]);
    expect(m).toHaveLength(1);
    expect(m[0]!.before).not.toBeNull();
    expect(m[0]!.after).not.toBeNull();
  });

  it('matches a rename by position and price proximity', () => {
    const m = matchTiers(
      [tier({ name: 'Free', monthly_price_usd: 0, is_free: true }), tier({ name: 'Pro', monthly_price_usd: 20 })],
      [tier({ name: 'Free', monthly_price_usd: 0, is_free: true }), tier({ name: 'Professional', monthly_price_usd: 21 })],
    );
    const renamed = m.filter(x => x.renamed);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]!.before!.name).toBe('Pro');
    expect(renamed[0]!.after!.name).toBe('Professional');
  });

  it('does not call a >15% price move a rename', () => {
    const m = matchTiers([tier({ name: 'Pro', monthly_price_usd: 20 })], [tier({ name: 'Scale', monthly_price_usd: 90 })]);
    expect(m.some(x => x.renamed)).toBe(false);
    expect(m.filter(x => x.after === null)).toHaveLength(1);
    expect(m.filter(x => x.before === null)).toHaveLength(1);
  });

  it('reports a genuinely new tier as added', () => {
    const m = matchTiers([tier({ name: 'Pro' })], [tier({ name: 'Pro' }), tier({ name: 'Team', monthly_price_usd: 50 })]);
    expect(m.filter(x => x.before === null)).toHaveLength(1);
  });
});

describe('diffPricing', () => {
  it('finds no changes between identical snapshots', () => {
    expect(diffPricing(snap([tier()]), snap([tier()]))).toEqual([]);
  });

  it('detects a monthly price change', () => {
    const cs = diffPricing(snap([tier()]), snap([tier({ monthly_price_usd: 24 })]));
    const c = find(cs, 'price_changed')[0]!;
    expect(c.json_path).toBe('tiers.Pro.monthly_price_usd');
    expect(JSON.parse(c.before_json!)).toBe(20);
    expect(JSON.parse(c.after_json!)).toBe(24);
  });

  it('detects tier added and removed', () => {
    const cs = diffPricing(snap([tier({ name: 'Pro' })]), snap([tier({ name: 'Team' })]));
    expect(find(cs, 'tier_added')).toHaveLength(1);
    expect(find(cs, 'tier_removed')).toHaveLength(1);
  });

  it('emits tier_renamed instead of add+remove, preserving continuity', () => {
    const cs = diffPricing(
      snap([tier({ name: 'Pro', monthly_price_usd: 20 })]),
      snap([tier({ name: 'Professional', monthly_price_usd: 20 })]),
    );
    expect(find(cs, 'tier_renamed')).toHaveLength(1);
    expect(find(cs, 'tier_added')).toHaveLength(0);
    expect(find(cs, 'tier_removed')).toHaveLength(0);
  });

  it('detects billing_unit, seats, and flag flips', () => {
    const cs = diffPricing(
      snap([tier()]),
      snap([tier({ billing_unit: 'flat', included_seats: 5, is_enterprise: true })]),
    );
    expect(find(cs, 'billing_unit_changed')).toHaveLength(1);
    expect(find(cs, 'seats_changed')).toHaveLength(1);
    expect(find(cs, 'flag_changed')).toHaveLength(1);
  });

  it('detects usage rate changes', () => {
    const before = snap([tier()], { usage_rates: [{ metric: 'egress_gb', unit_price_usd: 0.09 }] });
    const after = snap([tier()], { usage_rates: [{ metric: 'egress_gb', unit_price_usd: 0.12 }] });
    expect(find(diffPricing(before, after), 'usage_rate_changed')).toHaveLength(1);
  });

  it('detects feature and notes changes', () => {
    const cs = diffPricing(
      snap([tier({ headline_features: ['a'] })], { notes: null }),
      snap([tier({ headline_features: ['a', 'b'] })], { notes: 'now with SSO' }),
    );
    expect(find(cs, 'features_changed')).toHaveLength(1);
    expect(find(cs, 'notes_changed')).toHaveLength(1);
  });

  it('treats null (contact sales) as distinct from 0 (free)', () => {
    const cs = diffPricing(snap([tier({ monthly_price_usd: null })]), snap([tier({ monthly_price_usd: 0 })]));
    expect(find(cs, 'price_changed')).toHaveLength(1);
  });
});

describe('scoreMateriality', () => {
  const ev = (change_type: string, before: unknown = null, after: unknown = null) => ({
    change_type, json_path: 'tiers.Pro.x',
    before_json: JSON.stringify(before), after_json: JSON.stringify(after),
  });

  it('scores structural changes above the threshold', () => {
    expect(scoreMateriality(ev('tier_added'))).toBe(100);
    expect(scoreMateriality(ev('tier_removed'))).toBe(100);
    expect(scoreMateriality(ev('billing_unit_changed'))).toBe(70);
    expect(scoreMateriality(ev('flag_changed'))).toBe(60);
    expect(scoreMateriality(ev('seats_changed'))).toBe(50);
    expect(scoreMateriality(ev('usage_rate_changed'))).toBe(45);
  });

  it('scores a price change by magnitude, capped at 100', () => {
    expect(scoreMateriality(ev('price_changed', 20, 21))).toBe(85);   // 5% -> 80+5
    expect(scoreMateriality(ev('price_changed', 20, 40))).toBe(100);  // 100% -> capped
  });

  it('scores a price change involving null at the base', () => {
    expect(scoreMateriality(ev('price_changed', null, 20))).toBe(80);
  });

  it('scores copy churn below the threshold', () => {
    expect(scoreMateriality(ev('features_changed'))).toBe(10);
    expect(scoreMateriality(ev('notes_changed'))).toBe(5);
    expect(scoreMateriality(ev('tier_renamed'))).toBe(35);
    for (const t of ['features_changed', 'notes_changed', 'tier_renamed']) {
      expect(scoreMateriality(ev(t))).toBeLessThan(MATERIALITY_THRESHOLD);
    }
  });

  it('scores an unknown change type at 0 rather than throwing', () => {
    expect(scoreMateriality(ev('something_new'))).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm test tests/diff.test.ts`
Expected: FAIL — cannot resolve `../src/tools/tier_identity.js`.

- [ ] **Step 3: Write `src/tools/tier_identity.ts`**

```ts
import type { TierData } from '../schema/pricing.js';

export interface TierMatch {
  before: TierData | null;
  after: TierData | null;
  /** True only for stage-3 positional matches — a rename, not a pricing event. */
  renamed: boolean;
}

/** Case-folded, punctuation stripped, common suffixes removed. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(plan|tier)\b/g, '').trim();
}

/** Within 15%, or both null ("contact sales" on both sides). */
function priceIsClose(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a === 0 && b === 0) return true;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 ? true : Math.abs(a - b) / base <= 0.15;
}

/**
 * Spec 12.3. Naive name-keyed matching turns a rename into tier_removed +
 * tier_added — materiality 200, two spurious entries, and a severed price
 * series exactly where the timeline needs continuity most.
 */
export function matchTiers(before: TierData[], after: TierData[]): TierMatch[] {
  const matches: TierMatch[] = [];
  const unmatchedBefore = new Set(before.keys());
  const unmatchedAfter = new Set(after.keys());

  const pair = (i: number, j: number, renamed: boolean) => {
    matches.push({ before: before[i]!, after: after[j]!, renamed });
    unmatchedBefore.delete(i);
    unmatchedAfter.delete(j);
  };

  // Stage 1: exact name.
  for (const i of [...unmatchedBefore]) {
    for (const j of [...unmatchedAfter]) {
      if (before[i]!.name === after[j]!.name) { pair(i, j, false); break; }
    }
  }

  // Stage 2: normalized name.
  for (const i of [...unmatchedBefore]) {
    for (const j of [...unmatchedAfter]) {
      if (normalizeName(before[i]!.name) === normalizeName(after[j]!.name)) { pair(i, j, false); break; }
    }
  }

  // Stage 3: same ordinal position AND price within 15% -> a rename.
  for (const i of [...unmatchedBefore]) {
    if (!unmatchedAfter.has(i)) continue;
    if (priceIsClose(before[i]!.monthly_price_usd, after[i]!.monthly_price_usd)) pair(i, i, true);
  }

  // Stage 4: whatever is left is genuinely added or removed.
  for (const i of unmatchedBefore) matches.push({ before: before[i]!, after: null, renamed: false });
  for (const j of unmatchedAfter) matches.push({ before: null, after: after[j]!, renamed: false });

  return matches;
}
```

- [ ] **Step 4: Write `src/tools/diff.ts`**

```ts
import type { PricingSnapshotData } from '../schema/pricing.js';
import { matchTiers } from './tier_identity.js';

export interface ChangeEvent {
  change_type: string;
  json_path: string;
  before_json: string | null;
  after_json: string | null;
}

const j = (v: unknown): string => JSON.stringify(v ?? null);

/**
 * Spec 9 gate 5: we never produce a text diff. Comparing typed objects is what
 * makes a marketing-copy rewrite invisible and a price move unmissable.
 */
export function diffPricing(
  before: PricingSnapshotData,
  after: PricingSnapshotData,
): ChangeEvent[] {
  const changes: ChangeEvent[] = [];
  const push = (change_type: string, path: string, b: unknown, a: unknown) =>
    changes.push({ change_type, json_path: path, before_json: j(b), after_json: j(a) });

  for (const m of matchTiers(before.tiers, after.tiers)) {
    if (m.before === null && m.after !== null) {
      push('tier_added', `tiers.${m.after.name}`, null, m.after);
      continue;
    }
    if (m.after === null && m.before !== null) {
      push('tier_removed', `tiers.${m.before.name}`, m.before, null);
      continue;
    }
    const b = m.before!, a = m.after!;
    const path = `tiers.${a.name}`;

    if (m.renamed) push('tier_renamed', path, b.name, a.name);

    // null (contact sales) is deliberately distinct from 0 (free).
    if (b.monthly_price_usd !== a.monthly_price_usd) {
      push('price_changed', `${path}.monthly_price_usd`, b.monthly_price_usd, a.monthly_price_usd);
    }
    if (b.annual_price_usd !== a.annual_price_usd) {
      push('price_changed', `${path}.annual_price_usd`, b.annual_price_usd, a.annual_price_usd);
    }
    if (b.billing_unit !== a.billing_unit) {
      push('billing_unit_changed', `${path}.billing_unit`, b.billing_unit, a.billing_unit);
    }
    if (b.included_seats !== a.included_seats) {
      push('seats_changed', `${path}.included_seats`, b.included_seats, a.included_seats);
    }
    if (b.is_free !== a.is_free || b.is_enterprise !== a.is_enterprise) {
      push('flag_changed', `${path}.flags`,
        { is_free: b.is_free, is_enterprise: b.is_enterprise },
        { is_free: a.is_free, is_enterprise: a.is_enterprise });
    }
    if (JSON.stringify(b.headline_features) !== JSON.stringify(a.headline_features)) {
      push('features_changed', `${path}.headline_features`, b.headline_features, a.headline_features);
    }
  }

  const rates = (s: PricingSnapshotData) => new Map(s.usage_rates.map(r => [r.metric, r.unit_price_usd]));
  const rb = rates(before), ra = rates(after);
  for (const [metric, price] of ra) {
    const prior = rb.get(metric);
    if (prior === undefined) push('usage_rate_added', `usage_rates.${metric}`, null, price);
    else if (prior !== price) push('usage_rate_changed', `usage_rates.${metric}`, prior, price);
  }
  for (const [metric, price] of rb) {
    if (!ra.has(metric)) push('usage_rate_removed', `usage_rates.${metric}`, price, null);
  }

  if (before.notes !== after.notes) push('notes_changed', 'notes', before.notes, after.notes);

  return changes;
}
```

- [ ] **Step 5: Write `src/tools/materiality.ts`**

```ts
import type { ChangeEvent } from './diff.js';

/**
 * Spec 10. Anything scoring below this is recorded but never reaches an LLM
 * and never appears in the digest.
 */
export const MATERIALITY_THRESHOLD = 40;

const BASE: Record<string, number> = {
  tier_added: 100,
  tier_removed: 100,
  price_changed: 80,           // plus magnitude, see below
  billing_unit_changed: 70,
  flag_changed: 60,
  seats_changed: 50,
  usage_rate_changed: 45,
  usage_rate_added: 45,
  usage_rate_removed: 45,
  tier_renamed: 35,            // below threshold: a rename is not a pricing event
  features_changed: 10,        // copy churn the large majority of the time
  notes_changed: 5,
};

function parse(json: string | null): unknown {
  if (json === null) return null;
  try { return JSON.parse(json); } catch { return null; }
}

/** A pure function. No LLM, no I/O, no judgement. */
export function scoreMateriality(change: ChangeEvent): number {
  const base = BASE[change.change_type] ?? 0;
  if (change.change_type !== 'price_changed') return base;

  const before = parse(change.before_json);
  const after = parse(change.after_json);
  if (typeof before !== 'number' || typeof after !== 'number' || before === 0) return base;

  const magnitude = Math.abs((after - before) / before) * 100;
  return Math.min(100, base + Math.min(20, Math.round(magnitude)));
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx pnpm test tests/diff.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npx pnpm typecheck && npx pnpm test`
Expected: PASS — 105 existing tests plus this task's.

- [ ] **Step 8: Commit**

```bash
git add src/tools/tier_identity.ts src/tools/diff.ts src/tools/materiality.ts tests/diff.test.ts
git commit -m "feat: tier identity matching, object diff, and materiality scoring"
```

---

## Task 3: Grounding, cost ceiling, kill switch, and token guard

**Files:**
- Create: `src/tools/ground.ts`, `src/agents/_client.ts`
- Test: `tests/ground.test.ts`, `tests/llm_client.test.ts`

Everything that stands between the model and the database. No API call in this task; the client is exercised through injected fakes.

**Interfaces:**
- Consumes: `PricingSnapshotData`, `DB`.
- Produces:
  - `groundingViolations(data: PricingSnapshotData, sourceText: string): string[]`
  - `class BudgetExceededError extends Error`
  - `llmEnabled(env?: NodeJS.ProcessEnv): boolean`
  - `monthlySpendMicros(db: DB, now?: Date): number`
  - `assertWithinBudget(db: DB, deps?: { now?: () => Date; env?: NodeJS.ProcessEnv }): void`
  - `costMicros(inputTokens: number, outputTokens: number): number`
  - `guardTokens(client: TokenCounter, text: string): Promise<{ ok: boolean; tokens: number }>`
  - `interface TokenCounter { messages: { countTokens(args: unknown): Promise<{ input_tokens: number }> } }`
  - `EXTRACT_MODEL = 'claude-haiku-4-5'`, `TOKEN_BUDGET = 20_000`

- [ ] **Step 1: Write the failing grounding test**

`tests/ground.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { groundingViolations } from '../src/tools/ground.js';
import type { PricingSnapshotData } from '../src/schema/pricing.js';

function snap(over: Partial<PricingSnapshotData> = {}): PricingSnapshotData {
  return {
    currency: 'USD', tiers: [], usage_rates: [], notes: null,
    extraction_confidence: 'high', ...over,
  };
}
const tier = (price: number | null, annual: number | null = null) => ({
  name: 'Pro', monthly_price_usd: price, annual_price_usd: annual,
  billing_unit: 'per_seat' as const, included_seats: null,
  is_free: false, is_enterprise: false, headline_features: [],
});

describe('groundingViolations', () => {
  it('passes when every price appears in the source', () => {
    expect(groundingViolations(snap({ tiers: [tier(20, 200)] }), 'Pro $20/mo or $200/yr')).toEqual([]);
  });

  it('catches a fabricated price', () => {
    const v = groundingViolations(snap({ tiers: [tier(99)] }), 'Pro $20/mo');
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('99');
  });

  it('catches a fabricated usage rate', () => {
    const v = groundingViolations(
      snap({ usage_rates: [{ metric: 'egress_gb', unit_price_usd: 0.42 }] }),
      'egress billed at $0.09 per GB',
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('0.42');
  });

  it('accepts a decimal written without its trailing zero', () => {
    expect(groundingViolations(snap({ tiers: [tier(20.0)] }), 'Pro $20/mo')).toEqual([]);
  });

  it('accepts a price written with a thousands separator', () => {
    expect(groundingViolations(snap({ tiers: [tier(1200)] }), 'Enterprise from $1,200/mo')).toEqual([]);
  });

  it('ignores null prices — "contact sales" has no numeral to ground', () => {
    expect(groundingViolations(snap({ tiers: [tier(null, null)] }), 'Contact sales')).toEqual([]);
  });

  it('accepts zero when the page says free', () => {
    expect(groundingViolations(snap({ tiers: [tier(0)] }), 'Free $0/mo')).toEqual([]);
  });

  it('reports every violation, not just the first', () => {
    const v = groundingViolations(
      snap({ tiers: [tier(99), { ...tier(77), name: 'Team' }] }),
      'Pro $20/mo, Team $50/mo',
    );
    expect(v).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm test tests/ground.test.ts`
Expected: FAIL — cannot resolve `../src/tools/ground.js`.

- [ ] **Step 3: Write `src/tools/ground.ts`**

```ts
import type { PricingSnapshotData } from '../schema/pricing.js';

/**
 * Spec 12.6. `extraction_confidence` is self-reported, and a model confident
 * enough to hallucinate a price is confident enough to report "high". This is
 * the deterministic check that actually holds: a price the model produced but
 * the page never contained is fabricated by construction.
 */
function appearsIn(value: number, text: string): boolean {
  const digitsOnly = text.replace(/,/g, '');       // "$1,200" -> "$1200"
  const forms = new Set<string>([
    String(value),
    value.toFixed(2).replace(/\.?0+$/, ''),        // 20.00 -> "20"
    value.toFixed(2),                              // 0.09 -> "0.09"
  ]);
  return [...forms].some(f => digitsOnly.includes(f));
}

/** Empty array means grounded. Each entry names one fabricated value. */
export function groundingViolations(data: PricingSnapshotData, sourceText: string): string[] {
  const violations: string[] = [];
  const check = (value: number | null, where: string) => {
    if (value === null) return;                    // "contact sales": nothing to ground
    if (!appearsIn(value, sourceText)) {
      violations.push(`${where} = ${value} does not appear in the page text`);
    }
  };

  for (const t of data.tiers) {
    check(t.monthly_price_usd, `tiers.${t.name}.monthly_price_usd`);
    check(t.annual_price_usd, `tiers.${t.name}.annual_price_usd`);
  }
  for (const r of data.usage_rates) {
    check(r.unit_price_usd, `usage_rates.${r.metric}.unit_price_usd`);
  }
  return violations;
}
```

- [ ] **Step 4: Write the failing client test**

`tests/llm_client.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import {
  BudgetExceededError, assertWithinBudget, costMicros,
  guardTokens, llmEnabled, monthlySpendMicros, TOKEN_BUDGET,
} from '../src/agents/_client.js';

let dir: string; let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-llm-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function addExtraction(costMicrosValue: number, createdAt: string, isBackfill = 0) {
  db.prepare(`INSERT INTO extractions
    (normalized_hash, source_kind, data_json, extraction_confidence, is_backfill,
     model, prompt_version, cost_micros, created_at)
    VALUES (?, 'pricing', '{}', 'high', ?, 'claude-haiku-4-5', 'v', ?, ?)`)
    .run(Math.random().toString(36).slice(2), isBackfill, costMicrosValue, createdAt);
}

describe('llmEnabled', () => {
  it('is off when LLM_ENABLED is false', () => {
    expect(llmEnabled({ LLM_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
  });
  it('is on when LLM_ENABLED is true', () => {
    expect(llmEnabled({ LLM_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
  it('defaults to off when unset — spending must be opted into', () => {
    expect(llmEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('costMicros', () => {
  it('prices Haiku 4.5 at $1/Mtok in and $5/Mtok out', () => {
    // 1M input = $1.00 = 1_000_000 micros; 1M output = $5.00 = 5_000_000 micros.
    expect(costMicros(1_000_000, 0)).toBe(1_000_000);
    expect(costMicros(0, 1_000_000)).toBe(5_000_000);
    expect(costMicros(6_000, 600)).toBe(9_000);  // 6000 + 3000
  });
});

describe('monthlySpendMicros', () => {
  const now = () => new Date('2026-08-18T12:00:00.000Z');

  it('sums this month only', () => {
    addExtraction(1_000, '2026-08-02T00:00:00.000Z');
    addExtraction(2_000, '2026-08-17T00:00:00.000Z');
    addExtraction(9_999, '2026-07-31T23:59:59.000Z');
    expect(monthlySpendMicros(db, now())).toBe(3_000);
  });

  it('excludes backfill rows — bulk history has its own budget', () => {
    addExtraction(1_000, '2026-08-02T00:00:00.000Z');
    addExtraction(500_000, '2026-08-03T00:00:00.000Z', 1);
    expect(monthlySpendMicros(db, now())).toBe(1_000);
  });

  it('is zero on an empty database', () => {
    expect(monthlySpendMicros(db, now())).toBe(0);
  });
});

describe('assertWithinBudget', () => {
  const deps = { now: () => new Date('2026-08-18T12:00:00.000Z'), env: {} as NodeJS.ProcessEnv };

  it('passes below the ceiling', () => {
    addExtraction(1_000_000, '2026-08-02T00:00:00.000Z');   // $1.00
    expect(() => assertWithinBudget(db, deps)).not.toThrow();
  });

  it('throws at the ceiling', () => {
    addExtraction(5_000_000, '2026-08-02T00:00:00.000Z');   // $5.00
    expect(() => assertWithinBudget(db, deps)).toThrow(BudgetExceededError);
  });

  it('honours an override ceiling', () => {
    addExtraction(1_500_000, '2026-08-02T00:00:00.000Z');
    const env = { BELLWETHER_MONTHLY_BUDGET_USD: '1.00' } as NodeJS.ProcessEnv;
    expect(() => assertWithinBudget(db, { ...deps, env })).toThrow(BudgetExceededError);
  });

  it('names the spend and the cap so the operator can act', () => {
    addExtraction(5_000_000, '2026-08-02T00:00:00.000Z');
    expect(() => assertWithinBudget(db, deps)).toThrow(/5\.00.*5\.00|\$5\.00/);
  });
});

describe('guardTokens', () => {
  const counter = (n: number) => ({ messages: { countTokens: async () => ({ input_tokens: n }) } });

  it('accepts text under budget', async () => {
    expect(await guardTokens(counter(6_000), 'x')).toEqual({ ok: true, tokens: 6_000 });
  });

  it('rejects text over budget rather than sending it', async () => {
    const r = await guardTokens(counter(TOKEN_BUDGET + 1), 'x');
    expect(r.ok).toBe(false);
  });

  it('accepts text exactly at the budget', async () => {
    expect((await guardTokens(counter(TOKEN_BUDGET), 'x')).ok).toBe(true);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx pnpm test tests/llm_client.test.ts`
Expected: FAIL — cannot resolve `../src/agents/_client.js`.

- [ ] **Step 6: Write `src/agents/_client.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { DB } from '../ops/db.js';

export const EXTRACT_MODEL = 'claude-haiku-4-5';

/** Spec 9.2. Figma's raw page is 2.3 MB and is the reason this exists. */
export const TOKEN_BUDGET = 20_000;

/** Claude Haiku 4.5: $1.00 per Mtok input, $5.00 per Mtok output. */
const INPUT_MICROS_PER_TOKEN = 1;      // $1.00 / 1e6 tokens = 1 micro-dollar
const OUTPUT_MICROS_PER_TOKEN = 5;

const DEFAULT_MONTHLY_BUDGET_USD = 5;

export class BudgetExceededError extends Error {
  constructor(spentMicros: number, capMicros: number) {
    super(
      `Monthly LLM budget exhausted: $${(spentMicros / 1e6).toFixed(2)} spent of ` +
      `$${(capMicros / 1e6).toFixed(2)} cap. Raise BELLWETHER_MONTHLY_BUDGET_USD in .env ` +
      `or wait for the calendar month to roll over.`,
    );
    this.name = 'BudgetExceededError';
  }
}

/**
 * Spec 15.1. Defaults to OFF: spending money is opted into, never inherited
 * from a missing variable. CI runs in this mode.
 */
export function llmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLM_ENABLED === 'true';
}

export function costMicros(inputTokens: number, outputTokens: number): number {
  return inputTokens * INPUT_MICROS_PER_TOKEN + outputTokens * OUTPUT_MICROS_PER_TOKEN;
}

/** Spec 15.2: recurring spend only — is_backfill rows have their own budget. */
export function monthlySpendMicros(db: DB, now: Date = new Date()): number {
  const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_micros), 0) AS total FROM (
      SELECT cost_micros, created_at FROM extractions WHERE is_backfill = 0
      UNION ALL
      SELECT cost_micros, created_at FROM digests
    ) WHERE created_at >= ?
  `).get(monthStart) as { total: number };
  return row.total;
}

export interface BudgetDeps { now?: () => Date; env?: NodeJS.ProcessEnv }

/** Called before every LLM request. Refuses rather than overspending. */
export function assertWithinBudget(db: DB, deps: BudgetDeps = {}): void {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const capUsd = Number(env.BELLWETHER_MONTHLY_BUDGET_USD ?? DEFAULT_MONTHLY_BUDGET_USD);
  const capMicros = Math.round((Number.isFinite(capUsd) ? capUsd : DEFAULT_MONTHLY_BUDGET_USD) * 1e6);
  const spent = monthlySpendMicros(db, now);
  if (spent >= capMicros) throw new BudgetExceededError(spent, capMicros);
}

export interface TokenCounter {
  messages: { countTokens(args: unknown): Promise<{ input_tokens: number }> };
}

/**
 * Spec 9.2. Uses the real countTokens endpoint, so the check is measured
 * rather than estimated. An over-budget request is never sent.
 */
export async function guardTokens(
  client: TokenCounter,
  text: string,
): Promise<{ ok: boolean; tokens: number }> {
  const { input_tokens } = await client.messages.countTokens({
    model: EXTRACT_MODEL,
    messages: [{ role: 'user', content: text }],
  });
  return { ok: input_tokens <= TOKEN_BUDGET, tokens: input_tokens };
}

let cached: Anthropic | undefined;

/** Constructed lazily so no test and no LLM_ENABLED=false run ever needs a key. */
export function anthropic(): Anthropic {
  cached ??= new Anthropic();
  return cached;
}
```

- [ ] **Step 7: Install the SDK**

```bash
npx pnpm add @anthropic-ai/sdk
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx pnpm test tests/ground.test.ts tests/llm_client.test.ts`
Expected: PASS, 8 + 14 tests.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml src/tools/ground.ts src/agents/_client.ts tests/ground.test.ts tests/llm_client.test.ts
git commit -m "feat: grounding assertion, cost ceiling, kill switch, and token guard"
```

---

## Task 4: The extraction agent

**Files:**
- Create: `src/agents/extract_pricing.ts`
- Test: `tests/extract_pricing.test.ts`

The only place in M2 that calls Claude. One request, schema-constrained, with two deterministic guards around it.

**Interfaces:**
- Consumes: `PricingSnapshot`, `EXTRACT_PROMPT_VERSION`, `groundingViolations`, `guardTokens`, `costMicros`, `EXTRACT_MODEL`, `TOKEN_BUDGET`.
- Produces:
  - `extractPricing(text: string, deps: ExtractDeps): Promise<ExtractResult>`
  - `type ExtractResult = { ok: true; data: PricingSnapshotData; inputTokens: number; outputTokens: number; costMicros: number; attempts: number } | { ok: false; reason: 'oversized' | 'invalid' | 'ungrounded'; detail: string }`
  - `interface ExtractDeps { client: ExtractClient; maxAttempts?: number }`

- [ ] **Step 1: Write the failing test**

`tests/extract_pricing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractPricing } from '../src/agents/extract_pricing.js';
import { TOKEN_BUDGET } from '../src/agents/_client.js';
import type { PricingSnapshotData } from '../src/schema/pricing.js';

const SOURCE = 'Free $0/mo. Pro $20/mo. Enterprise contact sales.';

function data(over: Partial<PricingSnapshotData> = {}): PricingSnapshotData {
  return {
    currency: 'USD',
    tiers: [{
      name: 'Pro', monthly_price_usd: 20, annual_price_usd: null,
      billing_unit: 'per_seat', included_seats: null,
      is_free: false, is_enterprise: false, headline_features: [],
    }],
    usage_rates: [], notes: null, extraction_confidence: 'high', ...over,
  };
}

/** Returns a scripted sequence of parse() results; records prompts seen. */
function fakeClient(results: Array<{ parsed_output: unknown; usage?: { input_tokens: number; output_tokens: number } }>, tokens = 6_000) {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    messages: {
      countTokens: async () => ({ input_tokens: tokens }),
      parse: async (args: { messages: Array<{ content: string }> }) => {
        prompts.push(args.messages.map(m => m.content).join('\n'));
        const r = results[Math.min(i++, results.length - 1)]!;
        return { parsed_output: r.parsed_output, usage: r.usage ?? { input_tokens: 6_000, output_tokens: 600 } };
      },
    },
  };
}

describe('extractPricing', () => {
  it('returns validated, grounded data on the happy path', async () => {
    const client = fakeClient([{ parsed_output: data() }]);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tiers[0]!.monthly_price_usd).toBe(20);
    expect(r.attempts).toBe(1);
    expect(r.costMicros).toBe(9_000);   // 6000 in + 600 out
  });

  it('refuses to send an oversized request', async () => {
    const client = fakeClient([{ parsed_output: data() }], TOKEN_BUDGET + 1);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('oversized');
    expect(client.prompts).toHaveLength(0);   // never called parse
  });

  it('retries once when the model returns nothing parseable', async () => {
    const client = fakeClient([{ parsed_output: null }, { parsed_output: data() }]);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attempts).toBe(2);
  });

  it('gives up as invalid after the retry also fails', async () => {
    const client = fakeClient([{ parsed_output: null }, { parsed_output: null }]);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
  });

  it('retries a fabricated price and names the violation in the retry prompt', async () => {
    const fabricated = data({ tiers: [{ ...data().tiers[0]!, monthly_price_usd: 99 }] });
    const client = fakeClient([{ parsed_output: fabricated }, { parsed_output: data() }]);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(true);
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toContain('99');
  });

  it('refuses to return ungrounded data when the retry is also fabricated', async () => {
    const fabricated = data({ tiers: [{ ...data().tiers[0]!, monthly_price_usd: 99 }] });
    const client = fakeClient([{ parsed_output: fabricated }, { parsed_output: fabricated }]);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ungrounded');
    expect(r.detail).toContain('99');
  });

  it('rejects output that fails Zod validation', async () => {
    const client = fakeClient([{ parsed_output: { currency: 'USD' } }, { parsed_output: { currency: 'USD' } }]);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
  });

  it('sends the page text to the model', async () => {
    const client = fakeClient([{ parsed_output: data() }]);
    await extractPricing(SOURCE, { client });
    expect(client.prompts[0]).toContain(SOURCE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm test tests/extract_pricing.test.ts`
Expected: FAIL — cannot resolve `../src/agents/extract_pricing.js`.

- [ ] **Step 3: Write `src/agents/extract_pricing.ts`**

```ts
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { PricingSnapshot, type PricingSnapshotData } from '../schema/pricing.js';
import { groundingViolations } from '../tools/ground.js';
import { EXTRACT_MODEL, costMicros, guardTokens, type TokenCounter } from './_client.js';

const SYSTEM = `You extract pricing facts from a SaaS pricing page.

Rules:
- Report only what the page states. Never infer, never estimate, never fill a gap.
- monthly_price_usd is null when the tier says "contact sales" or shows no price.
  null is NOT zero. Use 0 only when the page states the tier costs nothing.
- currency is the ISO code the page prices in ("USD", "EUR", ...). Do not convert.
- usage_rates is for consumption pricing (per GB, per event, per seat-hour).
- headline_features: at most 8, verbatim from the page.
- extraction_confidence is "low" when the page is ambiguous or you had to guess.`;

export interface ExtractClient extends TokenCounter {
  messages: TokenCounter['messages'] & {
    parse(args: unknown): Promise<{
      parsed_output: unknown;
      usage?: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export interface ExtractDeps { client: ExtractClient; maxAttempts?: number }

export type ExtractResult =
  | { ok: true; data: PricingSnapshotData; inputTokens: number; outputTokens: number; costMicros: number; attempts: number }
  | { ok: false; reason: 'oversized' | 'invalid' | 'ungrounded'; detail: string };

/**
 * One schema-constrained call, wrapped in two deterministic guards: the token
 * budget before, and the grounding assertion after. The model never decides
 * control flow — every retry and refusal here is code (spec 5.1).
 */
export async function extractPricing(text: string, deps: ExtractDeps): Promise<ExtractResult> {
  const maxAttempts = deps.maxAttempts ?? 2;

  const budget = await guardTokens(deps.client, text);
  if (!budget.ok) {
    return { ok: false, reason: 'oversized', detail: `${budget.tokens} tokens exceeds the ${20_000} budget` };
  }

  let lastDetail = 'no attempt made';
  let lastReason: 'invalid' | 'ungrounded' = 'invalid';
  let correction = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await deps.client.messages.parse({
      model: EXTRACT_MODEL,
      max_tokens: 4_000,
      system: SYSTEM,
      messages: [{ role: 'user', content: `${correction}Pricing page text:\n\n${text}` }],
      output_config: { format: zodOutputFormat(PricingSnapshot) },
    });

    const parsed = PricingSnapshot.safeParse(response.parsed_output);
    if (!parsed.success) {
      lastReason = 'invalid';
      lastDetail = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      correction = `Your previous answer did not match the schema (${lastDetail}). Return valid JSON.\n\n`;
      continue;
    }

    const violations = groundingViolations(parsed.data, text);
    if (violations.length > 0) {
      lastReason = 'ungrounded';
      lastDetail = violations.join('; ');
      correction =
        `Your previous answer invented values not present in the page: ${lastDetail}. ` +
        `Use only numbers that literally appear in the text below.\n\n`;
      continue;
    }

    const usage = response.usage ?? { input_tokens: budget.tokens, output_tokens: 0 };
    return {
      ok: true,
      data: parsed.data,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costMicros: costMicros(usage.input_tokens, usage.output_tokens),
      attempts: attempt,
    };
  }

  return { ok: false, reason: lastReason, detail: lastDetail };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx pnpm test tests/extract_pricing.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/extract_pricing.ts tests/extract_pricing.test.ts
git commit -m "feat: schema-constrained pricing extraction with grounding retry"
```

---

## Task 5: The extract workflow

**Files:**
- Create: `src/workflow/extract.ts`
- Modify: `src/cli.ts` — add `extract`, and call it from `start`
- Test: `tests/extract.test.ts`

**Interfaces:**
- Consumes: `openDb`, `acquireRun`, `finishRun`, `normalizeAndSlice`, `extractPricing`, `llmEnabled`, `assertWithinBudget`, `BudgetExceededError`, `EXTRACT_PROMPT_VERSION`, `EXTRACT_MODEL`.
- Produces:
  - `extract(db: DB, opts: ExtractOptions, deps: ExtractWorkflowDeps): Promise<ExtractStats>`
  - `interface ExtractStats { considered: number; hashed: number; cached: number; extracted: number; skipped: number; degraded: number; mismatched: number }`

- [ ] **Step 1: Write the failing test**

`tests/extract.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { extract } from '../src/workflow/extract.js';
import type { CompetitorConfig } from '../src/config/types.js';
import type { ExtractResult } from '../src/agents/extract_pricing.js';

let dir: string; let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

const HTML = '<body><main><h2>Pro</h2><p>$20/mo</p><h2>Enterprise</h2></main></body>';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-extract-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function addSnapshot(html: string | null, ok = 1, observedAt = '2026-08-18T12:00:00.000Z') {
  db.prepare(`INSERT INTO snapshots
    (source_id, observed_at, fetched_at, ok, http_status, error, raw_content, raw_hash, normalized_hash, provenance)
    VALUES (1, ?, ?, ?, 200, NULL, ?, ?, NULL, 'live')`)
    .run(observedAt, observedAt, ok, html, html ? `h${html.length}${observedAt}` : null);
}

const okResult = (price: number, currency = 'USD', confidence: 'high' | 'low' = 'high'): ExtractResult => ({
  ok: true,
  data: {
    currency,
    tiers: [{
      name: 'Pro', monthly_price_usd: price, annual_price_usd: null,
      billing_unit: 'per_seat', included_seats: null,
      is_free: false, is_enterprise: false, headline_features: [],
    }],
    usage_rates: [], notes: null, extraction_confidence: confidence,
  },
  inputTokens: 6_000, outputTokens: 600, costMicros: 9_000, attempts: 1,
});

const deps = (result: ExtractResult, env: Record<string, string> = { LLM_ENABLED: 'true' }) => ({
  extractor: async () => result,
  env: env as NodeJS.ProcessEnv,
  now: () => new Date('2026-08-18T12:00:00.000Z'),
});

describe('extract', () => {
  it('backfills normalized_hash onto snapshots that lack it', async () => {
    addSnapshot(HTML);
    await extract(db, {}, deps(okResult(20)));
    const row = db.prepare('SELECT normalized_hash FROM snapshots').get() as { normalized_hash: string | null };
    expect(row.normalized_hash).toHaveLength(64);
  });

  it('writes an extraction row with cost and provenance', async () => {
    addSnapshot(HTML);
    const stats = await extract(db, {}, deps(okResult(20)));
    expect(stats.extracted).toBe(1);

    const row = db.prepare('SELECT * FROM extractions').get() as Record<string, unknown>;
    expect(row.prompt_version).toBe('extract-pricing-v1');
    expect(row.model).toBe('claude-haiku-4-5');
    expect(row.cost_micros).toBe(9_000);
    expect(row.grounded).toBe(1);
    expect(JSON.parse(String(row.data_json)).tiers[0].monthly_price_usd).toBe(20);
  });

  it('reuses the cache for a repeated page state instead of calling again', async () => {
    addSnapshot(HTML, 1, '2026-08-18T12:00:00.000Z');
    addSnapshot(HTML, 1, '2026-08-19T12:00:00.000Z');
    let calls = 0;
    await extract(db, {}, { ...deps(okResult(20)), extractor: async () => { calls += 1; return okResult(20); } });

    expect(calls).toBe(1);
    const n = db.prepare('SELECT COUNT(*) AS n FROM extractions').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('skips failed snapshots entirely', async () => {
    addSnapshot(null, 0);
    const stats = await extract(db, {}, deps(okResult(20)));
    expect(stats.considered).toBe(0);
    expect(stats.extracted).toBe(0);
  });

  it('does nothing and spends nothing when LLM_ENABLED is false', async () => {
    addSnapshot(HTML);
    let calls = 0;
    const stats = await extract(db, {}, {
      ...deps(okResult(20), { LLM_ENABLED: 'false' }),
      extractor: async () => { calls += 1; return okResult(20); },
    });
    expect(calls).toBe(0);
    expect(stats.skipped).toBeGreaterThan(0);
    // Hashing still happens — it is free and detect needs it.
    const row = db.prepare('SELECT normalized_hash FROM snapshots').get() as { normalized_hash: string | null };
    expect(row.normalized_hash).not.toBeNull();
  });

  it('stores a non-USD extraction but flags it as a mismatch', async () => {
    addSnapshot(HTML);
    const stats = await extract(db, {}, deps(okResult(20, 'EUR')));
    expect(stats.mismatched).toBe(1);
    const row = db.prepare('SELECT currency FROM extractions').get() as { currency: string };
    expect(row.currency).toBe('EUR');
  });

  it('degrades the source when extraction is ungrounded', async () => {
    addSnapshot(HTML);
    const stats = await extract(db, {}, deps({ ok: false, reason: 'ungrounded', detail: 'tiers.Pro.monthly_price_usd = 99 does not appear' }));
    expect(stats.degraded).toBe(1);
    const row = db.prepare('SELECT degraded_reason FROM sources').get() as { degraded_reason: string | null };
    expect(row.degraded_reason).toMatch(/ungrounded|99/i);
    const n = db.prepare('SELECT COUNT(*) AS n FROM extractions').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('stops when the monthly budget is exhausted', async () => {
    addSnapshot(HTML);
    db.prepare(`INSERT INTO extractions
      (normalized_hash, source_kind, data_json, extraction_confidence, is_backfill,
       model, prompt_version, cost_micros, created_at)
      VALUES ('other', 'pricing', '{}', 'high', 0, 'm', 'v', 6000000, '2026-08-02T00:00:00.000Z')`).run();

    let calls = 0;
    const stats = await extract(db, {}, { ...deps(okResult(20)), extractor: async () => { calls += 1; return okResult(20); } });
    expect(calls).toBe(0);
    expect(stats.skipped).toBeGreaterThan(0);
  });

  it('honours --limit', async () => {
    addSnapshot('<body><main>$10</main></body>', 1, '2026-08-18T12:00:00.000Z');
    addSnapshot('<body><main>$20</main></body>', 1, '2026-08-19T12:00:00.000Z');
    const stats = await extract(db, { limit: 1 }, deps(okResult(20)));
    expect(stats.extracted).toBe(1);
  });

  it('leaves a completed run row', async () => {
    addSnapshot(HTML);
    await extract(db, {}, deps(okResult(20)));
    const row = db.prepare("SELECT state, ok FROM runs WHERE kind = 'extract'").get() as { state: string; ok: number };
    expect(row).toEqual({ state: 'ok', ok: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm test tests/extract.test.ts`
Expected: FAIL — cannot resolve `../src/workflow/extract.js`.

- [ ] **Step 3: Write `src/workflow/extract.ts`**

```ts
import type { DB } from '../ops/db.js';
import { acquireRun, finishRun } from '../ops/runs.js';
import { normalizeAndSlice } from '../tools/normalize.js';
import { EXTRACT_PROMPT_VERSION } from '../schema/pricing.js';
import {
  BudgetExceededError, EXTRACT_MODEL, anthropic, assertWithinBudget, llmEnabled,
} from '../agents/_client.js';
import { extractPricing, type ExtractResult } from '../agents/extract_pricing.js';

export interface ExtractOptions { limit?: number; dryRun?: boolean }

export interface ExtractStats {
  considered: number; hashed: number; cached: number;
  extracted: number; skipped: number; degraded: number; mismatched: number;
}

export interface ExtractWorkflowDeps {
  extractor?: (text: string) => Promise<ExtractResult>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

interface PendingRow {
  id: number; source_id: number; raw_content: string | null;
  raw_hash: string | null; normalized_hash: string | null;
}

/**
 * Spec 5.2: queries the DB for outstanding work rather than holding state.
 * Hashing is free and always runs; the LLM call is gated by cache, kill
 * switch, and budget, in that order.
 */
export async function extract(
  db: DB,
  opts: ExtractOptions = {},
  deps: ExtractWorkflowDeps = {},
): Promise<ExtractStats> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const stats: ExtractStats = {
    considered: 0, hashed: 0, cached: 0, extracted: 0, skipped: 0, degraded: 0, mismatched: 0,
  };

  const runId = acquireRun(db, 'extract', { now });

  try {
    // Snapshots that carry content and have not been extracted at this prompt version.
    const pending = db.prepare(`
      SELECT s.id, s.source_id, s.raw_content, s.raw_hash, s.normalized_hash
      FROM snapshots s
      WHERE s.ok = 1 AND s.raw_content IS NOT NULL
      ORDER BY s.observed_at, s.id
      ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}
    `).all() as PendingRow[];

    const setHash = db.prepare('UPDATE snapshots SET normalized_hash = ? WHERE id = ?');
    const propagate = db.prepare(
      'UPDATE snapshots SET normalized_hash = ? WHERE source_id = ? AND raw_hash = ? AND normalized_hash IS NULL',
    );
    const findExtraction = db.prepare(
      'SELECT id FROM extractions WHERE normalized_hash = ? AND prompt_version = ?',
    );
    const insertExtraction = db.prepare(`
      INSERT INTO extractions
        (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
         is_backfill, model, prompt_version, input_tokens, output_tokens, cost_micros, created_at)
      VALUES (@hash, 'pricing', @data, @confidence, @currency, 1,
              0, @model, @promptVersion, @inputTokens, @outputTokens, @costMicros, @createdAt)
    `);
    const degrade = db.prepare('UPDATE sources SET degraded_reason = ? WHERE id = ?');

    const runExtractor = deps.extractor
      ?? ((text: string) => extractPricing(text, { client: anthropic() as never }));

    for (const row of pending) {
      stats.considered += 1;
      if (row.raw_content === null) continue;

      const { text, normalizedHash } = normalizeAndSlice(row.raw_content);

      if (!opts.dryRun && row.normalized_hash !== normalizedHash) {
        setHash.run(normalizedHash, row.id);
        // Deduplicated snapshots share a raw_hash but carry NULL raw_content,
        // so they can never be hashed on their own. Propagate to them here or
        // detect (spec 12.2) skips them forever.
        if (row.raw_hash !== null) propagate.run(normalizedHash, row.source_id, row.raw_hash);
        stats.hashed += 1;
      }

      if (findExtraction.get(normalizedHash, EXTRACT_PROMPT_VERSION) !== undefined) {
        stats.cached += 1;
        continue;
      }

      if (!llmEnabled(env)) { stats.skipped += 1; continue; }

      try {
        assertWithinBudget(db, { now, env });
      } catch (err) {
        if (!(err instanceof BudgetExceededError)) throw err;
        console.warn(err.message);
        stats.skipped += pending.length - stats.considered + 1;
        break;
      }

      if (opts.dryRun) { stats.skipped += 1; continue; }

      const result = await runExtractor(text);

      if (!result.ok) {
        stats.degraded += 1;
        degrade.run(`extraction ${result.reason}: ${result.detail}`.slice(0, 300), row.source_id);
        continue;
      }

      insertExtraction.run({
        hash: normalizedHash,
        data: JSON.stringify(result.data),
        confidence: result.data.extraction_confidence,
        currency: result.data.currency,
        model: EXTRACT_MODEL,
        promptVersion: EXTRACT_PROMPT_VERSION,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicros: result.costMicros,
        createdAt: now().toISOString(),
      });
      stats.extracted += 1;
      // Spec 12.4: stored, but excluded from diffing by detect.
      if (result.data.currency !== 'USD') stats.mismatched += 1;
    }

    finishRun(db, runId, true, stats);
    return stats;
  } catch (err) {
    finishRun(db, runId, false, stats, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx pnpm test tests/extract.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Add the `extract` command to `src/cli.ts`**

Insert after the `collect` command block:

```ts
program
  .command('extract')
  .description('extract structured pricing from snapshots that lack it')
  .option('--limit <n>', 'process at most n snapshots', v => Number(v))
  .option('--dry-run', 'normalize and hash but make no LLM calls')
  .action(async (options: { limit?: number; dryRun?: boolean }) => {
    const { extract } = await import('./workflow/extract.js');
    const db = openDb(dbPath());
    const s = await extract(db, { limit: options.limit, dryRun: options.dryRun });
    console.log(
      `Considered ${s.considered}: ${s.extracted} extracted, ${s.cached} cached, ` +
      `${s.hashed} hashed, ${s.skipped} skipped, ${s.degraded} degraded, ${s.mismatched} non-USD.`,
    );
    db.close();
  });
```

- [ ] **Step 6: Add `extract` to the `start` sequence in `src/cli.ts`**

In the `start` command, insert the extract step between `collect` and `export` so the container runs the full pipeline. Find the collect call inside `start` and add immediately after it:

```ts
    const { extract } = await import('./workflow/extract.js');
    const extractStats = await extract(db, {});
    console.log(
      `Extracted ${extractStats.extracted}, cached ${extractStats.cached}, ` +
      `skipped ${extractStats.skipped}, degraded ${extractStats.degraded}.`,
    );
```

- [ ] **Step 7: Verify against the real archive, with no spend**

```bash
npx pnpm bw extract --dry-run
```
Expected: `Considered 6: 0 extracted, 0 cached, 6 hashed, 6 skipped, ...` — hashing happens, no LLM call. Confirm with:

```bash
npx tsx -e "
import Database from 'better-sqlite3';
const db=new Database('./data/bellwether.db',{readonly:true});
console.log(db.prepare('SELECT COUNT(*) n, COUNT(normalized_hash) hashed FROM snapshots').get());"
```

- [ ] **Step 8: Run one real extraction and inspect it**

```bash
LLM_ENABLED=true npx pnpm bw extract --limit 1
npx tsx -e "
import Database from 'better-sqlite3';
const db=new Database('./data/bellwether.db',{readonly:true});
const r=db.prepare('SELECT currency, extraction_confidence, cost_micros, data_json FROM extractions LIMIT 1').get();
console.log('currency', r.currency, '| confidence', r.extraction_confidence, '| cost \$' + (r.cost_micros/1e6).toFixed(4));
console.log(JSON.stringify(JSON.parse(r.data_json).tiers, null, 2));"
```

**Put the tier output in your report.** Check it against the live page yourself: are the tier names and prices actually right? A schema-valid, grounded extraction can still be wrong about which number belongs to which tier, and this is the only place a human catches that.

- [ ] **Step 9: Commit**

```bash
git add src/workflow/extract.ts src/cli.ts tests/extract.test.ts
git commit -m "feat: extract workflow with content-addressed caching and budget gating"
```

---

## Task 6: Detection — pairing, diff, materiality

**Files:**
- Create: `src/workflow/detect.ts`
- Modify: `src/cli.ts` — add `detect`, and call it from `start`
- Test: `tests/detect.test.ts`

**Interfaces:**
- Consumes: `diffPricing`, `scoreMateriality`, `PricingSnapshot`, `acquireRun`, `finishRun`.
- Produces:
  - `detect(db: DB, opts: DetectOptions, deps?: DetectDeps): DetectStats`
  - `interface DetectStats { sources: number; pairs: number; created: number; confirmed: number; disputed: number; retracted: number }`
  - `interface DetectOptions { rebuild?: boolean; sourceId?: number }`

- [ ] **Step 1: Write the failing test**

`tests/detect.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { detect } from '../src/workflow/detect.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string; let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-detect-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

/** Adds a snapshot plus its extraction. `hash` identifies the page state. */
function observe(
  day: number, hash: string, price: number | null,
  opts: { ok?: number; confidence?: 'high' | 'low'; currency?: string } = {},
) {
  const at = `2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`;
  db.prepare(`INSERT INTO snapshots
    (source_id, observed_at, fetched_at, ok, http_status, raw_content, raw_hash, normalized_hash, provenance)
    VALUES (1, ?, ?, ?, 200, 'x', ?, ?, 'live')`)
    .run(at, at, opts.ok ?? 1, `r-${hash}`, opts.ok === 0 ? null : hash);

  const exists = db.prepare('SELECT 1 FROM extractions WHERE normalized_hash = ?').get(hash);
  if (exists || opts.ok === 0) return;

  db.prepare(`INSERT INTO extractions
    (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
     is_backfill, model, prompt_version, cost_micros, created_at)
    VALUES (?, 'pricing', ?, ?, ?, 1, 0, 'claude-haiku-4-5', 'extract-pricing-v1', 9000, ?)`)
    .run(hash, JSON.stringify({
      currency: opts.currency ?? 'USD',
      tiers: [{
        name: 'Pro', monthly_price_usd: price, annual_price_usd: null,
        billing_unit: 'per_seat', included_seats: null,
        is_free: false, is_enterprise: false, headline_features: [],
      }],
      usage_rates: [], notes: null, extraction_confidence: opts.confidence ?? 'high',
    }), opts.confidence ?? 'high', opts.currency ?? 'USD', at);
}

const changes = () => db.prepare('SELECT change_type, materiality, state, observed_at FROM changes ORDER BY id')
  .all() as { change_type: string; materiality: number; state: string; observed_at: string }[];

describe('detect', () => {
  it('finds nothing from a single observation', () => {
    observe(18, 'a', 20);
    expect(detect(db, {}).created).toBe(0);
  });

  it('finds nothing when the page state repeats', () => {
    observe(18, 'a', 20); observe(19, 'a', 20); observe(20, 'a', 20);
    expect(detect(db, {}).created).toBe(0);
  });

  it('detects a price change between distinct states', () => {
    observe(18, 'a', 20); observe(19, 'b', 24);
    detect(db, {});
    const cs = changes();
    expect(cs).toHaveLength(1);
    expect(cs[0]!.change_type).toBe('price_changed');
    expect(cs[0]!.materiality).toBe(100);   // 80 + min(20, 20% move)
  });

  it('dates a change to the first snapshot showing the new state', () => {
    observe(18, 'a', 20); observe(19, 'b', 24); observe(20, 'b', 24);
    detect(db, {});
    expect(changes()[0]!.observed_at).toBe('2026-08-19T12:00:00.000Z');
  });

  it('skips failed fetches rather than treating them as change', () => {
    observe(18, 'a', 20); observe(19, 'zzz', null, { ok: 0 }); observe(20, 'a', 20);
    expect(detect(db, {}).created).toBe(0);
  });

  it('excludes non-USD extractions from diffing', () => {
    observe(18, 'a', 20); observe(19, 'b', 24, { currency: 'EUR' });
    expect(detect(db, {}).created).toBe(0);
  });

  it('is idempotent — running twice creates no duplicates', () => {
    observe(18, 'a', 20); observe(19, 'b', 24);
    detect(db, {}); detect(db, {});
    expect(changes()).toHaveLength(1);
  });

  it('records sub-threshold changes but never confirms them', () => {
    observe(18, 'a', 20);
    db.prepare("UPDATE extractions SET data_json = json_set(data_json, '$.notes', 'hello') WHERE normalized_hash = 'a'").run();
    observe(19, 'b', 20);
    detect(db, {});
    const minor = changes().filter(c => c.materiality < 40);
    expect(minor.length).toBeGreaterThan(0);
    expect(minor.every(c => c.state === 'candidate')).toBe(true);
  });

  it('rebuild deletes and re-derives, absorbing a late-inserted snapshot', () => {
    observe(18, 'a', 20); observe(20, 'c', 30);
    detect(db, {});
    expect(changes()).toHaveLength(1);

    observe(19, 'b', 24);              // backfill lands between them
    const stats = detect(db, { rebuild: true });
    expect(stats.created).toBe(2);      // a->b and b->c
    expect(changes()).toHaveLength(2);
  });

  it('leaves a completed run row', () => {
    observe(18, 'a', 20);
    detect(db, {});
    const row = db.prepare("SELECT state, ok FROM runs WHERE kind = 'detect'").get() as { state: string; ok: number };
    expect(row).toEqual({ state: 'ok', ok: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm test tests/detect.test.ts`
Expected: FAIL — cannot resolve `../src/workflow/detect.js`.

- [ ] **Step 3: Write `src/workflow/detect.ts`**

```ts
import type { DB } from '../ops/db.js';
import { acquireRun, finishRun } from '../ops/runs.js';
import { PricingSnapshot, type PricingSnapshotData } from '../schema/pricing.js';
import { diffPricing } from '../tools/diff.js';
import { MATERIALITY_THRESHOLD, scoreMateriality } from '../tools/materiality.js';

export interface DetectOptions { rebuild?: boolean; sourceId?: number }

export interface DetectStats {
  sources: number; pairs: number; created: number;
  confirmed: number; disputed: number; retracted: number;
}

export interface DetectDeps { now?: () => Date }

/** One observation of a distinct page state, with its parsed extraction. */
export interface Observation {
  snapshotId: number;
  observedAt: string;
  normalizedHash: string;
  confidence: string;
  data: PricingSnapshotData;
}

/**
 * Spec 12.2 pairing rule. Only ok=1 rows with a normalized_hash; each *distinct*
 * consecutive hash pairs with the next; repeated hashes collapse to one state,
 * and the state is dated to the FIRST snapshot exhibiting it.
 *
 * Only USD extractions participate (spec 12.4) — a geo-served EUR page is a
 * collection anomaly, not a pricing event.
 */
export function observationsFor(db: DB, sourceId: number): Observation[] {
  const rows = db.prepare(`
    SELECT s.id, s.observed_at, s.normalized_hash,
           e.data_json, e.extraction_confidence, e.currency
    FROM snapshots s
    JOIN extractions e ON e.normalized_hash = s.normalized_hash
    WHERE s.source_id = ? AND s.ok = 1 AND s.normalized_hash IS NOT NULL
      AND e.currency = 'USD'
    ORDER BY s.observed_at, s.id
  `).all(sourceId) as {
    id: number; observed_at: string; normalized_hash: string;
    data_json: string; extraction_confidence: string;
  }[];

  const observations: Observation[] = [];
  for (const row of rows) {
    const previous = observations[observations.length - 1];
    if (previous?.normalizedHash === row.normalized_hash) continue;   // collapse repeats

    const parsed = PricingSnapshot.safeParse(JSON.parse(row.data_json));
    if (!parsed.success) continue;   // a malformed stored row is skipped, never guessed at

    observations.push({
      snapshotId: row.id,
      observedAt: row.observed_at,
      normalizedHash: row.normalized_hash,
      confidence: row.extraction_confidence,
      data: parsed.data,
    });
  }
  return observations;
}

export function detect(db: DB, opts: DetectOptions = {}, deps: DetectDeps = {}): DetectStats {
  const now = deps.now ?? (() => new Date());
  const stats: DetectStats = { sources: 0, pairs: 0, created: 0, confirmed: 0, disputed: 0, retracted: 0 };
  const runId = acquireRun(db, 'detect', { now });

  try {
    const sources = db.prepare(
      `SELECT id FROM sources WHERE active = 1 ${opts.sourceId ? 'AND id = ' + Number(opts.sourceId) : ''}`,
    ).all() as { id: number }[];

    const wipe = db.prepare('DELETE FROM changes WHERE source_id = ?');
    const insert = db.prepare(`
      INSERT INTO changes
        (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
         before_json, after_json, materiality, state, observed_at)
      VALUES (@sourceId, @from, @to, @type, @path, @before, @after, @materiality, 'candidate', @observedAt)
      ON CONFLICT (source_id, from_snapshot_id, to_snapshot_id, json_path) DO NOTHING
    `);

    db.transaction(() => {
      for (const source of sources) {
        stats.sources += 1;
        // Spec 12.2: backfill invalidates prior detection, so rebuild re-derives
        // from scratch. Free, because extractions are content-addressed.
        if (opts.rebuild) wipe.run(source.id);

        const observations = observationsFor(db, source.id);
        for (let i = 1; i < observations.length; i += 1) {
          const before = observations[i - 1]!;
          const after = observations[i]!;
          stats.pairs += 1;

          for (const change of diffPricing(before.data, after.data)) {
            const info = insert.run({
              sourceId: source.id,
              from: before.snapshotId,
              to: after.snapshotId,
              type: change.change_type,
              path: change.json_path,
              before: change.before_json,
              after: change.after_json,
              materiality: scoreMateriality(change),
              observedAt: after.observedAt,
            });
            if (info.changes > 0) stats.created += 1;
          }
        }
      }
    })();

    // Confirmation (spec 12.5) is wired in by Task 7; until then these stay 0.

    finishRun(db, runId, true, stats);
    return stats;
  } catch (err) {
    finishRun(db, runId, false, stats, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export { MATERIALITY_THRESHOLD };
```

- [ ] **Step 4: Add the `detect` command to `src/cli.ts`**

Insert after the `extract` command block:

```ts
program
  .command('detect')
  .description('derive change events from consecutive extractions')
  .option('--rebuild', 're-derive all change rows from scratch')
  .option('--source <id>', 'restrict to one source', v => Number(v))
  .action(async (options: { rebuild?: boolean; source?: number }) => {
    const { detect } = await import('./workflow/detect.js');
    const db = openDb(dbPath());
    const s = detect(db, { rebuild: options.rebuild, sourceId: options.source });
    console.log(
      `${s.sources} sources, ${s.pairs} state transitions: ${s.created} new changes, ` +
      `${s.confirmed} confirmed, ${s.disputed} disputed, ${s.retracted} retracted.`,
    );
    db.close();
  });
```

Also add it to the `start` sequence, immediately after the extract step:

```ts
    const { detect } = await import('./workflow/detect.js');
    const detectStats = await detect(db, {});
    console.log(`Detected ${detectStats.created} changes, ${detectStats.confirmed} confirmed.`);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx pnpm test tests/detect.test.ts`
Expected: PASS, 11 tests. `confirmed`, `disputed`, and `retracted` are 0 — Task 7 wires those in.

- [ ] **Step 5b: Run the whole suite and typecheck**

Run: `npx pnpm typecheck && npx pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/detect.ts src/cli.ts tests/detect.test.ts
git commit -m "feat: change detection with spec-12.2 pairing semantics"
```

---

## Task 7: Confirmation — the two-observation rule

**Files:**
- Create: `src/workflow/confirm.ts`
- Modify: `src/workflow/detect.ts` — call `confirmChanges` and report its counts
- Test: `tests/confirm.test.ts`

Spec 12.5. This is what stops a hallucinated price reaching the public feed, and it costs nothing: a real price change stays changed, an extraction phantom almost never reproduces.

**Interfaces:**
- Consumes: `observationsFor`, `Observation` from `src/workflow/detect.js`; `MATERIALITY_THRESHOLD`.
- Produces:
  - `confirmChanges(db: DB, opts?: { sourceId?: number }): ConfirmStats`
  - `interface ConfirmStats { examined: number; confirmed: number; disputed: number; retracted: number }`

- [ ] **Step 1: Write the failing test**

`tests/confirm.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { detect } from '../src/workflow/detect.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string; let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-confirm-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function observe(day: number, hash: string, price: number, confidence: 'high' | 'low' = 'high') {
  const at = `2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`;
  db.prepare(`INSERT INTO snapshots
    (source_id, observed_at, fetched_at, ok, http_status, raw_content, raw_hash, normalized_hash, provenance)
    VALUES (1, ?, ?, 1, 200, 'x', ?, ?, 'live')`).run(at, at, `r-${hash}`, hash);

  if (db.prepare('SELECT 1 FROM extractions WHERE normalized_hash = ?').get(hash)) return;
  db.prepare(`INSERT INTO extractions
    (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
     is_backfill, model, prompt_version, cost_micros, created_at)
    VALUES (?, 'pricing', ?, ?, 'USD', 1, 0, 'm', 'extract-pricing-v1', 9000, ?)`)
    .run(hash, JSON.stringify({
      currency: 'USD',
      tiers: [{
        name: 'Pro', monthly_price_usd: price, annual_price_usd: null,
        billing_unit: 'per_seat', included_seats: null,
        is_free: false, is_enterprise: false, headline_features: [],
      }],
      usage_rates: [], notes: null, extraction_confidence: confidence,
    }), confidence, at);
}

const states = () => db.prepare(
  "SELECT state, materiality FROM changes WHERE change_type = 'price_changed' ORDER BY id",
).all() as { state: string; materiality: number }[];

describe('confirmation', () => {
  it('leaves the newest change unconfirmed — nothing has agreed with it yet', () => {
    observe(18, 'a', 20); observe(19, 'b', 24);
    detect(db, {});
    expect(states()[0]!.state).toBe('candidate');
  });

  it('confirms once the new value is observed a second time', () => {
    observe(18, 'a', 20); observe(19, 'b', 24); observe(20, 'b', 24);
    const stats = detect(db, {});
    expect(stats.confirmed).toBe(1);
    expect(states()[0]!.state).toBe('confirmed');
  });

  it('disputes a change whose value moves again immediately (A->B->C)', () => {
    observe(18, 'a', 20); observe(19, 'b', 24); observe(20, 'c', 28);
    detect(db, {});
    const s = states();
    expect(s[0]!.state).toBe('disputed');   // 20->24 never reproduced
    expect(s[1]!.state).toBe('candidate');  // 24->28 is simply the newest
  });

  it('retracts a change that reverts (A->B->A)', () => {
    observe(18, 'a', 20); observe(19, 'b', 24); observe(20, 'a', 20);
    detect(db, {});
    expect(states()[0]!.state).toBe('retracted');
  });

  it('never confirms a change when either side is low confidence', () => {
    observe(18, 'a', 20); observe(19, 'b', 24, 'low'); observe(20, 'b', 24, 'low');
    detect(db, {});
    expect(states()[0]!.state).toBe('candidate');
  });

  it('never confirms a sub-threshold change', () => {
    observe(18, 'a', 20);
    db.prepare("UPDATE extractions SET data_json = json_set(data_json, '$.notes', 'x') WHERE normalized_hash = 'a'").run();
    observe(19, 'b', 20); observe(20, 'b', 20);
    detect(db, {});
    const minor = db.prepare('SELECT state FROM changes WHERE materiality < 40').all() as { state: string }[];
    expect(minor.every(c => c.state === 'candidate')).toBe(true);
  });

  it('is idempotent — re-running does not flip a confirmed change', () => {
    observe(18, 'a', 20); observe(19, 'b', 24); observe(20, 'b', 24);
    detect(db, {});
    const second = detect(db, {});
    expect(second.confirmed).toBe(0);       // already confirmed, not re-counted
    expect(states()[0]!.state).toBe('confirmed');
  });

  it('promotes a candidate to confirmed when tomorrow agrees', () => {
    observe(18, 'a', 20); observe(19, 'b', 24);
    detect(db, {});
    expect(states()[0]!.state).toBe('candidate');

    observe(20, 'b', 24);                   // the next day agrees
    detect(db, {});
    expect(states()[0]!.state).toBe('confirmed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm test tests/confirm.test.ts`
Expected: FAIL — `detect` reports `confirmed: 0` and states stay `candidate`.

- [ ] **Step 3: Write `src/workflow/confirm.ts`**

```ts
import type { DB } from '../ops/db.js';
import { MATERIALITY_THRESHOLD } from '../tools/materiality.js';
import { observationsFor } from './detect.js';

export interface ConfirmStats { examined: number; confirmed: number; disputed: number; retracted: number }

interface ChangeRow {
  id: number; source_id: number; to_snapshot_id: number;
  json_path: string; after_json: string | null; materiality: number; state: string;
}

/** Read one JSON path out of a stored PricingSnapshot, mirroring diff.ts's path grammar. */
function valueAt(data: unknown, path: string): unknown {
  const parts = path.split('.');
  if (parts[0] !== 'tiers') {
    return parts[0] === 'notes' ? (data as { notes?: unknown }).notes : undefined;
  }
  const tiers = (data as { tiers?: Array<Record<string, unknown>> }).tiers ?? [];
  const tier = tiers.find(t => t.name === parts[1]);
  if (!tier) return undefined;
  return parts.length >= 3 ? tier[parts[2]!] : tier;
}

/**
 * Spec 12.5. A candidate change is not published until its new value is
 * observed a second time.
 *
 *   value persists into the next observation      -> confirmed
 *   value reverts to what it was before           -> retracted
 *   value moves again immediately (A->B->C)       -> disputed
 *   nothing observed after it yet                 -> stays candidate
 *
 * `disputed` exists because persistence alone produces a false negative when a
 * price moves twice running: B appears once, so a real change would be dropped.
 */
export function confirmChanges(db: DB, opts: { sourceId?: number } = {}): ConfirmStats {
  const stats: ConfirmStats = { examined: 0, confirmed: 0, disputed: 0, retracted: 0 };

  const sources = db.prepare(
    `SELECT id FROM sources WHERE active = 1 ${opts.sourceId ? 'AND id = ' + Number(opts.sourceId) : ''}`,
  ).all() as { id: number }[];

  const setState = db.prepare('UPDATE changes SET state = ? WHERE id = ?');

  db.transaction(() => {
    for (const source of sources) {
      const observations = observationsFor(db, source.id);
      const indexOf = new Map(observations.map((o, i) => [o.snapshotId, i]));

      const pending = db.prepare(`
        SELECT id, source_id, to_snapshot_id, json_path, after_json, materiality, state
        FROM changes
        WHERE source_id = ? AND state IN ('candidate', 'disputed')
        ORDER BY id
      `).all(source.id) as ChangeRow[];

      for (const change of pending) {
        stats.examined += 1;

        // Sub-threshold changes are recorded but never published (spec 10).
        if (change.materiality < MATERIALITY_THRESHOLD) continue;

        const i = indexOf.get(change.to_snapshot_id);
        if (i === undefined) continue;

        const next = observations[i + 1];
        if (!next) continue;                       // nothing has agreed or disagreed yet

        // Either side low-confidence never leaves candidate (spec 12.5).
        const current = observations[i]!;
        if (current.confidence === 'low' || next.confidence === 'low') continue;

        const claimed = change.after_json === null ? null : JSON.parse(change.after_json);
        const actual = valueAt(next.data, change.json_path) ?? null;

        if (JSON.stringify(actual) === JSON.stringify(claimed)) {
          if (change.state !== 'confirmed') { setState.run('confirmed', change.id); stats.confirmed += 1; }
          continue;
        }

        const before = change.after_json === null ? null : JSON.parse(change.after_json);
        const priorValue = valueAt(observations[i - 1]?.data ?? {}, change.json_path) ?? null;
        void before;

        if (JSON.stringify(actual) === JSON.stringify(priorValue)) {
          setState.run('retracted', change.id);    // it went straight back — a phantom
          stats.retracted += 1;
        } else if (change.state !== 'disputed') {
          setState.run('disputed', change.id);     // moved again; needs a tiebreak (spec 12.5)
          stats.disputed += 1;
        }
      }
    }
  })();

  return stats;
}
```

- [ ] **Step 4: Wire confirmation into `src/workflow/detect.ts`**

Add the import beside the others:

```ts
import { confirmChanges } from './confirm.js';
```

Replace the placeholder comment left by Task 6 with the call:

```ts
    const confirmation = confirmChanges(db, { sourceId: opts.sourceId });
    stats.confirmed = confirmation.confirmed;
    stats.disputed = confirmation.disputed;
    stats.retracted = confirmation.retracted;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx pnpm test tests/confirm.test.ts tests/detect.test.ts`
Expected: PASS, 8 + 11 tests.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npx pnpm typecheck && npx pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/confirm.ts src/workflow/detect.ts tests/confirm.test.ts
git commit -m "feat: two-observation confirmation with disputed and retracted states"
```

---

## Task 8: Publish the tiers and the change feed

**Files:**
- Modify: `src/workflow/export.ts` — tiers on the board, new `changes.json`
- Modify: `web/lib/types.ts`, `web/components/BoardTable.tsx`, `web/app/page.tsx`
- Test: `tests/export.test.ts` (extend)

The board currently reports source health. This makes it report prices, which is the entire point of the milestone.

**Interfaces:**
- Consumes: `PricingSnapshot`, `MATERIALITY_THRESHOLD`.
- Produces: `board.json` gains `current_pricing` per source; new `changes.json`.

- [ ] **Step 1: Write the failing test**

Append to `tests/export.test.ts`:

```ts
describe('exportData — pricing', () => {
  function addExtraction(hash: string, price: number) {
    db.prepare(`INSERT INTO snapshots
      (source_id, observed_at, fetched_at, ok, http_status, raw_content, raw_hash, normalized_hash, provenance)
      VALUES (1, '2026-08-18T12:00:00.000Z', '2026-08-18T12:00:00.000Z', 1, 200, 'x', ?, ?, 'live')`)
      .run(`r-${hash}`, hash);
    db.prepare(`INSERT INTO extractions
      (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
       is_backfill, model, prompt_version, cost_micros, created_at)
      VALUES (?, 'pricing', ?, 'high', 'USD', 1, 0, 'm', 'extract-pricing-v1', 9000, '2026-08-18T12:00:00.000Z')`)
      .run(hash, JSON.stringify({
        currency: 'USD',
        tiers: [{
          name: 'Pro', monthly_price_usd: price, annual_price_usd: null,
          billing_unit: 'per_seat', included_seats: null,
          is_free: false, is_enterprise: false, headline_features: [],
        }],
        usage_rates: [], notes: null, extraction_confidence: 'high',
      }));
  }

  it('puts the latest tiers on the board', () => {
    addExtraction('h1', 20);
    exportData(db, out);
    const source = read('board.json').competitors.find((c: any) => c.slug === 'acme').sources[0];
    expect(source.current_pricing.tiers[0].name).toBe('Pro');
    expect(source.current_pricing.tiers[0].monthly_price_usd).toBe(20);
  });

  it('leaves current_pricing null when nothing is extracted yet', () => {
    exportData(db, out);
    const source = read('board.json').competitors.find((c: any) => c.slug === 'acme').sources[0];
    expect(source.current_pricing).toBeNull();
  });

  it('writes changes.json carrying only confirmed material changes', () => {
    addExtraction('h1', 20);
    db.prepare(`INSERT INTO changes
      (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
       before_json, after_json, materiality, state, observed_at)
      VALUES
      (1, 1, 1, 'price_changed', 'tiers.Pro.monthly_price_usd', '20', '24', 100, 'confirmed', '2026-08-18T12:00:00.000Z'),
      (1, 1, 1, 'notes_changed', 'notes', '"a"', '"b"', 5, 'candidate', '2026-08-18T12:00:00.000Z')`).run();

    const stats = exportData(db, out);
    expect(stats.files).toContain('changes.json');

    const feed = read('changes.json');
    expect(feed.changes).toHaveLength(1);
    expect(feed.changes[0].change_type).toBe('price_changed');
    expect(feed.changes[0].competitor).toBe('Acme');
  });

  it('counts confirmed changes for the commit message', () => {
    addExtraction('h1', 20);
    const stats = exportData(db, out);
    expect(stats.confirmedChanges).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm test tests/export.test.ts`
Expected: FAIL — `current_pricing` is undefined and `changes.json` is not produced.

- [ ] **Step 3: Extend `src/workflow/export.ts`**

Add to the imports:

```ts
import { MATERIALITY_THRESHOLD } from '../tools/materiality.js';
```

Add `confirmedChanges: number` to `ExportStats`.

In the source query, add a correlated subquery for the newest extraction:

```sql
      (SELECT e.data_json FROM snapshots sn
         JOIN extractions e ON e.normalized_hash = sn.normalized_hash
        WHERE sn.source_id = s.id AND sn.ok = 1
        ORDER BY sn.observed_at DESC, sn.id DESC LIMIT 1) AS current_pricing_json
```

Add `current_pricing_json: string | null` to `SourceRow`, and include it in each board source object:

```ts
      current_pricing: row.current_pricing_json === null
        ? null
        : JSON.parse(row.current_pricing_json) as unknown,
```

Build the change feed before the guards:

```ts
  const confirmed = db.prepare(`
    SELECT ch.id, ch.change_type, ch.json_path, ch.before_json, ch.after_json,
           ch.materiality, ch.observed_at, c.name AS competitor, c.slug
    FROM changes ch
    JOIN sources s ON s.id = ch.source_id
    JOIN competitors c ON c.id = s.competitor_id
    WHERE ch.state = 'confirmed' AND ch.materiality >= ?
    ORDER BY ch.observed_at DESC, ch.id DESC
    LIMIT 200
  `).all(MATERIALITY_THRESHOLD) as Record<string, unknown>[];

  const changesFeed = {
    generated_at: generatedAt,
    threshold: MATERIALITY_THRESHOLD,
    changes: confirmed.map(c => ({
      competitor: c.competitor,
      slug: c.slug,
      change_type: c.change_type,
      json_path: c.json_path,
      before: c.before_json === null ? null : JSON.parse(String(c.before_json)),
      after: c.after_json === null ? null : JSON.parse(String(c.after_json)),
      materiality: c.materiality,
      observed_at: c.observed_at,
    })),
  };
```

Add `'changes.json': changesFeed` to the `payloads` object, and return `confirmedChanges: confirmed.length` in `ExportStats`.

**Do not** relax the existing guards — `changes.json` legitimately starts empty, so the 50%-shrink guard must apply only to files that were non-empty before. Verify the existing guard already skips zero-length previous files; if it does not, make it skip them.

- [ ] **Step 4: Update the web types and board**

`web/lib/types.ts` — add:

```ts
export interface Tier {
  name: string;
  monthly_price_usd: number | null;
  annual_price_usd: number | null;
  billing_unit: 'per_seat' | 'flat' | 'usage' | 'unknown';
  included_seats: number | null;
  is_free: boolean;
  is_enterprise: boolean;
  headline_features: string[];
}

export interface CurrentPricing {
  currency: string;
  tiers: Tier[];
  usage_rates: { metric: string; unit_price_usd: number }[];
  notes: string | null;
  extraction_confidence: 'high' | 'medium' | 'low';
}
```

Add `current_pricing: CurrentPricing | null;` to `BoardSource`.

`web/components/BoardTable.tsx` — render tiers under each competitor. Add this cell content inside the existing source cell, below the `degraded_reason` block:

```tsx
                  {s.current_pricing && s.current_pricing.tiers.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {s.current_pricing.tiers.map(t => (
                        <li key={t.name} className="font-mono text-sm text-ink">
                          <span className="text-ink-secondary">{t.name}</span>{' '}
                          {t.monthly_price_usd === null
                            ? <span className="text-ink-muted">contact sales</span>
                            : <span>${t.monthly_price_usd}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
```

`web/app/page.tsx` — replace the "The record" section's subtitle, which currently promises prices are coming:

```tsx
        <p className="mt-2 max-w-2xl text-ink-secondary">
          Current tiers for every watched source, and whether the page is still readable.
          Confirmed price changes appear once a second observation agrees.
        </p>
```

- [ ] **Step 5: Run tests and build**

```bash
npx pnpm typecheck && npx pnpm test
cd web && npx pnpm build && cd ..
```
Expected: all green; `web/out/index.html` produced.

- [ ] **Step 6: Run the full pipeline against the real archive**

```bash
LLM_ENABLED=true npx pnpm bw extract
npx pnpm bw detect
npx pnpm bw export
npx tsx -e "
import { readFileSync } from 'node:fs';
const b=JSON.parse(readFileSync('web/public/data/board.json','utf8'));
for (const c of b.competitors) {
  const p=c.sources[0].current_pricing;
  console.log(c.name.padEnd(10), p ? p.tiers.map(t=>t.name+' '+(t.monthly_price_usd??'contact')).join(', ') : '(none)');
}"
```

**Put that table in your report, and check it against the live pricing pages yourself.** This is the only step where a wrong-but-plausible extraction gets caught. Report the total spend:

```bash
npx tsx -e "
import Database from 'better-sqlite3';
const db=new Database('./data/bellwether.db',{readonly:true});
const r=db.prepare('SELECT COUNT(*) n, SUM(cost_micros) c FROM extractions').get();
console.log(r.n, 'extractions, \$' + (r.c/1e6).toFixed(4));"
```

- [ ] **Step 7: Commit**

```bash
git add src/workflow/export.ts web/lib/types.ts web/components/BoardTable.tsx web/app/page.tsx tests/export.test.ts web/public/data
git commit -m "feat: publish current tiers and the confirmed change feed"
```

---

## M2 Definition of Done

- [ ] `npx pnpm test` passes; `npx pnpm typecheck` clean
- [ ] `LLM_ENABLED=false npx pnpm bw extract` hashes every snapshot and spends nothing
- [ ] Every one of the six competitors has a `current_pricing` with plausible tier names and prices, **checked by eye against the live pages**
- [ ] Total extraction spend for the six is under $0.15
- [ ] A second `bw extract` extracts nothing — the content-addressed cache holds
- [ ] `bw detect` runs clean and is idempotent
- [ ] The board renders tiers; `changes.json` exists (empty is correct until a price actually moves)
- [ ] `docker compose up -d --build` on the homelab runs collect → extract → detect → export

## Not in M2

Wayback backfill, `detect --rebuild` invoked automatically by backfill, the timeline chart, weekly synthesis and digests, the dataset page, RSS, `llms.txt`, Telegram alerts, and B2 backup. Those are M3 through M5 in spec section 18.

## Spec Coverage

| Spec | Requirement | Task |
|---|---|---|
| 8 | `PricingSnapshot`, `Tier`, `EXTRACT_PROMPT_VERSION` | 1 |
| 9 gate 2 | Normalized hash gate | 1, 5 |
| 9 gate 3 | Extraction cache keyed `(normalized_hash, prompt_version)` | 5 |
| 9 gate 4 | Haiku + Zod, retry once on validation failure | 4 |
| 9 gate 5 | Object diff, never a text diff | 2 |
| 9 gate 6 | Materiality threshold | 2 |
| 9 gate 7 | Two-observation confirmation | 7 |
| 9.1 | Strip noise, always slice, collapse, re-hash | 1 |
| 9.2 | Token guard, 20k cap, real `countTokens` | 3, 4 |
| 10 | Materiality table and threshold 40 | 2 |
| 12.2 | Pairing rule; `--rebuild` | 6 |
| 12.3 | Four-stage tier identity, `tier_renamed` | 2 |
| 12.4 | USD-only diffing, mismatch flagged | 5, 6 |
| 12.5 | `candidate -> confirmed \| disputed \| retracted` | 7 |
| 12.6 | Grounding assertion, retry once, then degrade | 3, 4, 5 |
| 15.1 | `LLM_ENABLED` kill switch | 3, 5 |
| 15.2 | $5/month recurring ceiling, backfill excluded | 3, 5 |
| 14.2 | Board shows real tiers | 8 |

Deliberately deferred, with the milestone that owns them: spec 12.1 backfill (M3), 12.5 disputed re-extraction tiebreak (M3 — the `disputed` state is recorded now, resolved when backfill provides the extra observations), 13 synthesis (M4), 14.3 timeline (M3), 14.4 distribution (M4), 15.3 heartbeat and 7.3 backup (M5).

## Self-Review Record

Three issues found and fixed before this plan was committed:

1. **Task 6 imported a module Task 7 creates**, so it could not pass its own tests — the exact "independently testable deliverable" rule the process exists to enforce. `detect` now stands alone reporting zero confirmations, and Task 7 wires `confirmChanges` in.
2. **Deduplicated snapshots would never have been hashed.** Task 5's queue selects rows with `raw_content IS NOT NULL`, but spec 7.2 stores NULL content whenever a hash repeats — so every repeat-day snapshot would keep `normalized_hash = NULL` and `detect`'s pairing rule (spec 12.2) would skip it forever. `extract` now propagates the computed hash to sibling rows sharing a `raw_hash`.
3. **`changes.json` starts empty and would trip the export shrink guard** the first time a change appears and then the feed is regenerated. Task 8 step 3 calls this out explicitly rather than leaving the implementer to discover it in production.
