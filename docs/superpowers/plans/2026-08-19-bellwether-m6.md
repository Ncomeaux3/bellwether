# Bellwether M6 — The Portfolio Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the site say what the system actually is: a ledger of dated evidence, with citable per-competitor pages and a page that publishes its own failure state and running cost.

**Architecture:** No new backend concepts. `export` gains two derived payloads (per-competitor detail, and pipeline/health/cost figures for the mechanics page); the web app gains a shared chart primitive (the change ribbon) at three scales, the spec's type and colour systems as tokens, per-competitor static routes, and a mechanics page. Everything stays a static export with no client JS beyond what native SVG gives.

**Tech Stack:** unchanged — Next.js App Router static export, Tailwind v4 CSS-first, inline SVG, `next/font/google`. No charting library.

**Spec:** `docs/superpowers/specs/2026-08-18-bellwether-design.md` §14.2 (views 2/4/5), §14.3 (UI design, charts, copy, quality floor), §14.4 (per-competitor pages own their queries).

## Global Constraints

- **Static export only.** No `'use client'`, no client-side JS, no runtime data fetching. Interactivity is native SVG (`<title>` tooltips, `:hover`/`:focus-visible` CSS) or it does not ship.
- **Step-after interpolation, never sloping lines** (spec §14.3). Prices are piecewise constant; a diagonal between two observations asserts a change that did not happen. This is a correctness rule.
- **Observation gaps render as gaps.** Never bridge missing data. The exporter already splits segments — keep that contract.
- **Colour: three systems that never mix** (spec §14.3) — diverging pair for price direction, four fixed-ordinal tier hues (never cycled), three status hues (reserved, never a fourth series, always paired with an icon or label so state is never colour-alone). **Colour encodes tier, never competitor.**
- **Tabular numerals everywhere numbers appear**, including inline in prose. In a price archive, digits that do not line up are a defect.
- **Copy rules** (spec §14.3): active voice, sentence case, named from the reader's side. Empty and failure states carry direction and specifics, never mood — "No confirmed changes since 12 August. Last checked 3 hours ago", never "No data". Errors never apologise and are never vague.
- **Quality floor, met without announcing it:** responsive to mobile, visible keyboard focus, `prefers-reduced-motion` respected, semantic `<table>` for tabular data, every chart readable at 200% zoom.
- The web package has no test runner; correctness rides on the build plus **rendered-HTML assertions** — every task that changes output greps `web/out/` for what it claims to have produced, and pure logic that can live in `src/` is tested there with vitest (460 currently green).
- No new runtime dependencies beyond `next/font` (already part of Next).

## Rulings made before execution

**R1 — The ribbon replaces the current line chart rather than joining it.** Spec §14.3 names the ribbon the signature and says one primitive at three scales is what makes fifty companies legible. Shipping both a line chart and a ribbon would be two visual languages for one dataset. The hero scale on a competitor page *is* the chart; the row scale replaces the board's current per-competitor chart block; the sparkline scale is for the index at 50 companies (built now, used now on the board index). *Cost if wrong:* rework of one component's call sites.

**R2 — Step-after is implemented as an explicit point expansion, not a stroke style.** For each pair of consecutive points in a segment, emit the horizontal leg at the old price and the vertical leg at the new date. This keeps the SVG honest under any renderer and makes the correctness rule visible in the code rather than hidden in a `stroke-linejoin`. It also means the existing gap-splitting logic needs no change.

**R3 — Per-competitor pages are generated from `board.json` + a new `competitors/<slug>.json`, one file per competitor.** A single fat payload would ship every competitor's history into every page's bundle. `generateStaticParams` reads the board; each page reads only its own file. *Cost if wrong:* one more file per competitor in the export (six today, fifty later — still trivial).

**R4 — The mechanics page reports only figures the database can prove.** Every number on "How it works" is derived from a query at export time — no hand-written claims that can rot. Where a figure is not derivable (e.g. an architecture description), it is prose, clearly not a metric. A number that cannot be computed is omitted rather than estimated.

## File Structure

| File | Responsibility |
|---|---|
| `src/workflow/export.ts` (modify) | Emit `competitors/<slug>.json` per competitor and `mechanics.json`; keep every existing artifact byte-identical for unchanged inputs. |
| `src/workflow/mechanics.ts` (create) | Pure queries: filter hit rates, per-source health, cumulative and monthly spend, archive size, coverage window. |
| `web/app/globals.css` (modify) | The spec's type and colour tokens; `font-variant-numeric: tabular-nums` as a base rule. |
| `web/app/layout.tsx` (modify) | `next/font/google` for Bricolage Grotesque, Public Sans, IBM Plex Mono. |
| `web/components/Ribbon.tsx` (create) | The signature primitive at three scales (`row` \| `hero` \| `spark`), step-after, gaps as gaps, `<title>` tooltips. |
| `web/components/Timeline.tsx` (delete or reduce) | Superseded by Ribbon per R1. |
| `web/app/c/[slug]/page.tsx` (create) | Per-competitor page: hero ribbon, tier table, that competitor's change list, JSON-LD `Dataset`, citation, links to its own JSON. |
| `web/app/how-it-works/page.tsx` (create) | The mechanics page (spec §14.2 view 5). |
| `web/app/page.tsx` (modify) | Board uses row-scale ribbons; links to competitor pages; copy pass. |
| `web/lib/types.ts`, `web/lib/data.ts` (modify) | Loaders for the two new payload shapes. |
| `tests/mechanics.test.ts` (create), `tests/export.test.ts` (modify) | Coverage for the new derivations and files. |

---

### Task 1: Step-after interpolation — a live correctness defect

`web/components/Timeline.tsx` draws `<polyline>` straight between monthly observations. On the live site Linear's Basic tier currently shows a **diagonal ramp** from $8 to $10 across Oct–Nov 2025, asserting a gradual rise. The price jumped on one day. Spec §14.3 calls this out by name as "a correctness rule, not a stylistic one, and the most common way a pricing chart lies."

Fix it in the existing component first, before any restructuring, so the defect is off the live site independent of the rest of the milestone landing.

**Files:** `web/components/Timeline.tsx`; a new pure helper in `src/workflow/dataset.ts` so it is vitest-testable: `export function stepPoints(points: {observed_at: string; price: number}[]): {observed_at: string; price: number}[]` — for each consecutive pair, emit the original point plus an intermediate point at the NEXT observation's date and the CURRENT price (the horizontal leg); the vertical leg is then implicit. A single-point segment returns itself unchanged.
**Tests** (`tests/dataset.test.ts`): three points at $8/$8/$10 expand to five with the step at the right date; a one-point segment is unchanged; an empty segment is unchanged; the expansion never reorders or drops an original point.
**Web:** the component maps `stepPoints(segment)` before building the polyline — but the web package cannot import from `src/`, so port the same ~10-line function into `web/lib/` **and pin the two together with a cross-check test in the root suite** exactly as `changeLabel`/`describeChange` are pinned today (read that test first — it is the established pattern for this hazard).
**Gate:** `cd web && corepack pnpm build`, then grep the rendered `web/out/index.html` for a Linear polyline containing two consecutive points that share a y-coordinate (proof of a horizontal leg), and confirm no polyline has a segment where both x and y change between adjacent points.

### Task 2: Type and colour systems

**Files:** `web/app/layout.tsx`, `web/app/globals.css`.
- `next/font/google`: Bricolage Grotesque (variable, display), Public Sans (body), IBM Plex Mono (data). Expose as CSS variables; set `display: swap`; subset latin. Confirm the build does not reach the network at request time (Next self-hosts Google fonts at build).
- Tokens per spec §14.3's three colour systems, defined in the existing light/dark token pattern (`@theme` at top level, `:root` overrides for dark — the file already documents why `@theme` cannot nest in `@media`):
  - **diverging pair** `--color-rise` / `--color-fall` with a neutral midpoint token — the strongest colour in the system, used only for price direction;
  - **four tier hues** replacing today's four (`free`/`entry`/`mid`/`enterprise` already exist from M3 — keep the names, re-tune if needed for contrast against the new surfaces);
  - **status trio** unchanged, and every use must carry an icon or text label so state is never colour-alone.
- Base rule: `font-variant-numeric: tabular-nums` on `:root`, so digits align everywhere including in prose.
- **Do not run a palette validator that does not exist** — spec §14.3 requires `scripts/validate_palette.js` from the `dataviz` skill; it is not present in this environment (verified during M3). State that in a comment and record the adjacent-pair contrast you did check by hand (WCAG AA for text, 3:1 for adjacent series strokes).
- **Gate:** build, then grep `web/out/` for the font CSS being self-hosted (a `/_next/static/media/*.woff2` reference, not a `fonts.googleapis.com` link), and confirm both themes' tokens are emitted.

### Task 3: The change ribbon

**Files:** `web/components/Ribbon.tsx` (create); `web/components/Timeline.tsx` (remove after call sites move).

One component, prop `scale: 'row' | 'hero' | 'spark'`, consuming the existing `TimelineCompetitor` shape. Per spec §14.3:
- Every observation is a tick; every confirmed change is a notch **labelled** (`$16 → $18`) at hero scale, a notch without text at row scale, nothing but the line at spark scale;
- every gap in observation is a visible gap;
- step-after throughout (Task 1's helper);
- `<title>` on every notch and every tick group (native tooltip, no JS); hit targets larger than the marks (an invisible wider `<rect>` or `stroke-width` on a transparent overlay path);
- `:focus-visible` outline on interactive elements; `prefers-reduced-motion` respected (no transitions at all is the simplest compliance);
- readable at 200% zoom: no text below 11px at hero, and the row scale degrades to spark on narrow viewports via CSS, not JS.

**Gate:** build; grep rendered output for notch labels at hero scale, their absence at spark scale, and `<title>` presence; verify at 375px and at 200% zoom by inspecting the emitted markup for fixed pixel widths that would overflow (there must be none — use viewBox + `width: 100%`).

### Task 4: Per-competitor pages

**Files:** `src/workflow/export.ts` (emit `competitors/<slug>.json`), `web/app/c/[slug]/page.tsx`, `web/lib/*`.

- Export payload per competitor: identity (name, slug, homepage, source URL), current tiers, that competitor's full timeline series and markers, its confirmed changes with annotations, first/last observed, and provenance mix. Reuse existing builders — do not re-derive filters.
- Page: `generateStaticParams` from `board.json`; hero ribbon; a semantic `<table>` of current tiers (tabular numerals); that competitor's change list with annotations; **JSON-LD `Dataset`** in a `<script type="application/ld+json">` with name, description, license (`https://creativecommons.org/licenses/by/4.0/`), `distribution` pointing at its own JSON and the CSV, `temporalCoverage` from first/last observed; `<title>` "Linear pricing history — every change since 2025" and a matching meta description (spec §14.4's exact framing); a citation block; a link to its own JSON.
- The board and the RSS feed's `<link>` currently point at `/#slug`; **update both to `/c/<slug>`** now that the route exists (`src/workflow/dataset.ts`'s `buildRssXml` and `buildLlmsTxt`, plus the board's competitor names becoming links). This closes a deliberate M4 deferral — note it in the commit.
- **Gate:** build; confirm six directories under `web/out/c/`; validate one page's JSON-LD parses and carries the license and temporalCoverage; confirm the RSS `<link>` and llms.txt now resolve to real pages (check the file exists at that path in `web/out`).

### Task 5: How it works — the mechanics page

**Files:** `src/workflow/mechanics.ts` (create), `src/workflow/export.ts` (emit `mechanics.json`), `web/app/how-it-works/page.tsx`, `tests/mechanics.test.ts`.

Every number derived at export time (ruling R4). `buildMechanics(db, now)` returns:
- **Filter hit rates** — the layered cost filter's real numbers: total snapshots; how many were byte-identical repeats (`raw_content IS NULL`, the content-addressed dedup); how many distinct normalized states; how many extractions actually ran; the resulting "LLM calls avoided" count and percentage. These are the spec's differentiator made visible.
- **Coverage** — first and last observation, distinct months covered, live vs backfilled snapshot counts.
- **Health** — per source: state, last ok, degraded reason; plus the last run of each kind with state and time.
- **Cost** — cumulative `cost_micros` across `extractions` + `digests`, this month's recurring figure, backfill's one-time figure, and cost per confirmed change. Never a projection — only what was spent.
- Page: the architecture in prose (short), the filter table with the live numbers, source health with icon+label (never colour alone), the spend figures, and the run history. Copy per spec §14.3 — specific, no mood.
- **Tests:** each derivation against a seeded temp DB with known counts; the dedup rate computed from a fixture with a known number of repeat snapshots; cost-per-change guarded against divide-by-zero (no confirmed changes → omit the figure, per R4).

### Task 6: Copy, empty states, and the quality floor

**Files:** every page; `web/app/globals.css`.

- Rewrite every empty and failure state to spec §14.3's rule — specific and directional. Inventory them first (board with no changes, competitor page with no history, digest absent, dataset absent, a degraded source) and write each with real data in the sentence (dates, counts, last-checked times) pulled from the payloads already loaded.
- Quality floor sweep: visible `:focus-visible` on every interactive element; `prefers-reduced-motion` honoured; semantic `<table>` with `<th scope>` wherever data is tabular; heading hierarchy contiguous; every chart readable at 200% zoom; colour never the sole carrier of state.
- **Gate:** build; grep rendered HTML for: no `No data`/`Error loading`/`Loading...` strings anywhere; `<th scope=` present on data tables; a `prefers-reduced-motion` block in the CSS; every `<article>`/section heading in order. Then a manual pass at 375px and 200% zoom, reported honestly in the task report.

## Post-execution (controller)

- [ ] `pnpm bw export` locally, inspect every page by eye at desktop, 375px, and 200% zoom, in both light and dark.
- [ ] Verify the live-defect fix specifically: Linear's Basic tier must show a flat run then a vertical step, never a diagonal.
- [ ] `pnpm bw export --publish`; confirm the site and that `/c/linear` resolves; re-check the RSS `<link>` targets now 200 rather than the old anchor.
- [ ] Update the homelab (`git pull && docker compose up -d --build`) so the box's exports include the new payloads.

## Deferred

- The citation badge snippet (spec §14.4) — belongs with a share/embed pass, not this one.
- Crosshair-with-readout on the hero ribbon (spec §14.3 asks for crosshair *and* tooltip); `<title>` tooltips ship now, a true crosshair needs client JS and the site is a no-JS static export. Revisit only if the constraint is relaxed.
- **The `row` and `spark` ribbon scales ship unused** (plan R1 said the board would use them). At
  six competitors the hero scale reads well and `BoardTable` would need restructuring to host a
  chart column; the two scales exist and are correct but have no call site. Wire them when the
  watch list expands — that is the scale at which the spec's argument for them applies.
- **Notch labels can still collide between two DIFFERENT dates close in time** (Notion's May/June
  2025). The same-date case is fixed by merging; there is no x-collision detection for near-date
  notches. First follow-up on this component.
- **Chart labels are legible but small at 375px** — a pre-existing consequence of the fixed
  viewBox, not introduced here. Fixing it properly is a responsive-layout task.
- **The $5/month budget guard undercounts.** `monthlySpendMicros` sums `extractions` + `digests`,
  but a rejected extraction (`invalid`/`ungrounded`) is billed and writes no extractions row — 9
  such calls in the current archive. Harmless today ($0.11 against $5) but the ceiling can be
  exceeded. Fixing it means threading usage through `extractPricing`'s failure paths and finding a
  home for cost with no extraction row to attach it to.
- **Six tier hues cannot all separate by 2:1 while each also holds 3:1 against both surfaces** —
  a real luminance-range limit, proven during execution. Adjacent pairs clear 3:1; the
  worst non-adjacent pair is 1.86:1 (up from 1.07:1). Mitigated by the spec's own rule that four
  or fewer series carry direct labels, so hue is never the sole identifier.
- Small-multiple index at 50 companies — the spark scale is built here; the index layout that uses it belongs with M3.5's expansion.
