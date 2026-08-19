# Bellwether M3 — Wayback Backfill and Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed the archive with 18 months of historical pricing captures from the Internet Archive, so the change feed and a per-tier price timeline have real history on day one instead of accumulating it over months.

**Architecture:** A new `wayback` tool discovers captures via the CDX API and builds `id_` capture URLs. A new `backfill` workflow enqueues those captures into the existing `backfill_queue` table, then drains it one row at a time through the existing `politeFetch` at a slower rate limit, writing snapshots with `observed_at` set to the *capture* time and `provenance` set to `wayback:<ts>`. Everything downstream — normalize, extract, detect, confirm, export — is reused unchanged except for two defect fixes that historical snapshots expose. Backfill finishes by invoking `detect --rebuild`, which is free because extractions are content-addressed.

**Tech Stack:** Node 24 LTS, TypeScript ESM strict (`noUncheckedIndexedAccess`), better-sqlite3, Zod, Vitest, commander, Next.js App Router static export, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-18-bellwether-design.md` — sections 7 (schema), 12.1 (backfill), 12.2 (detection semantics and rebuild), 12.4 (currency), 12.5 (confirmation), 14.3 (UI), 15.2 (budget).

## Global Constraints

- **The LLM never decides control flow.** Every branch in this milestone is code. No task here adds an LLM call; backfill reuses the existing `extract` workflow verbatim.
- **`snapshots.observed_at` is the CAPTURE time, not the fetch time** (spec 12.1). Getting this wrong puts eighteen months of history on today's date and silently destroys the entire milestone.
- **`provenance` is `'live'` or `'wayback:<14-digit-ts>'`** (spec 7 schema comment). No other values.
- **Wayback rate limit is 1 request per 4 seconds** (spec 12.1). Never reuse the default 10s/3s `HostRateLimiter`; never go faster than 4s.
- **Capture URLs use the `id_` suffix**: `https://web.archive.org/web/<ts>id_/<url>`. Without `id_` the Archive injects its toolbar into the HTML and every normalized hash is wrong.
- **Backfill is restartable any number of times** and resumes from `backfill_queue.state='pending'` (spec 12.1).
- **Backfill carries its own explicit one-time budget** (`--budget`, default 10.00 USD), tracked separately from the recurring monthly ceiling (spec 15.2). `monthlySpendMicros` already excludes `is_backfill = 1` rows; do not change it.
- **No new runtime dependencies.** Everything needed is installed.
- TypeScript strict with `noUncheckedIndexedAccess`: index access yields `T | undefined`. Use `!` only where a preceding bound check proves it.
- Tests are Vitest, live in `tests/`, and use a temp-dir SQLite database built with `migrate(db, join(process.cwd(), 'migrations'))`. Follow the existing `tests/collect.test.ts` setup shape exactly.
- Every workflow acquires a run lock: `acquireRun(db, kind, { now })` / `finishRun(db, runId, ok, stats, error?)`, with `finishRun(..., false, ...)` in a catch that rethrows.
- Commit after every task with a conventional-commit message.

## Rulings made before execution

These resolve conflicts between the spec and the actual scale of this milestone. Each is binding on the tasks below.

**R1 — The Message Batches API is NOT used.** Spec 12.1 mandates routing the backfill corpus through the Message Batches API at 50% cost. That requirement is written for a 50-100 competitor watch list producing ~3,600 extractions. This milestone backfills six competitors: the CDX API returns roughly 20 captures per URL over 18 months, so the corpus is ~120 extractions costing about $1.20 synchronously, and content-addressed dedup will cut that further. Batches would add a submit / poll / retrieve / reconcile state machine plus a variance check, several hundred lines, to save roughly sixty cents. The synchronous `extract` workflow is already built, already reviewed, and already proven against these six pages. *Cost if wrong:* the backfill takes minutes longer and costs about $0.60 more. Revisit at M3.5 when the watch list expands — the upgrade point is a single call site in `runBackfill`.

**R2 — CDX results are NOT collapsed by `digest`.** The CDX API accepts `collapse=digest`, which would drop adjacent byte-identical captures and save fetches. It must not be used. Confirmation (spec 12.5, backfill path) promotes a change when its new value is observed a *second* time, and `confirmChanges` reads the raw non-collapsing snapshot stream precisely because a second observation of an unchanged page *is* a repeated hash. Collapsing identical digests at the CDX layer deletes exactly the evidence confirmation consumes, and every backfilled change would sit in `candidate` forever. Use `collapse=timestamp:6` only, as the spec says. *Cost if wrong:* the entire backfilled change history is silently unpublishable.

**R3 — Backfill must never mark a source degraded.** Two paths in the current pipeline write `sources.degraded_reason`: `collect`'s canary/price health check, and `extract`'s failure handler. Backfill does not go through `collect`, so the first is not a risk. The second is: an 18-month-old capture that trips the 20,000-token guard, or fails grounding, currently calls `degrade.run(...)` and paints the *live* source red on the public dashboard forever. A historical page failing today's extraction is a fact about 2025, not a health signal about today. Task 2 fixes this. *Cost if wrong:* the status board shows permanent false failures that no live collection can clear.

**R4 — `extractions.is_backfill` is derived from the triggering snapshot's provenance.** `extract` currently hardcodes `is_backfill` to 0. Extractions are keyed on `normalized_hash` and shared between live and historical snapshots, so a hash first seen in a wayback capture and later matched by a live fetch keeps `is_backfill = 1`. That is correct: the row records which budget actually paid for the call. *Cost if wrong:* up to ~$1.20 of one-time historical spend counts against the $5 recurring monthly cap, which could stall live extraction for the remainder of the month.

## File Structure

| File | Responsibility |
|---|---|
| `src/tools/wayback.ts` (create) | Pure functions: build the CDX query URL, parse its JSON response, convert a 14-digit Wayback timestamp to ISO 8601, build an `id_` capture URL. No I/O, no database. |
| `src/workflow/extract.ts` (modify) | Read `provenance` alongside each pending snapshot; set `is_backfill` from it (R4); suppress source degradation for wayback rows (R3). |
| `src/workflow/backfill.ts` (create) | Discovery (CDX → `backfill_queue`) and drain (queue → `snapshots`), plus the pre-flight budget estimate and the end-to-end `runBackfill` orchestration. |
| `src/cli.ts` (modify) | `bellwether backfill` command with `--months`, `--budget`, `--limit`, `--discover-only`. |
| `src/workflow/export.ts` (modify) | Emit `timeline.json`: per competitor, per tier, the monthly price series with change markers. |
| `web/components/Timeline.tsx` (create) | Inline-SVG sparkline per competitor. No charting dependency. |
| `web/app/page.tsx` (modify) | Render the timeline section beneath the board. |
| `tests/wayback.test.ts`, `tests/backfill.test.ts`, `tests/timeline.test.ts` (create) | Unit coverage per task. |
| `tests/extract.test.ts` (modify) | Cover the two behaviour changes from Task 2. |

---

### Task 1: Wayback CDX tool

Pure functions only. Everything that touches the network or the database lives in Task 3/4 so this file stays trivially testable.

**Files:**
- Create: `src/tools/wayback.ts`
- Test: `tests/wayback.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface Capture { timestamp: string; original: string; statusCode: string; digest: string }`
  - `export function cdxQueryUrl(targetUrl: string, opts: { from: string; to: string }): string`
  - `export function parseCdxResponse(body: string): Capture[]`
  - `export function waybackTimestampToIso(ts: string): string | null`
  - `export function captureUrl(timestamp: string, targetUrl: string): string`
  - `export const WAYBACK_HOST = 'web.archive.org'`

**Background the implementer needs:**

The CDX API is queried like this (verified live 2026-08-19):

```
https://web.archive.org/cdx/search/cdx?url=linear.app/pricing&output=json&collapse=timestamp:6&filter=statuscode:200&from=20250101&to=20260818&fl=timestamp,original,statuscode,digest
```

and answers with a JSON array of arrays whose **first row is a header**:

```json
[["timestamp","original","statuscode","digest"],
 ["20250116002909","https://linear.app/pricing","200","WX2LGBDCOKJPDZ3RLZFLCUZZX3BZHELJ"],
 ["20250209133622","https://linear.app/pricing","200","WOXAZAMX4OOYS4ATMQVL24KAIKKH6TIJ"]]
```

When nothing matches, the API returns an **empty body** (zero bytes), not `[]`. That is not an error.

`collapse=timestamp:6` collapses on the first six digits of the timestamp — one capture per calendar month. Do **not** add `collapse=digest` (ruling R2 above).

`from`/`to` are 14-digit Wayback timestamps, but the API accepts truncated forms; pass full 8-digit `YYYYMMDD` values.

- [ ] **Step 1: Write the failing tests**

Create `tests/wayback.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  captureUrl, cdxQueryUrl, parseCdxResponse, waybackTimestampToIso, WAYBACK_HOST,
} from '../src/tools/wayback.js';

describe('cdxQueryUrl', () => {
  it('asks for one capture per month, 200s only, with the fields we parse', () => {
    const url = new URL(cdxQueryUrl('https://linear.app/pricing', { from: '20250101', to: '20260818' }));
    expect(url.host).toBe(WAYBACK_HOST);
    expect(url.pathname).toBe('/cdx/search/cdx');
    expect(url.searchParams.get('url')).toBe('https://linear.app/pricing');
    expect(url.searchParams.get('output')).toBe('json');
    expect(url.searchParams.get('collapse')).toBe('timestamp:6');
    expect(url.searchParams.get('filter')).toBe('statuscode:200');
    expect(url.searchParams.get('from')).toBe('20250101');
    expect(url.searchParams.get('to')).toBe('20260818');
    expect(url.searchParams.get('fl')).toBe('timestamp,original,statuscode,digest');
  });

  it('never collapses on digest — that would delete the confirmation signal (R2)', () => {
    expect(cdxQueryUrl('https://x.test/p', { from: '20250101', to: '20260101' }))
      .not.toContain('digest&');
  });
});

describe('parseCdxResponse', () => {
  const BODY = JSON.stringify([
    ['timestamp', 'original', 'statuscode', 'digest'],
    ['20250116002909', 'https://linear.app/pricing', '200', 'AAA'],
    ['20250209133622', 'https://linear.app/pricing', '200', 'BBB'],
  ]);

  it('drops the header row', () => {
    const captures = parseCdxResponse(BODY);
    expect(captures).toHaveLength(2);
    expect(captures[0]).toEqual({
      timestamp: '20250116002909',
      original: 'https://linear.app/pricing',
      statusCode: '200',
      digest: 'AAA',
    });
  });

  it('treats an empty body as no captures, not an error', () => {
    expect(parseCdxResponse('')).toEqual([]);
    expect(parseCdxResponse('   \n')).toEqual([]);
  });

  it('returns nothing for a body that is not JSON rather than throwing', () => {
    expect(parseCdxResponse('<html>502 Bad Gateway</html>')).toEqual([]);
  });

  it('skips rows that are short, mistyped, or carry a bad timestamp', () => {
    const body = JSON.stringify([
      ['timestamp', 'original', 'statuscode', 'digest'],
      ['20250116002909', 'https://a.test/p', '200', 'AAA'],
      ['2025', 'https://a.test/p', '200', 'SHORT_TS'],
      ['20250209133622', 'https://a.test/p'],
      [20250309133622, 'https://a.test/p', '200', 'NUMERIC'],
      ['20250409133622', 'https://a.test/p', '404', 'NOT_200'],
    ]);
    const captures = parseCdxResponse(body);
    expect(captures.map(c => c.digest)).toEqual(['AAA']);
  });

  it('returns nothing when the payload is not an array of arrays', () => {
    expect(parseCdxResponse('{"error":"blocked"}')).toEqual([]);
    expect(parseCdxResponse('[]')).toEqual([]);
  });
});

describe('waybackTimestampToIso', () => {
  it('converts a 14-digit capture stamp to UTC ISO 8601', () => {
    expect(waybackTimestampToIso('20250116002909')).toBe('2025-01-16T00:29:09.000Z');
  });

  it('sorts lexically against the ISO stamps live collection writes', () => {
    const historical = waybackTimestampToIso('20250116002909')!;
    const live = '2026-08-19T07:00:00.000Z';
    expect(historical < live).toBe(true);
  });

  it('rejects anything that is not 14 digits', () => {
    expect(waybackTimestampToIso('2025')).toBeNull();
    expect(waybackTimestampToIso('2025011600290x')).toBeNull();
    expect(waybackTimestampToIso('202501160029099')).toBeNull();
  });

  it('rejects a stamp whose digits are not a real calendar instant', () => {
    expect(waybackTimestampToIso('20250132002909')).toBeNull();  // 32 January
    expect(waybackTimestampToIso('20251316002909')).toBeNull();  // month 13
    expect(waybackTimestampToIso('20250116256109')).toBeNull();  // hour 25
  });
});

describe('captureUrl', () => {
  it('inserts the id_ suffix so the Archive returns original bytes', () => {
    expect(captureUrl('20250116002909', 'https://linear.app/pricing'))
      .toBe('https://web.archive.org/web/20250116002909id_/https://linear.app/pricing');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/wayback.test.ts`
Expected: FAIL — `Failed to resolve import "../src/tools/wayback.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/tools/wayback.ts`:

```ts
export const WAYBACK_HOST = 'web.archive.org';

/** One row of a CDX response, after the header row is dropped. */
export interface Capture {
  timestamp: string;
  original: string;
  statusCode: string;
  digest: string;
}

/**
 * Spec 12.1. `collapse=timestamp:6` yields one capture per calendar month.
 *
 * Deliberately NOT collapsed on `digest`: confirmation (spec 12.5) promotes a
 * change only when its new value is observed a second time, and a second
 * observation of an unchanged page IS a repeated digest. Collapsing them here
 * would delete the exact evidence confirmation consumes, leaving every
 * backfilled change stuck in `candidate` forever.
 */
export function cdxQueryUrl(targetUrl: string, opts: { from: string; to: string }): string {
  const url = new URL(`https://${WAYBACK_HOST}/cdx/search/cdx`);
  url.searchParams.set('url', targetUrl);
  url.searchParams.set('output', 'json');
  url.searchParams.set('collapse', 'timestamp:6');
  url.searchParams.set('filter', 'statuscode:200');
  url.searchParams.set('from', opts.from);
  url.searchParams.set('to', opts.to);
  url.searchParams.set('fl', 'timestamp,original,statuscode,digest');
  return url.toString();
}

/**
 * Never throws. A CDX outage answers with an HTML error page or an empty body,
 * and neither is worth failing a multi-hour resumable backfill over — the
 * caller records "no captures found" and the next run retries.
 */
export function parseCdxResponse(body: string): Capture[] {
  if (body.trim() === '') return [];       // the API's genuine "no matches" answer

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) return [];

  const captures: Capture[] = [];
  for (const row of payload.slice(1)) {    // row 0 is the header
    if (!Array.isArray(row) || row.length < 4) continue;
    const [timestamp, original, statusCode, digest] = row;
    if (typeof timestamp !== 'string' || typeof original !== 'string') continue;
    if (typeof statusCode !== 'string' || typeof digest !== 'string') continue;
    if (statusCode !== '200') continue;    // belt and braces; the filter already asks for this
    if (waybackTimestampToIso(timestamp) === null) continue;
    captures.push({ timestamp, original, statusCode, digest });
  }
  return captures;
}

/**
 * `20250116002909` -> `2025-01-16T00:29:09.000Z`.
 *
 * This value becomes `snapshots.observed_at`, which detect (spec 12.2) orders
 * by and confirm compares as a string, so it must be the same ISO shape live
 * collection writes. Returns null rather than an Invalid Date for anything
 * malformed: an unparseable stamp must skip the capture, never date it to the
 * epoch or to today.
 */
export function waybackTimestampToIso(ts: string): string | null {
  if (!/^\d{14}$/.test(ts)) return null;

  const year = Number(ts.slice(0, 4));
  const month = Number(ts.slice(4, 6));
  const day = Number(ts.slice(6, 8));
  const hour = Number(ts.slice(8, 10));
  const minute = Number(ts.slice(10, 12));
  const second = Number(ts.slice(12, 14));

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  // Date.UTC silently rolls 32 January into 1 February. Round-tripping the
  // components back out is what actually rejects a nonsense stamp.
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day || date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
  ) return null;

  return date.toISOString();
}

/**
 * The `id_` suffix asks the Archive for the original stored bytes. Without it
 * the response carries an injected Archive toolbar, which changes the DOM,
 * changes every normalized hash, and makes historical snapshots incomparable
 * with live ones.
 */
export function captureUrl(timestamp: string, targetUrl: string): string {
  return `https://${WAYBACK_HOST}/web/${timestamp}id_/${targetUrl}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/wayback.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/wayback.ts tests/wayback.test.ts
git commit -m "feat(wayback): CDX discovery and capture-URL helpers"
```

---

### Task 2: Make `extract` provenance-aware

Two defects in the existing `extract` workflow only bite once historical snapshots exist. Both are fixed here, **before** any backfill can run, so the first backfill never produces a red dashboard or a blown budget.

**Defect A (R3).** `extract` calls `degrade.run(...)` on `sources` whenever an extraction fails. A 2025 capture that trips the 20,000-token guard or fails grounding would therefore mark the *live* source degraded, painting it red on the public status board permanently — no live collection can clear it, because the historical snapshot stays in the pending set forever.

**Defect B (R4).** `insertExtraction` hardcodes `is_backfill` to 0. `monthlySpendMicros` (`src/agents/_client.ts`) already excludes `is_backfill = 1` from the recurring ceiling, so leaving this at 0 charges the whole one-time historical corpus against the $5/month live cap.

**Files:**
- Modify: `src/workflow/extract.ts`
- Modify: `tests/extract.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ExtractStats` gains one field — `historicalFailed: number`. Task 5's CLI output prints it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/extract.test.ts` (keep the file's existing imports and `beforeEach` setup; add `describe` blocks at the end):

```ts
describe('historical snapshots (spec 12.1)', () => {
  /** Insert a snapshot directly, bypassing collect, the way backfill does. */
  function insertWayback(sourceId: number, ts: string, body: string): void {
    const iso = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T00:00:00.000Z`;
    db.prepare(`
      INSERT INTO snapshots
        (source_id, observed_at, fetched_at, ok, http_status, error,
         raw_content, raw_hash, normalized_hash, provenance)
      VALUES (?, ?, ?, 1, 200, NULL, ?, ?, NULL, ?)
    `).run(sourceId, iso, iso, body, `hash-${ts}`, `wayback:${ts}`);
  }

  it('never marks a source degraded when a historical extraction fails (R3)', async () => {
    insertWayback(1, '20250116000000', '<html><h2>Pro</h2><p>$20/mo</p></html>');

    const stats = await extract(
      db,
      {},
      {
        env: { LLM_ENABLED: 'true' },
        extractor: async () => ({ ok: false, reason: 'oversized', detail: '31000 tokens exceeds the 20000 budget' }),
      },
    );

    const source = db.prepare('SELECT degraded_reason FROM sources WHERE id = 1').get() as { degraded_reason: string | null };
    expect(source.degraded_reason).toBeNull();
    expect(stats.historicalFailed).toBe(1);
    expect(stats.degraded).toBe(0);
  });

  it('still marks a source degraded when a LIVE extraction fails', async () => {
    db.prepare(`
      INSERT INTO snapshots
        (source_id, observed_at, fetched_at, ok, http_status, error,
         raw_content, raw_hash, normalized_hash, provenance)
      VALUES (1, '2026-08-19T07:00:00.000Z', '2026-08-19T07:00:00.000Z', 1, 200, NULL,
              '<html><h2>Pro</h2><p>$20/mo</p></html>', 'live-hash', NULL, 'live')
    `).run();

    const stats = await extract(
      db,
      {},
      {
        env: { LLM_ENABLED: 'true' },
        extractor: async () => ({ ok: false, reason: 'ungrounded', detail: 'price 20 not in source' }),
      },
    );

    const source = db.prepare('SELECT degraded_reason FROM sources WHERE id = 1').get() as { degraded_reason: string | null };
    expect(source.degraded_reason).toContain('ungrounded');
    expect(stats.degraded).toBe(1);
    expect(stats.historicalFailed).toBe(0);
  });

  it('tags a historical extraction is_backfill=1 so it misses the recurring cap (R4)', async () => {
    insertWayback(1, '20250116000000', '<html><h2>Pro</h2><p>$20/mo</p></html>');

    await extract(db, {}, { env: { LLM_ENABLED: 'true' }, extractor: OK_EXTRACTOR });

    const row = db.prepare('SELECT is_backfill, cost_micros FROM extractions').get() as
      { is_backfill: number; cost_micros: number };
    expect(row.is_backfill).toBe(1);
    expect(monthlySpendMicros(db, new Date('2026-08-19T00:00:00.000Z'))).toBe(0);
  });

  it('tags a live extraction is_backfill=0 so it does count against the cap', async () => {
    db.prepare(`
      INSERT INTO snapshots
        (source_id, observed_at, fetched_at, ok, http_status, error,
         raw_content, raw_hash, normalized_hash, provenance)
      VALUES (1, '2026-08-19T07:00:00.000Z', '2026-08-19T07:00:00.000Z', 1, 200, NULL,
              '<html><h2>Pro</h2><p>$20/mo</p></html>', 'live-hash', NULL, 'live')
    `).run();

    await extract(db, {}, { env: { LLM_ENABLED: 'true' }, extractor: OK_EXTRACTOR });

    const row = db.prepare('SELECT is_backfill FROM extractions').get() as { is_backfill: number };
    expect(row.is_backfill).toBe(0);
    expect(monthlySpendMicros(db, new Date('2026-08-19T00:00:00.000Z'))).toBeGreaterThan(0);
  });
});
```

Add to the top of `tests/extract.test.ts`:

```ts
import { monthlySpendMicros } from '../src/agents/_client.js';
```

and, if the file does not already define one, a shared success extractor beside the other fixtures:

```ts
const OK_EXTRACTOR = async () => ({
  ok: true as const,
  data: {
    tiers: [{ name: 'Pro', monthly_price_usd: 20, annual_price_usd: null, billing_unit: 'per user',
              included_seats: null, headline_features: [], is_free: false, is_enterprise: false }],
    usage_rates: [], currency: 'USD', notes: null, extraction_confidence: 'high' as const,
  },
  inputTokens: 1000, outputTokens: 200, costMicros: 2000, attempts: 1,
});
```

> **Implementer note:** `tests/extract.test.ts` already exists and already has a `beforeEach` that opens a temp DB, migrates, and seeds one `acme` competitor with source id 1. Reuse it; do not rewrite the file. If the file already defines an equivalent success extractor under a different name, use that instead of adding `OK_EXTRACTOR`, and adjust the shape above to match `PricingSnapshotData` exactly as `src/schema/pricing.ts` defines it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/extract.test.ts`
Expected: FAIL — `historicalFailed` is undefined, `is_backfill` is 0 for the wayback row, and the source gets degraded.

- [ ] **Step 3: Implement**

In `src/workflow/extract.ts`:

**3a.** Add the field to `ExtractStats`:

```ts
export interface ExtractStats {
  considered: number; hashed: number; cached: number;
  extracted: number; skipped: number; degraded: number; mismatched: number;
  historicalFailed: number;
}
```

and to its initializer:

```ts
  const stats: ExtractStats = {
    considered: 0, hashed: 0, cached: 0, extracted: 0, skipped: 0,
    degraded: 0, mismatched: 0, historicalFailed: 0,
  };
```

**3b.** Add `provenance` to `PendingRow` and to the pending query:

```ts
interface PendingRow {
  id: number; source_id: number; raw_content: string | null;
  raw_hash: string | null; normalized_hash: string | null; provenance: string;
}
```

```ts
    const pending = db.prepare(`
      SELECT s.id, s.source_id, s.raw_content, s.raw_hash, s.normalized_hash, s.provenance
      FROM snapshots s
      WHERE s.ok = 1 AND s.raw_content IS NOT NULL
      ORDER BY s.observed_at, s.id
    `).all() as PendingRow[];
```

**3c.** Parameterize `is_backfill` in the insert:

```ts
    const insertExtraction = db.prepare(`
      INSERT INTO extractions
        (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
         is_backfill, model, prompt_version, input_tokens, output_tokens, cost_micros, created_at)
      VALUES (@hash, 'pricing', @data, @confidence, @currency, 1,
              @isBackfill, @model, @promptVersion, @inputTokens, @outputTokens, @costMicros, @createdAt)
    `);
```

**3d.** Inside the loop, immediately after `stats.considered += 1;` and the null-content guard, derive the flag once:

```ts
      // Spec 7 schema: provenance is 'live' or 'wayback:<ts>'. An extraction is
      // keyed on normalized_hash and shared between historical and live
      // snapshots; whichever one triggered the call is the budget that paid for
      // it, so the flag records that and is never rewritten afterwards.
      const historical = row.provenance.startsWith('wayback:');
```

**3e.** Replace the failure branch:

```ts
      if (!result.ok) {
        // Spec 12.1 / ruling R3: a capture from 2025 failing today's extraction
        // is a fact about that page in 2025, not a health signal about the
        // source today. Degrading here would paint the live source red on the
        // public status board with no path back — every later `extract` pass
        // re-reads the same historical snapshot and re-degrades it.
        if (historical) {
          stats.historicalFailed += 1;
        } else {
          stats.degraded += 1;
          degrade.run(`extraction ${result.reason}: ${result.detail}`.slice(0, 300), row.source_id);
        }
        if (opts.limit !== undefined && llmCalls >= opts.limit) break;
        continue;
      }
```

**3f.** Pass the flag at the insert call site:

```ts
      insertExtraction.run({
        hash: normalizedHash,
        data: JSON.stringify(result.data),
        confidence: result.data.extraction_confidence,
        currency: result.data.currency,
        isBackfill: historical ? 1 : 0,
        model: EXTRACT_MODEL,
        promptVersion: EXTRACT_PROMPT_VERSION,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicros: result.costMicros,
        createdAt: now().toISOString(),
      });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/extract.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the two CLI call sites that print `ExtractStats`**

`src/cli.ts` prints extract stats in two places — the `extract` command and the `start` command. Add the new counter to both so a historical failure is never silent:

```ts
    console.log(
      `Considered ${s.considered}: ${s.extracted} extracted, ${s.cached} cached, ` +
      `${s.hashed} hashed, ${s.skipped} skipped, ${s.degraded} degraded, ` +
      `${s.historicalFailed} historical failed, ${s.mismatched} non-USD.`,
    );
```

- [ ] **Step 6: Full suite and typecheck**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all green. Every pre-existing test must still pass — live snapshots carry `provenance = 'live'`, so their behaviour is unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/extract.ts src/cli.ts tests/extract.test.ts
git commit -m "fix(extract): never degrade a source on a historical extraction failure

Also tags extractions triggered by a wayback snapshot is_backfill=1 so the
one-time historical corpus is charged to the backfill budget rather than the
recurring monthly ceiling. Both defects are latent until M3 inserts the first
historical snapshot."
```

---

### Task 3: Capture discovery — CDX into `backfill_queue`

**Files:**
- Create: `src/workflow/backfill.ts`
- Test: `tests/backfill.test.ts`

**Interfaces:**
- Consumes: `cdxQueryUrl`, `parseCdxResponse`, `waybackTimestampToIso`, `captureUrl`, `WAYBACK_HOST` from `src/tools/wayback.js` (Task 1); `politeFetch`, `RobotsCache`, `FetchResult` from `src/tools/fetch.js`; `HostRateLimiter` from `src/tools/ratelimit.js`.
- Produces:
  - `export const WAYBACK_MIN_INTERVAL_MS = 4_000`
  - `export const WAYBACK_JITTER_MS = 1_000`
  - `export const DEFAULT_BACKFILL_MONTHS = 18`
  - `export function waybackFetcher(): (url: string) => Promise<FetchResult>`
  - `export interface DiscoverStats { sources: number; found: number; enqueued: number; duplicate: number; failed: number }`
  - `export async function discoverCaptures(db: DB, opts?: DiscoverOptions, deps?: BackfillDeps): Promise<DiscoverStats>`

**Critical: the shared rate limiter.**

`politeFetch(url)` called with no `deps` constructs a **fresh** `HostRateLimiter` per call, so consecutive calls do not throttle each other at all. Live collection gets away with this because its six sources are on six distinct hosts. Backfill sends every one of ~120 requests to a single host, `web.archive.org`. It **must** build one `HostRateLimiter(4000, 1000)` and one `RobotsCache` bound to it, and pass both into every `politeFetch` call for the whole run. `waybackFetcher()` exists to make that impossible to get wrong — build it once in `runBackfill` (Task 5) and thread it through both discovery and drain.

- [ ] **Step 1: Write the failing tests**

Create `tests/backfill.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { discoverCaptures } from '../src/workflow/backfill.js';
import type { FetchResult } from '../src/tools/fetch.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme',
  name: 'Acme',
  homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

const NOW = () => new Date('2026-08-19T07:00:00.000Z');

function cdxBody(...timestamps: string[]): string {
  return JSON.stringify([
    ['timestamp', 'original', 'statuscode', 'digest'],
    ...timestamps.map((ts, i) => [ts, 'https://acme.test/pricing', '200', `D${i}`]),
  ]);
}

function ok(body: string): FetchResult {
  return { ok: true, httpStatus: 200, body, error: null };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-backfill-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('discoverCaptures', () => {
  it('enqueues one row per capture, with the id_ target URL', async () => {
    const stats = await discoverCaptures(db, {}, {
      fetcher: async () => ok(cdxBody('20250116002909', '20250209133622')),
      now: NOW,
    });

    expect(stats).toMatchObject({ sources: 1, found: 2, enqueued: 2, duplicate: 0, failed: 0 });

    const rows = db.prepare('SELECT wayback_ts, target_url, state, attempts FROM backfill_queue ORDER BY wayback_ts')
      .all() as { wayback_ts: string; target_url: string; state: string; attempts: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.wayback_ts).toBe('20250116002909');
    expect(rows[0]!.target_url).toBe('https://web.archive.org/web/20250116002909id_/https://acme.test/pricing');
    expect(rows[0]!.state).toBe('pending');
    expect(rows[0]!.attempts).toBe(0);
  });

  it('queries an 18-month window ending today by default', async () => {
    let requested = '';
    await discoverCaptures(db, {}, {
      fetcher: async (url) => { requested = url; return ok(cdxBody()); },
      now: NOW,
    });

    const params = new URL(requested).searchParams;
    expect(params.get('url')).toBe('https://acme.test/pricing');
    expect(params.get('from')).toBe('20250219');
    expect(params.get('to')).toBe('20260819');
  });

  it('honours an explicit --months window', async () => {
    let requested = '';
    await discoverCaptures(db, { months: 12 }, {
      fetcher: async (url) => { requested = url; return ok(cdxBody()); },
      now: NOW,
    });
    expect(new URL(requested).searchParams.get('from')).toBe('20250819');
  });

  it('is idempotent — a second discovery enqueues nothing new', async () => {
    const fetcher = async () => ok(cdxBody('20250116002909', '20250209133622'));
    await discoverCaptures(db, {}, { fetcher, now: NOW });
    const second = await discoverCaptures(db, {}, { fetcher, now: NOW });

    expect(second).toMatchObject({ found: 2, enqueued: 0, duplicate: 2 });
    expect((db.prepare('SELECT COUNT(*) n FROM backfill_queue').get() as { n: number }).n).toBe(2);
  });

  it('never resets a row that has already been drained', async () => {
    const fetcher = async () => ok(cdxBody('20250116002909'));
    await discoverCaptures(db, {}, { fetcher, now: NOW });
    db.prepare("UPDATE backfill_queue SET state = 'fetched', attempts = 1").run();

    await discoverCaptures(db, {}, { fetcher, now: NOW });

    const row = db.prepare('SELECT state, attempts FROM backfill_queue').get() as { state: string; attempts: number };
    expect(row.state).toBe('fetched');
    expect(row.attempts).toBe(1);
  });

  it('counts a CDX failure without throwing, so other sources still run', async () => {
    const stats = await discoverCaptures(db, {}, {
      fetcher: async () => ({ ok: false, httpStatus: 503, body: null, error: 'HTTP 503' }),
      now: NOW,
    });
    expect(stats).toMatchObject({ sources: 1, found: 0, enqueued: 0, failed: 1 });
  });

  it('treats an empty CDX answer as zero captures, not a failure', async () => {
    const stats = await discoverCaptures(db, {}, { fetcher: async () => ok(''), now: NOW });
    expect(stats).toMatchObject({ found: 0, enqueued: 0, failed: 0 });
  });

  it('restricts to one source when asked', async () => {
    await discoverCaptures(db, { sourceId: 999 }, {
      fetcher: async () => { throw new Error('should not fetch'); },
      now: NOW,
    });
    expect((db.prepare('SELECT COUNT(*) n FROM backfill_queue').get() as { n: number }).n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/backfill.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement discovery**

Create `src/workflow/backfill.ts`:

```ts
import type { DB } from '../ops/db.js';
import { politeFetch, RobotsCache, type FetchResult } from '../tools/fetch.js';
import { HostRateLimiter } from '../tools/ratelimit.js';
import { captureUrl, cdxQueryUrl, parseCdxResponse } from '../tools/wayback.js';

/** Spec 12.1: Wayback is slow and answers 429 under load. One request per 4s. */
export const WAYBACK_MIN_INTERVAL_MS = 4_000;
export const WAYBACK_JITTER_MS = 1_000;
export const DEFAULT_BACKFILL_MONTHS = 18;

export interface BackfillDeps {
  fetcher?: (url: string) => Promise<FetchResult>;
  now?: () => Date;
}

export interface DiscoverOptions { months?: number; sourceId?: number }

export interface DiscoverStats {
  sources: number; found: number; enqueued: number; duplicate: number; failed: number;
}

interface SourceRow { id: number; url: string }

/**
 * One limiter and one robots cache for the whole run.
 *
 * politeFetch() with no deps builds a FRESH HostRateLimiter per call, which
 * throttles nothing between calls. Live collection survives that because its
 * six sources are six hosts; backfill sends every request of the run to
 * web.archive.org, so a per-call limiter would hammer one host at full speed
 * and earn a 429 storm. Build this once and thread it through everything.
 */
export function waybackFetcher(): (url: string) => Promise<FetchResult> {
  const limiter = new HostRateLimiter(WAYBACK_MIN_INTERVAL_MS, WAYBACK_JITTER_MS);
  const robots = new RobotsCache({ limiter });
  return (url: string) => politeFetch(url, { limiter, robots });
}

/** CDX wants YYYYMMDD. */
function stamp(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

/**
 * Spec 12.1. Fills `backfill_queue` from the CDX timeline; never fetches a
 * capture itself. Safe to run repeatedly — the UNIQUE (source_id, wayback_ts)
 * constraint makes re-discovery a no-op, which is what keeps a half-finished
 * backfill resumable without losing the rows already drained.
 */
export async function discoverCaptures(
  db: DB,
  opts: DiscoverOptions = {},
  deps: BackfillDeps = {},
): Promise<DiscoverStats> {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? waybackFetcher();
  const months = opts.months ?? DEFAULT_BACKFILL_MONTHS;

  const stats: DiscoverStats = { sources: 0, found: 0, enqueued: 0, duplicate: 0, failed: 0 };

  const to = now();
  const from = new Date(to);
  from.setUTCMonth(from.getUTCMonth() - months);

  const sources = db.prepare(
    `SELECT id, url FROM sources WHERE active = 1 ${opts.sourceId ? 'AND id = ' + Number(opts.sourceId) : ''} ORDER BY id`,
  ).all() as SourceRow[];

  const enqueue = db.prepare(`
    INSERT INTO backfill_queue (source_id, wayback_ts, target_url, state, attempts, updated_at)
    VALUES (?, ?, ?, 'pending', 0, ?)
    ON CONFLICT (source_id, wayback_ts) DO NOTHING
  `);

  for (const source of sources) {
    stats.sources += 1;

    const result = await fetcher(cdxQueryUrl(source.url, { from: stamp(from), to: stamp(to) }));
    if (!result.ok || result.body === null) {
      // A CDX outage is not a reason to abandon the other five sources, and it
      // is not a reason to fail the run: discovery is idempotent, so the next
      // invocation picks up whatever was missed.
      stats.failed += 1;
      continue;
    }

    const captures = parseCdxResponse(result.body);
    stats.found += captures.length;

    for (const capture of captures) {
      const info = enqueue.run(
        source.id, capture.timestamp,
        captureUrl(capture.timestamp, source.url),
        now().toISOString(),
      );
      if (info.changes > 0) stats.enqueued += 1;
      else stats.duplicate += 1;
    }
  }

  return stats;
}
```

> **Implementer note on the capture URL:** build it from `source.url` (what we watch), not from `capture.original` (what the Archive recorded). They usually match, but CDX normalizes and may return a variant with a different scheme or trailing slash; using our own URL keeps the archived series pointed at the same page the live collector watches.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/backfill.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/backfill.ts tests/backfill.test.ts
git commit -m "feat(backfill): discover Wayback captures into the queue"
```

---

### Task 4: Drain the queue into snapshots

**Files:**
- Modify: `src/workflow/backfill.ts` (append; do not restructure Task 3's code)
- Modify: `src/workflow/collect.ts` (export one existing constant)
- Test: `tests/backfill.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `PRICE_PATTERN` from `src/workflow/collect.js`; `sha256` from `src/tools/hash.js`; `waybackTimestampToIso` from `src/tools/wayback.js`; `BackfillDeps` from Task 3.
- Produces:
  - `export const MAX_CAPTURE_ATTEMPTS = 3`
  - `export interface DrainStats { claimed: number; stored: number; deduped: number; skipped: number; failed: number }`
  - `export async function drainQueue(db: DB, opts?: DrainOptions, deps?: BackfillDeps): Promise<DrainStats>`

**Three rulings this task implements.**

**R5 — a historical snapshot's `fetched_at` is set to the capture time, not to now.** `observed_at` must be the capture time (spec 12.1, non-negotiable). `fetched_at` is a separate question, and setting it to the real wall-clock fetch time breaks three existing queries at once:

1. `collect`'s cadence gate is `NOT EXISTS (... snapshots WHERE datetime(fetched_at) > datetime(now, '-cadence hours'))`. Twenty historical rows stamped "now" would make every backfilled source look freshly collected, so the next morning's live run would **silently skip all six sources**.
2. `export`'s `last_checked_at` is `MAX(fetched_at)`, which would report the archive import as a live check.
3. `export`'s `last_ok_flag` is the `ok` of the row with the greatest `fetched_at`, so a historical row would decide the public health badge.

Setting `fetched_at` to the capture time makes all three correct with no change to any of them. The real import time stays recoverable from the `runs` row and from `backfill_queue.updated_at`, and `provenance` records exactly which archive capture this was. *Cost if wrong:* a lost day of live collection, plus a status board driven by 2025 data.

**R6 — a failed archive fetch is recorded in `backfill_queue`, never as an `ok=0` snapshot.** `collect` writes failure rows because the attempt is evidence the live source was checked. An Archive outage is evidence about the Archive, not about the source, and an `ok=0` row dated to 2025 is noise in the snapshot stream forever. The queue's `attempts` / `last_error` / `state='failed'` columns exist for exactly this.

**R7 — a capture with no price-like text anywhere is skipped, not stored.** The Archive sometimes captures a soft-404, a consent wall, or a "page cannot be crawled" placeholder and records it as HTTP 200. Extracting one yields an empty tier list, which `diff` reads as *every tier removed* — a maximum-materiality event that confirmation only catches if the very next capture is healthy too. Reuse `collect`'s existing `PRICE_PATTERN` check as an admission gate and mark the row `state='skipped'`. This must **not** set `degraded_reason` (R3): a broken 2025 capture says nothing about the source today.

- [ ] **Step 1: Export the shared constant**

In `src/workflow/collect.ts`, change:

```ts
const PRICE_PATTERN = /[$€£]\s?\d/;
```

to:

```ts
/** A page with no currency-and-digit anywhere is not a pricing page any more. */
export const PRICE_PATTERN = /[$€£]\s?\d/;
```

(Delete the now-duplicated doc comment above it if the original comment line is left orphaned.)

- [ ] **Step 2: Write the failing tests**

Append to `tests/backfill.test.ts`:

```ts
import { drainQueue, MAX_CAPTURE_ATTEMPTS } from '../src/workflow/backfill.js';

describe('drainQueue', () => {
  const PAGE = '<html><h2>Pro</h2><p>$20/mo</p><h2>Enterprise</h2></html>';

  function enqueue(ts: string, sourceId = 1): void {
    db.prepare(`
      INSERT INTO backfill_queue (source_id, wayback_ts, target_url, state, attempts, updated_at)
      VALUES (?, ?, ?, 'pending', 0, '2026-08-19T07:00:00.000Z')
    `).run(sourceId, ts, `https://web.archive.org/web/${ts}id_/https://acme.test/pricing`);
  }

  it('dates the snapshot to the CAPTURE time, not to now (spec 12.1)', async () => {
    enqueue('20250116002909');

    const stats = await drainQueue(db, {}, { fetcher: async () => ok(PAGE), now: NOW });
    expect(stats).toMatchObject({ claimed: 1, stored: 1, deduped: 0, skipped: 0, failed: 0 });

    const snap = db.prepare('SELECT * FROM snapshots').get() as Record<string, unknown>;
    expect(snap.observed_at).toBe('2025-01-16T00:29:09.000Z');
    expect(snap.provenance).toBe('wayback:20250116002909');
    expect(snap.ok).toBe(1);
    expect(snap.raw_content).toBe(PAGE);
    expect(snap.normalized_hash).toBeNull();   // extract fills this in
  });

  it('sets fetched_at to the capture time so the cadence gate is unaffected (R5)', async () => {
    enqueue('20250116002909');
    await drainQueue(db, {}, { fetcher: async () => ok(PAGE), now: NOW });

    const snap = db.prepare('SELECT fetched_at FROM snapshots').get() as { fetched_at: string };
    expect(snap.fetched_at).toBe('2025-01-16T00:29:09.000Z');

    // The proof that matters: collect still considers the source due.
    const due = db.prepare(`
      SELECT s.id FROM sources s WHERE s.active = 1 AND NOT EXISTS (
        SELECT 1 FROM snapshots snap WHERE snap.source_id = s.id
          AND datetime(snap.fetched_at) > datetime(?, '-' || s.cadence_hours || ' hours'))
    `).all(NOW().toISOString());
    expect(due).toHaveLength(1);
  });

  it('marks the queue row fetched and never re-fetches it', async () => {
    enqueue('20250116002909');
    let calls = 0;
    const fetcher = async () => { calls += 1; return ok(PAGE); };

    await drainQueue(db, {}, { fetcher, now: NOW });
    await drainQueue(db, {}, { fetcher, now: NOW });

    expect(calls).toBe(1);
    expect((db.prepare('SELECT state FROM backfill_queue').get() as { state: string }).state).toBe('fetched');
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(1);
  });

  it('stores identical captures content-addressed — row kept, bytes written once (spec 7.2)', async () => {
    enqueue('20250116002909');
    enqueue('20250209133622');

    const stats = await drainQueue(db, {}, { fetcher: async () => ok(PAGE), now: NOW });
    expect(stats).toMatchObject({ stored: 1, deduped: 1 });

    const snaps = db.prepare('SELECT raw_content, raw_hash FROM snapshots ORDER BY observed_at')
      .all() as { raw_content: string | null; raw_hash: string }[];
    expect(snaps).toHaveLength(2);
    expect(snaps[0]!.raw_content).toBe(PAGE);
    expect(snaps[1]!.raw_content).toBeNull();
    expect(snaps[1]!.raw_hash).toBe(snaps[0]!.raw_hash);
  });

  it('skips a capture with no price-like text and stores no snapshot (R7)', async () => {
    enqueue('20250116002909');

    const stats = await drainQueue(db, {}, {
      fetcher: async () => ok('<html><body>This page cannot be crawled.</body></html>'),
      now: NOW,
    });

    expect(stats).toMatchObject({ claimed: 1, stored: 0, skipped: 1, failed: 0 });
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT state FROM backfill_queue').get() as { state: string }).state).toBe('skipped');
  });

  it('never marks a source degraded, whatever the archive returns (R3)', async () => {
    enqueue('20250116002909');
    await drainQueue(db, {}, { fetcher: async () => ok('<html>no prices here</html>'), now: NOW });

    const source = db.prepare('SELECT degraded_reason FROM sources WHERE id = 1').get() as
      { degraded_reason: string | null };
    expect(source.degraded_reason).toBeNull();
  });

  it('records a fetch failure in the queue, not as an ok=0 snapshot (R6)', async () => {
    enqueue('20250116002909');

    const stats = await drainQueue(db, {}, {
      fetcher: async () => ({ ok: false, httpStatus: 503, body: null, error: 'HTTP 503' }),
      now: NOW,
    });

    expect(stats).toMatchObject({ claimed: 1, stored: 0, failed: 1 });
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(0);

    const row = db.prepare('SELECT state, attempts, last_error FROM backfill_queue').get() as
      { state: string; attempts: number; last_error: string };
    expect(row.state).toBe('pending');   // still retryable
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('503');
  });

  it('gives up on a row after MAX_CAPTURE_ATTEMPTS and stops retrying it', async () => {
    enqueue('20250116002909');
    const fail = async () => ({ ok: false, httpStatus: 503, body: null, error: 'HTTP 503' });

    for (let i = 0; i < MAX_CAPTURE_ATTEMPTS; i += 1) {
      await drainQueue(db, {}, { fetcher: fail, now: NOW });
    }
    expect((db.prepare('SELECT state FROM backfill_queue').get() as { state: string }).state).toBe('failed');

    let calls = 0;
    const stats = await drainQueue(db, {}, {
      fetcher: async () => { calls += 1; return fail(); },
      now: NOW,
    });
    expect(calls).toBe(0);
    expect(stats.claimed).toBe(0);
  });

  it('skips a queue row whose timestamp will not parse rather than dating it to the epoch', async () => {
    enqueue('not-a-timestamp');

    const stats = await drainQueue(db, {}, { fetcher: async () => ok(PAGE), now: NOW });

    expect(stats).toMatchObject({ claimed: 1, skipped: 1, stored: 0 });
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(0);
  });

  it('processes oldest capture first and honours --limit', async () => {
    enqueue('20250209133622');
    enqueue('20250116002909');

    const seen: string[] = [];
    const stats = await drainQueue(db, { limit: 1 }, {
      fetcher: async (url) => { seen.push(url); return ok(PAGE); },
      now: NOW,
    });

    expect(stats.claimed).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('20250116002909');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run tests/backfill.test.ts`
Expected: FAIL — `drainQueue` is not exported.

- [ ] **Step 4: Implement the drain**

Append to `src/workflow/backfill.ts` (and extend the import block at the top of the file):

```ts
import { PRICE_PATTERN } from './collect.js';
import { sha256 } from '../tools/hash.js';
import { waybackTimestampToIso } from '../tools/wayback.js';
```

```ts
/**
 * politeFetch already retries 3x with backoff inside one call, so this is the
 * across-run allowance: how many separate `bellwether backfill` invocations may
 * keep trying a capture the Archive will not serve.
 */
export const MAX_CAPTURE_ATTEMPTS = 3;

export interface DrainOptions { limit?: number }

export interface DrainStats {
  claimed: number; stored: number; deduped: number; skipped: number; failed: number;
}

interface QueueRow { id: number; source_id: number; wayback_ts: string; target_url: string; attempts: number }

/**
 * Spec 12.1. Fetches queued captures one at a time and writes them as snapshots
 * dated to the capture, then leaves normalize/extract/detect to the existing
 * pipeline. Restartable: the work list is re-read from `backfill_queue` on
 * every invocation, so an interrupted run resumes exactly where it stopped.
 *
 * Deliberately does NOT touch `sources.degraded_reason` on any path (ruling
 * R3) — nothing an 18-month-old capture does is a health signal about the
 * source today.
 */
export async function drainQueue(
  db: DB,
  opts: DrainOptions = {},
  deps: BackfillDeps = {},
): Promise<DrainStats> {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? waybackFetcher();
  const stats: DrainStats = { claimed: 0, stored: 0, deduped: 0, skipped: 0, failed: 0 };

  // The whole work list is read up front rather than re-querying for "the next
  // pending row" each iteration: a failed row stays `pending` so a later run can
  // retry it, and re-querying would hand back the row we just failed, forever.
  const queue = db.prepare(`
    SELECT id, source_id, wayback_ts, target_url, attempts
    FROM backfill_queue
    WHERE state = 'pending' AND attempts < ?
    ORDER BY wayback_ts, id
    ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}
  `).all(MAX_CAPTURE_ATTEMPTS) as QueueRow[];

  const setState = db.prepare(
    'UPDATE backfill_queue SET state = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?',
  );
  const insertSnapshot = db.prepare(`
    INSERT INTO snapshots
      (source_id, observed_at, fetched_at, ok, http_status, error,
       raw_content, raw_hash, normalized_hash, provenance)
    VALUES (@sourceId, @observedAt, @fetchedAt, 1, 200, NULL,
            @rawContent, @rawHash, NULL, @provenance)
  `);
  const findHash = db.prepare(
    'SELECT id FROM snapshots WHERE source_id = ? AND raw_hash = ? LIMIT 1',
  );

  for (const row of queue) {
    stats.claimed += 1;
    const stampedAt = now().toISOString();

    const observedAt = waybackTimestampToIso(row.wayback_ts);
    if (observedAt === null) {
      // Spec 12.1's one unrecoverable mistake is dating history to today. A
      // stamp we cannot parse is dropped outright rather than guessed at.
      stats.skipped += 1;
      setState.run('skipped', row.attempts, `unparseable wayback timestamp "${row.wayback_ts}"`, stampedAt, row.id);
      continue;
    }

    const result = await fetcher(row.target_url);

    if (!result.ok || result.body === null) {
      stats.failed += 1;
      const attempts = row.attempts + 1;
      // Ruling R6: an Archive outage is evidence about the Archive, not about
      // the source. It never becomes an ok=0 snapshot.
      setState.run(
        attempts >= MAX_CAPTURE_ATTEMPTS ? 'failed' : 'pending',
        attempts, result.error ?? `HTTP ${result.httpStatus}`, stampedAt, row.id,
      );
      continue;
    }

    // Ruling R7: the Archive serves soft-404s, consent walls, and "cannot be
    // crawled" placeholders as HTTP 200. Extracting one yields an empty tier
    // list, which diff reads as every tier removed — a maximum-materiality
    // phantom. Admission gate, same test collect uses on live pages.
    if (!PRICE_PATTERN.test(result.body)) {
      stats.skipped += 1;
      setState.run('skipped', row.attempts, 'no price-like text in the capture', stampedAt, row.id);
      continue;
    }

    const rawHash = sha256(result.body);
    const seen = findHash.get(row.source_id, rawHash) as { id: number } | undefined;
    if (seen) stats.deduped += 1;
    else stats.stored += 1;

    insertSnapshot.run({
      sourceId: row.source_id,
      // Spec 12.1: the capture time, or eighteen months of history lands on
      // today's date. fetched_at matches it deliberately (ruling R5) so
      // collect's cadence gate and export's freshness queries stay correct
      // without either of them learning about provenance.
      observedAt,
      fetchedAt: observedAt,
      rawContent: seen ? null : result.body,
      rawHash,
      provenance: `wayback:${row.wayback_ts}`,
    });

    setState.run('fetched', row.attempts, null, stampedAt, row.id);
  }

  return stats;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/backfill.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite and typecheck**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/backfill.ts src/workflow/collect.ts tests/backfill.test.ts
git commit -m "feat(backfill): drain queued captures into capture-dated snapshots"
```

---

### Task 5: Budget, orchestration, and the `backfill` CLI command

**Files:**
- Modify: `src/workflow/extract.ts` (one guard)
- Modify: `src/workflow/backfill.ts` (append)
- Modify: `src/cli.ts`
- Test: `tests/backfill.test.ts` (append), `tests/extract.test.ts` (append one case)

**Interfaces:**
- Consumes: `discoverCaptures`, `drainQueue` (Tasks 3-4); `extract` from `src/workflow/extract.js`; `detect` from `src/workflow/detect.js`; `acquireRun` / `finishRun` from `src/ops/runs.js`.
- Produces:
  - `export const FALLBACK_COST_MICROS_PER_EXTRACTION = 10_000`
  - `export const DEFAULT_BACKFILL_BUDGET_USD = 10`
  - `export function estimateBackfill(db: DB, budgetUsd: number): BackfillEstimate`
  - `export interface BackfillStats { discover: DiscoverStats; drain: DrainStats; estimate: BackfillEstimate; extracted: number; changes: number; confirmed: number }`
  - `export async function runBackfill(db: DB, opts?: RunBackfillOptions, deps?: BackfillDeps): Promise<BackfillStats>`

**How the budget is enforced.**

Spec 12.1 specifies a pre-flight estimate because a Batches job cannot be checked mid-flight. Ruling R1 keeps extraction synchronous, so the estimate is also converted into a call ceiling passed straight to `extract`'s existing `--limit`. No new enforcement code is written anywhere.

> **Corrected during execution.** An earlier draft of this section claimed the call ceiling is what enforces the budget. It is not. The gate requires `pending x mean <= budget` and `maxCalls = floor(budget / mean)`, so `maxCalls >= pending` whenever the gate passes — the ceiling never truncates on the happy path, and it cannot bind on cost because it counts calls rather than dollars. **The refusal gate is the enforcement.** The real bound on per-call cost is structural and already exists: `TOKEN_BUDGET = 20_000` in `src/agents/extract_pricing.ts` refuses an oversized page before it is sent, capping one extraction near $0.025 against a measured mean of $0.0096 (largest observed: $0.018). Worst-case overshoot on a ~$1.20 corpus is therefore about $3, not unbounded. `maxCalls` is kept as a cheap backstop for a backlog the estimator cannot see.

```
maxCalls = floor(budgetMicros / meanCostMicros)
```

`meanCostMicros` is `AVG(cost_micros)` over existing `extractions`, falling back to 10,000 micro-dollars (measured: six live pages cost $0.0579 total on 2026-08-18) when the table is empty. The estimate is a deliberate worst case — it assumes every queued capture is a distinct page state, when content-addressed dedup means many are not.

`extract`'s `--limit` caps LLM calls, not candidates scanned, and it counts live and historical calls together. In practice a backfill runs after the day's live pages are already cached, so nearly every call it makes is historical. Erring conservative here is the correct direction.

- [ ] **Step 1: Let a historical extraction bypass the recurring monthly cap**

Task 2 made `is_backfill` rows invisible to `monthlySpendMicros`. The gate must be symmetric: spec 15.2 requires that the recurring allowance "can never silently block a deliberate backfill", and today `extract` calls `assertWithinBudget` before every call regardless of provenance. A live archive at $4.99 of a $5.00 month would refuse the entire historical corpus.

In `src/workflow/extract.ts`, change:

```ts
      try {
        assertWithinBudget(db, { now, env });
      } catch (err) {
```

to:

```ts
      // Spec 15.2: is_backfill rows are excluded from monthlySpendMicros, so
      // gating them on that same figure would be one-sided — a live archive
      // sitting near its recurring cap would refuse the whole historical
      // corpus. Bulk history is bounded by `backfill --budget` instead
      // (spec 12.1), which reaches this loop as opts.limit.
      try {
        if (!historical) assertWithinBudget(db, { now, env });
      } catch (err) {
```

Add the matching test to `tests/extract.test.ts`:

```ts
  it('extracts a historical snapshot even when the recurring cap is exhausted (spec 15.2)', async () => {
    db.prepare(`
      INSERT INTO extractions
        (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
         is_backfill, model, prompt_version, input_tokens, output_tokens, cost_micros, created_at)
      VALUES ('spent', 'pricing', '{}', 'high', 'USD', 1, 0, 'm', 'v-old', 1, 1, 9000000,
              '2026-08-05T00:00:00.000Z')
    `).run();

    insertWayback(1, '20250116000000', '<html><h2>Pro</h2><p>$20/mo</p></html>');

    const stats = await extract(db, {}, {
      env: { LLM_ENABLED: 'true', BELLWETHER_MONTHLY_BUDGET_USD: '5' },
      extractor: OK_EXTRACTOR,
      now: () => new Date('2026-08-19T07:00:00.000Z'),
    });

    expect(stats.extracted).toBe(1);
    expect(stats.skipped).toBe(0);
  });
```

> **Implementer note:** the `prompt_version` on the pre-seeded row must differ from `EXTRACT_PROMPT_VERSION` (or its `normalized_hash` must differ from the one the wayback page produces) so it does not satisfy the extraction cache and make the test pass for the wrong reason.

- [ ] **Step 2: Write the failing tests for the estimator and orchestration**

Append to `tests/backfill.test.ts`:

```ts
import { estimateBackfill, runBackfill, FALLBACK_COST_MICROS_PER_EXTRACTION } from '../src/workflow/backfill.js';

describe('estimateBackfill', () => {
  function enqueuePending(n: number): void {
    const stmt = db.prepare(`
      INSERT INTO backfill_queue (source_id, wayback_ts, target_url, state, attempts, updated_at)
      VALUES (1, ?, 'https://web.archive.org/x', 'pending', 0, '2026-08-19T00:00:00.000Z')
    `);
    // Arithmetic, not string surgery: every stamp is a distinct 14 digits, so
    // the UNIQUE (source_id, wayback_ts) constraint never trips mid-test.
    for (let i = 0; i < n; i += 1) stmt.run(String(20250101000000 + i));
  }

  it('uses the measured mean cost once extractions exist', () => {
    db.prepare(`
      INSERT INTO extractions
        (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
         is_backfill, model, prompt_version, input_tokens, output_tokens, cost_micros, created_at)
      VALUES ('h1','pricing','{}','high','USD',1,0,'m','v',1,1,8000,'2026-08-01T00:00:00.000Z')
    `).run();
    enqueuePending(10);

    const est = estimateBackfill(db, 10);
    expect(est.meanCostMicros).toBe(8000);
    expect(est.pending).toBe(10);
    expect(est.estimateMicros).toBe(80_000);
    expect(est.withinBudget).toBe(true);
    expect(est.maxCalls).toBe(1250);
  });

  it('falls back to the measured constant on an empty extractions table', () => {
    enqueuePending(4);
    const est = estimateBackfill(db, 10);
    expect(est.meanCostMicros).toBe(FALLBACK_COST_MICROS_PER_EXTRACTION);
    expect(est.estimateMicros).toBe(4 * FALLBACK_COST_MICROS_PER_EXTRACTION);
  });

  it('reports over-budget rather than silently truncating', () => {
    enqueuePending(200);
    const est = estimateBackfill(db, 0.5);
    expect(est.withinBudget).toBe(false);
    expect(est.maxCalls).toBe(50);
  });

  it('counts only pending rows — a drained queue estimates zero', () => {
    enqueuePending(5);
    db.prepare("UPDATE backfill_queue SET state = 'fetched'").run();
    expect(estimateBackfill(db, 10).pending).toBe(0);
  });
});

describe('runBackfill', () => {
  const PAGE = '<html><h2>Pro</h2><p>$20/mo</p><h2>Enterprise</h2></html>';

  function router(cdx: string, page: string) {
    return async (url: string): Promise<FetchResult> =>
      url.includes('/cdx/search/') ? ok(cdx) : ok(page);
  }

  it('discovers, drains, and leaves capture-dated snapshots behind', async () => {
    const stats = await runBackfill(db, { llmEnabled: false }, {
      fetcher: router(cdxBody('20250116002909', '20250209133622'), PAGE),
      now: NOW,
    });

    expect(stats.discover.enqueued).toBe(2);
    expect(stats.drain.claimed).toBe(2);

    const snaps = db.prepare('SELECT observed_at, provenance FROM snapshots ORDER BY observed_at')
      .all() as { observed_at: string; provenance: string }[];
    expect(snaps.map(s => s.observed_at)).toEqual([
      '2025-01-16T00:29:09.000Z', '2025-02-09T13:36:22.000Z',
    ]);
    expect(snaps.every(s => s.provenance.startsWith('wayback:'))).toBe(true);
  });

  it('refuses to spend past the budget and drains nothing', async () => {
    const stats = await runBackfill(db, { budgetUsd: 0, llmEnabled: false }, {
      fetcher: router(cdxBody('20250116002909'), PAGE),
      now: NOW,
    });

    expect(stats.estimate.withinBudget).toBe(false);
    expect(stats.drain.claimed).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(0);
    // Discovery still ran, so raising the budget and re-running costs no extra CDX calls.
    expect((db.prepare('SELECT COUNT(*) n FROM backfill_queue').get() as { n: number }).n).toBe(1);
  });

  it('--discover-only enqueues and stops', async () => {
    const stats = await runBackfill(db, { discoverOnly: true }, {
      fetcher: router(cdxBody('20250116002909'), PAGE),
      now: NOW,
    });

    expect(stats.discover.enqueued).toBe(1);
    expect(stats.drain.claimed).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM snapshots').get() as { n: number }).n).toBe(0);
  });

  it('rebuilds detection so pre-existing changes are re-derived across the new history (spec 12.2)', async () => {
    db.prepare(`
      INSERT INTO changes
        (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
         before_json, after_json, materiality, state, observed_at)
      VALUES (1, 1, 2, 'price_change', 'tiers.Pro.monthly_price_usd', '10', '20', 80,
              'confirmed', '2026-08-01T00:00:00.000Z')
    `).run();

    await runBackfill(db, { llmEnabled: false }, {
      fetcher: router(cdxBody('20250116002909'), PAGE),
      now: NOW,
    });

    // The stale row named snapshots that no longer pair; rebuild must clear it
    // rather than leave a change spanning newly-inserted history.
    expect((db.prepare('SELECT COUNT(*) n FROM changes').get() as { n: number }).n).toBe(0);
  });

  it('records one backfill run and marks it ok', async () => {
    await runBackfill(db, { llmEnabled: false }, {
      fetcher: router(cdxBody('20250116002909'), PAGE),
      now: NOW,
    });

    const run = db.prepare("SELECT state, ok FROM runs WHERE kind = 'backfill'").get() as
      { state: string; ok: number };
    expect(run.state).toBe('ok');
    expect(run.ok).toBe(1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run tests/backfill.test.ts tests/extract.test.ts`
Expected: FAIL — `estimateBackfill` / `runBackfill` not exported.

- [ ] **Step 4: Implement the estimator and orchestration**

Append to `src/workflow/backfill.ts` (extend the imports at the top of the file):

```ts
import { acquireRun, finishRun } from '../ops/runs.js';
import { detect } from './detect.js';
import { extract } from './extract.js';
```

```ts
/**
 * Measured 2026-08-18: six live pricing pages cost $0.0579 to extract, i.e.
 * $0.00965 each. Rounded up, and used only until the extractions table has
 * real numbers of its own.
 */
export const FALLBACK_COST_MICROS_PER_EXTRACTION = 10_000;
export const DEFAULT_BACKFILL_BUDGET_USD = 10;

export interface BackfillEstimate {
  pending: number;
  meanCostMicros: number;
  estimateMicros: number;
  budgetMicros: number;
  withinBudget: boolean;
  maxCalls: number;
}

/**
 * Spec 12.1: the corpus is costed before any of it is submitted.
 *
 * Deliberately a worst case — it assumes every queued capture is a distinct
 * page state, when content-addressed dedup (spec 7.1) means many share a hash
 * and cost nothing. `maxCalls` turns the dollar figure into a hard ceiling that
 * `extract`'s existing --limit enforces, so no new spend-guard code exists.
 */
export function estimateBackfill(db: DB, budgetUsd: number): BackfillEstimate {
  const pending = (db.prepare(
    "SELECT COUNT(*) AS n FROM backfill_queue WHERE state = 'pending' AND attempts < ?",
  ).get(MAX_CAPTURE_ATTEMPTS) as { n: number }).n;

  const measured = (db.prepare(
    'SELECT AVG(cost_micros) AS mean FROM extractions WHERE cost_micros IS NOT NULL',
  ).get() as { mean: number | null }).mean;

  const meanCostMicros = measured && measured > 0
    ? Math.round(measured)
    : FALLBACK_COST_MICROS_PER_EXTRACTION;

  const budgetMicros = Math.round(budgetUsd * 1e6);
  const estimateMicros = pending * meanCostMicros;

  return {
    pending,
    meanCostMicros,
    estimateMicros,
    budgetMicros,
    withinBudget: estimateMicros <= budgetMicros,
    maxCalls: Math.floor(budgetMicros / meanCostMicros),
  };
}

export interface RunBackfillOptions {
  months?: number;
  sourceId?: number;
  budgetUsd?: number;
  limit?: number;
  discoverOnly?: boolean;
  /** Test seam: false skips extraction entirely so no key or network is needed. */
  llmEnabled?: boolean;
}

export interface BackfillStats {
  discover: DiscoverStats;
  drain: DrainStats;
  estimate: BackfillEstimate;
  extracted: number;
  changes: number;
  confirmed: number;
}

/**
 * The whole one-shot: discover, cost, drain, extract, rebuild detection.
 *
 * Holds a single `backfill` run lock. extract and detect take their own locks
 * under different kinds, so they nest without contending. Spec 12.2 requires
 * the rebuild: backfill inserts snapshots whose observed_at falls before
 * existing live ones, so pairs that used to be adjacent no longer are and every
 * change row spanning newly-inserted history is now wrong. Re-deriving is free
 * because extractions are content-addressed.
 */
export async function runBackfill(
  db: DB,
  opts: RunBackfillOptions = {},
  deps: BackfillDeps = {},
): Promise<BackfillStats> {
  const now = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? waybackFetcher();
  const budgetUsd = opts.budgetUsd ?? DEFAULT_BACKFILL_BUDGET_USD;

  const runId = acquireRun(db, 'backfill', { now });
  let stats: BackfillStats = {
    discover: { sources: 0, found: 0, enqueued: 0, duplicate: 0, failed: 0 },
    drain: { claimed: 0, stored: 0, deduped: 0, skipped: 0, failed: 0 },
    estimate: {
      pending: 0, meanCostMicros: 0, estimateMicros: 0,
      budgetMicros: 0, withinBudget: true, maxCalls: 0,
    },
    extracted: 0, changes: 0, confirmed: 0,
  };

  try {
    stats.discover = await discoverCaptures(
      db, { months: opts.months, sourceId: opts.sourceId }, { fetcher, now },
    );
    stats.estimate = estimateBackfill(db, budgetUsd);

    if (opts.discoverOnly) {
      finishRun(db, runId, true, stats);
      return stats;
    }

    // Refuse rather than half-spend. Discovery has already run, so raising the
    // budget and re-running costs nothing extra at the CDX layer.
    if (!stats.estimate.withinBudget) {
      finishRun(db, runId, true, stats);
      return stats;
    }

    stats.drain = await drainQueue(db, { limit: opts.limit }, { fetcher, now });

    if (opts.llmEnabled !== false) {
      const extracted = await extract(db, { limit: stats.estimate.maxCalls }, { now });
      stats.extracted = extracted.extracted;
    }

    const detected = detect(db, { rebuild: true, sourceId: opts.sourceId }, { now });
    stats.changes = detected.created;
    stats.confirmed = detected.confirmed;

    finishRun(db, runId, true, stats);
    return stats;
  } catch (err) {
    finishRun(db, runId, false, stats, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
```

> **Implementer note:** `stats` is declared with `let` only so the catch block can report partial progress; if the linter objects, keep it `const` and mutate its fields, which is what the code already does.

- [ ] **Step 5: Add the CLI command**

In `src/cli.ts`, after the `detect` command:

```ts
program
  .command('backfill')
  .description('seed the archive with historical captures from the Internet Archive')
  .option('--months <n>', 'how far back to look (default 18)', v => Number(v))
  .option('--budget <usd>', 'one-time spend ceiling for this backfill (default 10.00)', v => Number(v))
  .option('--limit <n>', 'fetch at most n captures this run', v => Number(v))
  .option('--source <id>', 'restrict to one source', v => Number(v))
  .option('--discover-only', 'enqueue captures but fetch none')
  .action(async (options: {
    months?: number; budget?: number; limit?: number; source?: number; discoverOnly?: boolean;
  }) => {
    const { runBackfill } = await import('./workflow/backfill.js');
    const db = openDb(dbPath());

    const s = await runBackfill(db, {
      months: options.months,
      budgetUsd: options.budget,
      limit: options.limit,
      sourceId: options.source,
      discoverOnly: options.discoverOnly,
    });

    const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

    console.log(
      `Discovery: ${s.discover.sources} sources, ${s.discover.found} captures found, ` +
      `${s.discover.enqueued} new, ${s.discover.duplicate} already queued, ${s.discover.failed} failed.`,
    );
    console.log(
      `Estimate: ${s.estimate.pending} pending x ${usd(s.estimate.meanCostMicros)} = ` +
      `${usd(s.estimate.estimateMicros)} against a ${usd(s.estimate.budgetMicros)} budget.`,
    );

    if (!s.estimate.withinBudget) {
      console.log(
        `\nRefusing to start: the queue would cost more than the budget allows.\n` +
        `The captures are already queued, so nothing is lost — re-run with\n` +
        `  bellwether backfill --budget ${(s.estimate.estimateMicros / 1e6).toFixed(2)}\n` +
        `or work through it in slices with --limit ${Math.max(1, s.estimate.maxCalls)}.\n` +
        `The estimate is a worst case: identical captures share an extraction and cost nothing.`,
      );
      db.close();
      return;
    }

    if (options.discoverOnly) {
      console.log('\nDiscovery only — nothing fetched. Re-run without --discover-only to continue.');
      db.close();
      return;
    }

    console.log(
      `Fetched ${s.drain.claimed}: ${s.drain.stored} new page states, ${s.drain.deduped} identical, ` +
      `${s.drain.skipped} skipped, ${s.drain.failed} failed.`,
    );
    console.log(
      `Extracted ${s.extracted}. Rebuilt detection: ${s.changes} changes, ${s.confirmed} confirmed.`,
    );
    console.log('\nRun `bellwether export` to publish the new history.');

    db.close();
  });
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all green.

- [ ] **Step 7: Verify the command's shape without spending anything**

Run: `pnpm bw backfill --discover-only --months 18`
Expected: real CDX calls (one per source, throttled to one per 4 seconds), roughly 18-20 captures enqueued per source, no snapshots written, no LLM calls, and a printed estimate near $1.20. Confirm with:

```bash
pnpm bw backfill --discover-only 2>&1 | tail -5
sqlite3 data/bellwether.db "SELECT state, COUNT(*) FROM backfill_queue GROUP BY state;"
```

- [ ] **Step 8: Commit**

```bash
git add src/workflow/backfill.ts src/workflow/extract.ts src/cli.ts tests/
git commit -m "feat(backfill): budget estimate, orchestration, and the CLI command"
```

---

### Task 6: Timeline export and chart

Spec 14.3 calls the timeline "what backfill buys" — it is the flagship view and the reason the previous five tasks exist. Two hard rules from the spec govern it:

> **Observation gaps render as gaps.** Where Wayback has no capture, the series breaks. Never interpolate.

> **Stated resolution limits** — backfilled history is monthly, so a change is dated to within a month, and the page must say so.

All series-breaking logic lives in the **exporter**, where Vitest can reach it. The React component receives segments that are already split and draws one polyline each, so it holds no judgement at all.

**Files:**
- Modify: `src/workflow/export.ts`
- Modify: `web/lib/types.ts`, `web/lib/data.ts`
- Create: `web/components/Timeline.tsx`
- Modify: `web/app/page.tsx`, `web/app/globals.css`
- Test: `tests/timeline.test.ts`

**Interfaces:**
- Consumes: `observationsFor` from `src/workflow/detect.js` — already exported, and already applies the USD filter (12.4), the prompt-version filter, the repeated-hash collapse (12.2), and Zod validation. Do not re-derive any of that.
- Produces:
  - `export const TIMELINE_GAP_DAYS = 75`
  - `export function buildTimeline(db: DB, generatedAt: string): TimelinePayload`
  - `exportData` writes a fourth file, `timeline.json`.

**Payload shape:**

```ts
export interface TimelinePoint { observed_at: string; price: number }
export interface TimelineSeries { tier: string; segments: TimelinePoint[][] }
export interface TimelineMarker { observed_at: string; label: string }
export interface TimelineCompetitor {
  slug: string; name: string;
  first_observed_at: string | null; last_observed_at: string | null;
  series: TimelineSeries[]; markers: TimelineMarker[];
}
export interface TimelinePayload {
  generated_at: string; observation_count: number; competitors: TimelineCompetitor[];
}
```

**Segment rules — a new segment starts when either holds:**
1. The tier is **absent** from the previous observation, or present with a `null` price. A tier that vanishes and returns is two segments, never one line crossing the gap.
2. More than `TIMELINE_GAP_DAYS` (75) elapsed since the previous point. Wayback captures are monthly, so ~31 days is normal and two consecutive missed months is a real hole in the record.

A `null` `monthly_price_usd` ("contact sales") is never a point. It is not zero, and plotting it as zero would be the single most misleading thing this chart could do.

- [ ] **Step 1: Write the failing tests**

Create `tests/timeline.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { buildTimeline, TIMELINE_GAP_DAYS } from '../src/workflow/export.js';
import { EXTRACT_PROMPT_VERSION } from '../src/schema/pricing.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let db: DB;

const CONFIG: CompetitorConfig[] = [{
  slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
  sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }],
}];

const GENERATED = '2026-08-19T07:00:00.000Z';

/** Insert one observed page state: a snapshot plus the extraction it hashes to. */
function observe(observedAt: string, tiers: { name: string; price: number | null }[], hash = observedAt): void {
  db.prepare(`
    INSERT INTO snapshots
      (source_id, observed_at, fetched_at, ok, http_status, error,
       raw_content, raw_hash, normalized_hash, provenance)
    VALUES (1, ?, ?, 1, 200, NULL, NULL, ?, ?, 'wayback:x')
  `).run(observedAt, observedAt, `raw-${hash}`, hash);

  const data = {
    tiers: tiers.map(t => ({
      name: t.name, monthly_price_usd: t.price, annual_price_usd: null,
      billing_unit: null, included_seats: null, headline_features: [],
      is_free: t.price === 0, is_enterprise: false,
    })),
    usage_rates: [], currency: 'USD', notes: null, extraction_confidence: 'high',
  };

  db.prepare(`
    INSERT INTO extractions
      (normalized_hash, source_kind, data_json, extraction_confidence, currency, grounded,
       is_backfill, model, prompt_version, input_tokens, output_tokens, cost_micros, created_at)
    VALUES (?, 'pricing', ?, 'high', 'USD', 1, 1, 'm', ?, 1, 1, 1000, ?)
    ON CONFLICT (normalized_hash, prompt_version) DO NOTHING
  `).run(hash, JSON.stringify(data), EXTRACT_PROMPT_VERSION, observedAt);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-timeline-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});

afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('buildTimeline', () => {
  it('builds one continuous segment for an unbroken monthly series', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], 'h2');
    observe('2025-03-16T00:00:00.000Z', [{ name: 'Pro', price: 10 }], 'h3');

    const payload = buildTimeline(db, GENERATED);
    const acme = payload.competitors[0]!;
    expect(acme.series).toHaveLength(1);
    expect(acme.series[0]!.tier).toBe('Pro');
    expect(acme.series[0]!.segments).toHaveLength(1);
    expect(acme.series[0]!.segments[0]!.map(p => p.price)).toEqual([8, 8, 10]);
    expect(acme.first_observed_at).toBe('2025-01-16T00:00:00.000Z');
    expect(acme.last_observed_at).toBe('2025-03-16T00:00:00.000Z');
    expect(payload.observation_count).toBe(3);
  });

  it('breaks the series where the archive has no captures — never interpolates (spec 14.3)', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], 'h2');
    observe('2025-09-16T00:00:00.000Z', [{ name: 'Pro', price: 12 }], 'h3');  // 7-month hole

    const segments = buildTimeline(db, GENERATED).competitors[0]!.series[0]!.segments;
    expect(segments).toHaveLength(2);
    expect(segments[0]!.map(p => p.price)).toEqual([8, 8]);
    expect(segments[1]!.map(p => p.price)).toEqual([12]);
  });

  it('treats exactly TIMELINE_GAP_DAYS as continuous and one day more as a break', () => {
    const start = new Date('2025-01-16T00:00:00.000Z');
    const at = (days: number) => new Date(start.getTime() + days * 86_400_000).toISOString();

    observe(at(0), [{ name: 'Pro', price: 8 }], 'a');
    observe(at(TIMELINE_GAP_DAYS), [{ name: 'Pro', price: 9 }], 'b');
    observe(at(TIMELINE_GAP_DAYS * 2 + 1), [{ name: 'Pro', price: 10 }], 'c');

    const segments = buildTimeline(db, GENERATED).competitors[0]!.series[0]!.segments;
    expect(segments).toHaveLength(2);
    expect(segments[0]!.map(p => p.price)).toEqual([8, 9]);
  });

  it('breaks the series when a tier disappears and returns', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }, { name: 'Team', price: 20 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }], 'h2');
    observe('2025-03-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }, { name: 'Team', price: 25 }], 'h3');

    const team = buildTimeline(db, GENERATED).competitors[0]!.series.find(s => s.tier === 'Team')!;
    expect(team.segments).toHaveLength(2);
    expect(team.segments[0]!.map(p => p.price)).toEqual([20]);
    expect(team.segments[1]!.map(p => p.price)).toEqual([25]);
  });

  it('never plots a contact-sales tier as zero', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }, { name: 'Enterprise', price: null }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }, { name: 'Enterprise', price: null }], 'h2');

    const series = buildTimeline(db, GENERATED).competitors[0]!.series;
    expect(series.map(s => s.tier)).toEqual(['Pro']);
  });

  it('keeps a free tier, which is a real zero', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Free', price: 0 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Free', price: 0 }], 'h2');

    const series = buildTimeline(db, GENERATED).competitors[0]!.series;
    expect(series[0]!.tier).toBe('Free');
    expect(series[0]!.segments[0]!.map(p => p.price)).toEqual([0, 0]);
  });

  it('carries confirmed material changes as markers, and nothing else', () => {
    observe('2025-01-16T00:00:00.000Z', [{ name: 'Pro', price: 8 }]);
    observe('2025-02-16T00:00:00.000Z', [{ name: 'Pro', price: 10 }], 'h2');

    db.prepare(`
      INSERT INTO changes
        (source_id, from_snapshot_id, to_snapshot_id, change_type, json_path,
         before_json, after_json, materiality, state, observed_at)
      VALUES
        (1, 1, 2, 'price_change', 'tiers.Pro.monthly_price_usd', '8', '10', 80, 'confirmed', '2025-02-16T00:00:00.000Z'),
        (1, 1, 2, 'tier_renamed',  'tiers.Pro',                  '"P"', '"Pro"', 35, 'confirmed', '2025-02-16T00:00:00.000Z'),
        (1, 1, 2, 'price_change', 'tiers.Team.monthly_price_usd', '1', '2', 80, 'candidate', '2025-02-16T00:00:00.000Z')
    `).run();

    const markers = buildTimeline(db, GENERATED).competitors[0]!.markers;
    expect(markers).toHaveLength(1);
    expect(markers[0]!.observed_at).toBe('2025-02-16T00:00:00.000Z');
    expect(markers[0]!.label).toContain('Pro');
  });

  it('emits a competitor with no usable history rather than dropping it', () => {
    const payload = buildTimeline(db, GENERATED);
    expect(payload.competitors).toHaveLength(1);
    expect(payload.competitors[0]!.series).toEqual([]);
    expect(payload.competitors[0]!.first_observed_at).toBeNull();
    expect(payload.observation_count).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/timeline.test.ts`
Expected: FAIL — `buildTimeline` is not exported.

- [ ] **Step 3: Implement the export**

In `src/workflow/export.ts`, add the import and the builder:

```ts
import { observationsFor } from './detect.js';
```

```ts
/**
 * Wayback captures are monthly (spec 12.1, `collapse=timestamp:6`), so ~31 days
 * between points is normal and two consecutive missed months is a real hole in
 * the record. Spec 14.3: a hole renders as a break, never as interpolation.
 */
export const TIMELINE_GAP_DAYS = 75;
const GAP_MS = TIMELINE_GAP_DAYS * 86_400_000;

export interface TimelinePoint { observed_at: string; price: number }
export interface TimelineSeries { tier: string; segments: TimelinePoint[][] }
export interface TimelineMarker { observed_at: string; label: string }
export interface TimelineCompetitor {
  slug: string; name: string;
  first_observed_at: string | null; last_observed_at: string | null;
  series: TimelineSeries[]; markers: TimelineMarker[];
}
export interface TimelinePayload {
  generated_at: string; observation_count: number; competitors: TimelineCompetitor[];
}

/**
 * Spec 14.3. Every series break is decided here, so the React component holds
 * no judgement: it draws one polyline per segment and nothing else.
 *
 * Built on observationsFor(), which already applies the USD filter (12.4), the
 * prompt-version filter, the repeated-hash collapse (12.2), and Zod validation.
 */
export function buildTimeline(db: DB, generatedAt: string): TimelinePayload {
  const sources = db.prepare(`
    SELECT s.id AS source_id, c.slug, c.name
    FROM sources s JOIN competitors c ON c.id = s.competitor_id
    WHERE s.active = 1 AND c.active = 1 AND s.kind = 'pricing'
    ORDER BY c.name
  `).all() as { source_id: number; slug: string; name: string }[];

  const markerRows = db.prepare(`
    SELECT ch.source_id, ch.json_path, ch.change_type, ch.before_json, ch.after_json, ch.observed_at
    FROM changes ch
    WHERE ch.state = 'confirmed' AND ch.materiality >= ?
    ORDER BY ch.observed_at
  `).all(MATERIALITY_THRESHOLD) as {
    source_id: number; json_path: string; change_type: string;
    before_json: string | null; after_json: string | null; observed_at: string;
  }[];

  let observationCount = 0;
  const competitors: TimelineCompetitor[] = [];

  for (const source of sources) {
    const observations = observationsFor(db, source.source_id);
    observationCount += observations.length;

    // tier name -> the segments built so far, plus where the open one left off
    const building = new Map<string, { segments: TimelinePoint[][]; lastAt: number | null }>();

    for (const observation of observations) {
      const at = Date.parse(observation.observedAt);
      const priced = new Map<string, number>();
      for (const tier of observation.data.tiers) {
        // null is "contact sales", and it is not zero. Plotting it as zero
        // would be the most misleading thing this chart could do.
        if (typeof tier.monthly_price_usd === 'number') priced.set(tier.name, tier.monthly_price_usd);
      }

      for (const [name, price] of priced) {
        let entry = building.get(name);
        if (!entry) { entry = { segments: [], lastAt: null }; building.set(name, entry); }

        const open = entry.segments[entry.segments.length - 1];
        const continuous = open !== undefined && entry.lastAt !== null && at - entry.lastAt <= GAP_MS;

        if (continuous) open!.push({ observed_at: observation.observedAt, price });
        else entry.segments.push([{ observed_at: observation.observedAt, price }]);

        entry.lastAt = at;
      }

      // A tier absent from this observation ends its run: the next appearance
      // starts a new segment rather than a line drawn across its absence.
      for (const [name, entry] of building) {
        if (!priced.has(name)) entry.lastAt = null;
      }
    }

    const series: TimelineSeries[] = [...building.entries()]
      .map(([tier, entry]) => ({ tier, segments: entry.segments }))
      .filter(s => s.segments.length > 0)
      .sort((a, b) => a.tier.localeCompare(b.tier));

    competitors.push({
      slug: source.slug,
      name: source.name,
      first_observed_at: observations[0]?.observedAt ?? null,
      last_observed_at: observations[observations.length - 1]?.observedAt ?? null,
      series,
      markers: markerRows
        .filter(m => m.source_id === source.source_id)
        .map(m => ({ observed_at: m.observed_at, label: describeChange(m) })),
    });
  }

  return { generated_at: generatedAt, observation_count: observationCount, competitors };
}

/** Short, literal marker text. No adjectives — the number is the story. */
function describeChange(row: {
  json_path: string; change_type: string; before_json: string | null; after_json: string | null;
}): string {
  const tier = row.json_path.startsWith('tiers.')
    ? row.json_path.split('.').slice(1, -1).join('.') || row.json_path.slice(6)
    : row.json_path;
  const before = row.before_json === null ? 'none' : String(JSON.parse(row.before_json));
  const after = row.after_json === null ? 'none' : String(JSON.parse(row.after_json));
  if (row.change_type === 'price_change') return `${tier} ${before} to ${after}`;
  return `${tier} ${row.change_type.replace(/_/g, ' ')}`;
}
```

Then wire it into `exportData`, adding one entry to the `payloads` object:

```ts
  const payloads: Record<string, unknown> = {
    'board.json': board,
    'status.json': status,
    'changes.json': changesFeed,
    'timeline.json': buildTimeline(db, generatedAt),
  };
```

The existing shrink guard, `.tmp` staging, and atomic rename apply to the new file automatically — do not add a separate path for it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/timeline.test.ts tests/export.test.ts`
Expected: PASS. `tests/export.test.ts` may assert the exact `files` list — update it to include `timeline.json`.

- [ ] **Step 5: Add the loader and types on the web side**

In `web/lib/types.ts`, add the four interfaces from the payload shape above (structural copies — the web package does not import from `src/`).

In `web/lib/data.ts`:

```ts
export function loadTimeline(): Timeline {
  return read<Timeline>('timeline.json', {
    generated_at: '', observation_count: 0, competitors: [],
  });
}
```

- [ ] **Step 6: Add the series palette**

In `web/app/globals.css`, inside the top-level `@theme` block:

```css
  --color-series-1: #2563a8;
  --color-series-2: #1f7a5c;
  --color-series-3: #9a6b00;
  --color-series-4: #7c4a9a;
  --color-series-5: #b03a2e;
```

and inside the existing dark `:root` override block (the same one that already redefines `--color-ink` etc.):

```css
  --color-series-1: #6aa8e8;
  --color-series-2: #4fd1a5;
  --color-series-3: #e0a33a;
  --color-series-4: #b98ad8;
  --color-series-5: #f07167;
```

> **Implementer note:** Tailwind v4's `@theme` cannot nest inside `@media` — `web/app/globals.css` already carries a comment saying so, and the dark palette is defined by redefining the custom properties on `:root` in a separate block. Follow the pattern that is already in the file exactly; do not introduce a nested `@theme`.

- [ ] **Step 7: Build the chart component**

Create `web/components/Timeline.tsx`. Inline SVG, no charting dependency, no client-side JavaScript — this is a static export.

```tsx
import type { TimelineCompetitor } from '@/lib/types';

const WIDTH = 720;
const HEIGHT = 132;
const PAD_X = 8;
const PAD_Y = 14;
const SERIES_COLORS = [
  'var(--color-series-1)', 'var(--color-series-2)', 'var(--color-series-3)',
  'var(--color-series-4)', 'var(--color-series-5)',
];

const money = (n: number) => (n === 0 ? '$0' : `$${n.toLocaleString('en-US')}`);
const month = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function Timeline({ competitor }: { competitor: TimelineCompetitor }) {
  const points = competitor.series.flatMap(s => s.segments.flat());

  // One point cannot be a line, and saying so is more useful than an empty box.
  if (points.length < 2) {
    return (
      <p className="text-sm text-ink-muted">
        Not enough history yet — a line needs at least two observations.
      </p>
    );
  }

  const times = points.map(p => Date.parse(p.observed_at));
  const prices = points.map(p => p.price);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);

  const x = (iso: string) =>
    PAD_X + (tMax === tMin ? 0 : (Date.parse(iso) - tMin) / (tMax - tMin)) * (WIDTH - PAD_X * 2);
  const y = (price: number) =>
    HEIGHT - PAD_Y - (pMax === pMin ? 0.5 : (price - pMin) / (pMax - pMin)) * (HEIGHT - PAD_Y * 2);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={
          `${competitor.name} monthly prices from ${month(competitor.first_observed_at!)} ` +
          `to ${month(competitor.last_observed_at!)}, ${money(pMin)} to ${money(pMax)}.`
        }
      >
        {competitor.markers.map(marker => (
          <line
            key={`${marker.observed_at}-${marker.label}`}
            x1={x(marker.observed_at)} x2={x(marker.observed_at)}
            y1={PAD_Y - 6} y2={HEIGHT - PAD_Y + 6}
            stroke="var(--color-rule-strong)" strokeWidth="1" strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {competitor.series.map((s, i) =>
          s.segments.map((segment, j) => (
            <g key={`${s.tier}-${j}`}>
              <polyline
                points={segment.map(p => `${x(p.observed_at)},${y(p.price)}`).join(' ')}
                fill="none" stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              {segment.map(p => (
                <circle
                  key={p.observed_at} cx={x(p.observed_at)} cy={y(p.price)} r="2.5"
                  fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                />
              ))}
            </g>
          )),
        )}
      </svg>

      <figcaption className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 font-mono text-xs text-ink-muted">
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          {competitor.series.map((s, i) => {
            const last = s.segments[s.segments.length - 1]?.at(-1);
            return (
              <span key={s.tier} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                />
                <span className="text-ink-secondary">{s.tier}</span>
                {last && <span>{money(last.price)}</span>}
              </span>
            );
          })}
        </span>
        <span>
          {month(competitor.first_observed_at!)} to {month(competitor.last_observed_at!)}
          {' · '}{money(pMin)}-{money(pMax)}
        </span>
      </figcaption>
    </figure>
  );
}
```

- [ ] **Step 8: Render the section**

In `web/app/page.tsx`, import `loadTimeline` and `Timeline`, and insert a section between "The record" and the footer:

```tsx
      <section className="mt-12">
        <h2 className="font-display text-2xl font-medium text-ink">The timeline</h2>
        <p className="mt-2 max-w-2xl text-ink-secondary">
          Monthly price per tier, seeded from the Internet Archive. Historical captures are monthly,
          so a change is dated to within a month of when it happened. Where the archive has no
          capture the line breaks — nothing here is interpolated.
        </p>

        {timeline.observation_count === 0 ? (
          <p className="mt-6 text-sm text-ink-muted">
            No history yet. Run <span className="font-mono">bellwether backfill</span> to seed it.
          </p>
        ) : (
          <div className="mt-8 grid gap-10">
            {timeline.competitors.map(competitor => (
              <article key={competitor.slug} className="rounded-lg border border-rule bg-surface-raised p-5">
                <h3 className="font-display text-lg font-medium text-ink">{competitor.name}</h3>
                <div className="mt-4">
                  <Timeline competitor={competitor} />
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
```

- [ ] **Step 9: Verify the web build**

Run: `cd web && pnpm build`
Expected: static export succeeds with no type errors. Then `pnpm dev` and confirm by eye that the chart renders, the legend colours match the lines, and the layout holds at a 375px-wide viewport.

- [ ] **Step 10: Full suite, typecheck, and commit**

```bash
pnpm vitest run && pnpm typecheck
git add src/workflow/export.ts web/ tests/timeline.test.ts tests/export.test.ts
git commit -m "feat(timeline): export per-tier price history and render it"
```

---

## Post-execution: the live backfill

Not a task — the controller runs this after Task 6 is reviewed and merged, because it costs real money and touches the live archive.

- [ ] **Dry run first.** `pnpm bw backfill --discover-only` and read the printed estimate. Expect ~110-125 captures and roughly $1.10-$1.30.
- [ ] **Slice the first run.** `pnpm bw backfill --limit 12 --budget 2.00`, then eyeball the result:
      `sqlite3 data/bellwether.db "SELECT observed_at, provenance FROM snapshots WHERE provenance LIKE 'wayback:%' ORDER BY observed_at LIMIT 12;"`
      Every `observed_at` must be a historical date. If any reads as today, stop — that is the failure spec 12.1 warns about, and it is far cheaper to catch at 12 rows than at 120.
- [ ] **Human-eyeball the extractions.** The M2 lesson that grounding cannot catch: an omitted tier passes every automated check. Compare two or three extracted historical prices against the actual archived page in a browser before trusting the rest.
- [ ] **Complete the run.** `pnpm bw backfill --budget 3.00`, then `pnpm bw export` and check `web/public/data/timeline.json` before publishing.
- [ ] **Publish.** `pnpm bw export --publish`.
- [ ] **Update the homelab.** `git pull && docker compose up -d --build` on `nicksaiserver`. The box holds an independent archive, so it needs its own backfill run — or it can stay live-only, since publishing happens from the Mac until M5.

## Deferred

- **`collect` builds a fresh `HostRateLimiter` per call** (`politeFetch(source.url)` with no deps), so its 10s/host limit never applies across sources. Harmless today because the six competitors sit on six distinct hosts, and untouched by this milestone. Fix by hoisting one limiter and one `RobotsCache` in `collect`, the way Task 3's `waybackFetcher` does. Worth doing when the watch list grows past one page per host.
- **Message Batches API for the extraction corpus** (spec 12.1, ruling R1). Revisit at M3.5 when the watch list expands past ~20 competitors. The upgrade point is the single `extract` call in `runBackfill`.
- **Disputed-state tiebreak by re-extraction** (spec 12.5). Monthly captures make the consecutive-change gap more common than daily collection does, so expect `disputed` rows after the first backfill. They are recorded and excluded from publication, which is correct but incomplete.
- **`analyses` re-linking across `detect --rebuild`** (spec 12.2: "annotations are re-linked by
  (source_id, json_path, observed_at) where the change survives rebuild, and orphaned annotations
  are deleted"). `detect --rebuild` currently does a bare `DELETE FROM changes WHERE source_id = ?`,
  and `analyses.change_id` is a foreign key into it. Unreachable in M3 because nothing writes
  `analyses` until the M4 weekly synthesis step — but the first rebuild after M4 ships will either
  fail on the foreign key or silently orphan every annotation. Fix it in the same milestone that
  first writes to that table, not before.
- **Capture-time fidelity under redirect.** `politeFetch` follows redirects and `FetchResult`
  carries no final URL, so if the Archive 302s `/web/<ts>id_/<url>` to a neighbouring capture —
  possible when a capture is excluded between discovery and drain — the body is stored under the
  *requested* stamp rather than the served one. Surfaced by the Task 4 review. Fixing it means
  adding a final-URL field to `FetchResult`, which touches live collection too, so it is out of
  M3's scope. The error is bounded by how far apart neighbouring captures are, which is inside
  the monthly resolution the timeline already states. Fix when `FetchResult` is next revised.
- **A `prompt_version` bump does not re-attempt permanently-failed historical snapshots.** The
  final review's fix records a deterministic extraction failure in `snapshots.error` and excludes
  that row from `extract`'s pending set forever, which is right for `oversized` (a page's token
  count does not change with the prompt) but not for `invalid` or `ungrounded`, which are
  prompt- and model-dependent. Spec 7.1 makes reprocessing history under a better prompt a
  headline capability, so those rows should come back into play on a bump. Until that is built,
  clearing them is one statement:
  `UPDATE snapshots SET error = NULL WHERE ok = 1 AND error LIKE 'extraction %';`
  Wire it into whatever command implements `bellwether extract --all`.
- **`bellwether qualify`** and the watch-list expansion to 50 competitors (M3.5).
