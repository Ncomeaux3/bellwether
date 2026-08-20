# Bellwether M3.5 — Qualify and Expand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a six-company demo into a defensible archive: screen the candidate pool automatically, admit every passer, and make fifty competitors legible on one screen.

**Architecture:** One new tool, `qualify`, which fetches a candidate once and decides from the **raw** HTML whether its pricing is server-rendered — no human judgment, no LLM. Its output is both a config generator and a publishable finding ("screened N, M publish server-rendered pricing"). Nothing else in the pipeline changes: cost scales with *changes*, not with competitors watched, so a wider list is close to free. The UI work is the M6 deferrals that exist precisely for this scale — the ribbon's unused `row` and `spark` renderings, and label collision, both of which only matter once the board holds fifty rows.

**Tech Stack:** unchanged. `qualify` reuses `politeFetch` (robots.txt, 10s/host rate limit, redirect and SSRF guards) — screening third-party sites must be as polite as collection.

**Spec:** `docs/superpowers/specs/2026-08-18-bellwether-design.md` §11.1 (the candidate pool), §11.2 (qualification), §14.3 (the ribbon at three scales), §16 (cost at scale).

## Global Constraints

- **No LLM in qualification.** Spec §11.2 is explicit that this is counting, not judgment: currency symbols and tier-like headings in raw HTML. An LLM here would cost money per candidate and make the boundary unauditable.
- **Politeness is not optional.** Every candidate fetch goes through `politeFetch`: robots.txt honoured, one request per host, jittered. Screening ~45 third-party sites is the largest outbound burst this project has ever made — it must look like a well-behaved crawler or the project's own positioning is hypocritical.
- **The boundary must be publishable.** Both passers and failures are recorded with the reason. Spec §14.5: "naming the exclusions is what makes the inclusions credible."
- **Cost stays bounded.** New sources backfill at **12 months**, not 18 (spec §12.1), cutting one-time cost by a third. Backfill runs under its own `--budget`.
- **Colour encodes tier, never competitor** (spec §14.3, hard rule) — at fifty companies a categorical scale per competitor is impossible; separation is by small multiples and position.
- No new runtime dependencies. TypeScript strict with `noUncheckedIndexedAccess`; `.js` imports; tests in `tests/` on temp-dir SQLite; conventional commits. 483 tests currently green — all must stay green.
- **No test makes a network request.** `qualify` takes an injected fetcher exactly as `collect` and `backfill` do.

## Rulings made before execution

**R1 — Qualification is a scored verdict with a stated threshold, not a boolean guess.** Spec §11.2 says "count currency symbols and tier-like headings". Two counts alone will misclassify: a blog post about pricing has currency symbols and no tiers; a feature-comparison page has tier headings and no prices. The verdict requires **both** signals above a floor (at least 3 currency-and-digit matches AND at least 2 tier-like headings), plus a price appearing within a bounded distance of a heading, so the two are demonstrably about the same block. The thresholds are named constants with the measured evidence in a comment. *Cost if wrong:* a candidate is mis-screened; the recorded reason makes it a one-line config fix, which is the point.

**R2 — The proposed `canary_string` comes from the tier heading, never from a price.** A canary exists to detect a redesign, and prices change legitimately. Spec §15.6 wants a canary whose failure means "the page moved", not "the price moved". Take the longest tier-like heading that is not a number, so the M1 competitors' conservative `"Enterprise"` canaries get upgraded too where a stronger candidate exists.

**R3 — Screening writes to the database, not only to stdout.** A new `candidates` table records url, verdict, the two counts, the proposed canary, and when it was screened. Re-running is then idempotent and the published finding is derived from data rather than from a transcript someone pasted. *Cost if wrong:* one migration; the alternative is a boundary claim with no provenance.

**R4 — The board becomes small multiples at scale, but only past a threshold.** Spec §14.3 gives three scales and says the small multiple is "the index at 50 companies". Six hero ribbons read well today; fifty would not fit. The board renders hero ribbons at or below 8 competitors and switches to a small-multiple grid above it. One threshold constant, so the transition is a decision the code states rather than a redesign.

## File Structure

| File | Responsibility |
|---|---|
| `migrations/002_candidates.sql` (create) | The `candidates` table. |
| `src/tools/qualify.ts` (create) | Pure scoring: count price matches and tier-like headings in raw HTML, propose a canary, return a verdict with reasons. No I/O. |
| `src/workflow/qualify.ts` (create) | Fetch each candidate via `politeFetch`, score it, upsert into `candidates`. |
| `src/config/candidates.public.ts` (create) | The spec §11.1 candidate pool as data. |
| `src/cli.ts` (modify) | `bellwether qualify [--url <u>...] [--all] [--limit n]`, and `--emit-config` to print admitted entries. |
| `src/workflow/export.ts` (modify) | Publish the screening finding into `mechanics.json` (counts, pass rate, the named exclusions). |
| `web/components/Ribbon.tsx` (modify) | Wire the `row` and `spark` scales; fix near-date notch collision. |
| `web/app/page.tsx` (modify) | Small-multiple grid above the threshold. |
| `web/app/data/page.tsx` (modify) | The boundary section: screened N, admitted M, and why each exclusion failed. |
| `tests/qualify.test.ts` (create), plus modifications | Coverage. |

---

### Task 1: The qualify tool and workflow

**Files:** `migrations/002_candidates.sql`, `src/tools/qualify.ts`, `src/workflow/qualify.ts`, `src/config/candidates.public.ts`, `src/cli.ts`, `tests/qualify.test.ts`.

**Schema** (`002_candidates.sql`) — follow `001_init.sql`'s style exactly:
```sql
CREATE TABLE candidates (
  id INTEGER PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  verdict TEXT NOT NULL,               -- 'pass' | 'fail' | 'error'
  reason TEXT NOT NULL,
  price_matches INTEGER NOT NULL DEFAULT 0,
  tier_headings INTEGER NOT NULL DEFAULT 0,
  proposed_canary TEXT,
  http_status INTEGER,
  screened_at TEXT NOT NULL
);
```
Check how `migrate.ts` discovers and checksums migrations before adding one — an existing archive must migrate cleanly, and the box's 127 MB database is the real test.

**Pure scoring** (`src/tools/qualify.ts`):
- `export interface QualifyVerdict { verdict: 'pass' | 'fail'; reason: string; priceMatches: number; tierHeadings: number; proposedCanary: string | null }`
- `export function scoreCandidate(rawHtml: string): QualifyVerdict`
- Count price matches with the existing `PRICE_PATTERN` idiom (`/[$€£]\s?\d/g` — import it from `collect.ts`, already exported; do not define a second regex).
- Count **tier-like headings**: text inside `<h1>`–`<h4>` and elements whose class or id contains `tier`/`plan`/`price`, that is short (≤ 40 chars), non-numeric, and not navigation boilerplate. Use `node-html-parser`, and run it through the same **whitespace-closer normalization** `normalize.ts` applies — that bug (a `</style\n\t>` swallowing 1.19 MB into one text node) would silently score every affected page as a fail. Import that helper rather than duplicating it.
- Proximity: at least one price match must occur within 2,000 characters of a tier heading's text, so the two signals are about the same block (R1).
- Thresholds as named constants with a comment recording that the six known-good pages and Vercel were the calibration set.
- `proposedCanary`: the longest qualifying heading that contains no digit (R2), else null.

**Workflow** (`src/workflow/qualify.ts`): `qualifyCandidates(db, opts, deps)` — takes `{ urls?, all?, limit? }` and `{ fetcher?, now? }`, defaults to a shared `politeFetch` with ONE hoisted `HostRateLimiter` and `RobotsCache` (the mistake `collect` still has — read `src/workflow/backfill.ts`'s `waybackFetcher()` for the correct pattern), fetches each unscreened candidate, scores it, upserts into `candidates`, and returns stats. A fetch failure records `verdict='error'` with the status — an unreachable site is not a qualification failure and must be distinguishable.

**Candidate pool** (`src/config/candidates.public.ts`): every company named in spec §11.1, with `name`, `category`, and a pricing URL. Include **Vercel** — the spec calls it "a known qualification failure and a useful test case", so it belongs in the pool as a live check that the screen actually rejects something.

**CLI:** `bellwether qualify [--url <u>]... [--all] [--limit n] [--emit-config]`. `--emit-config` prints TypeScript entries for every `pass` row, ready to paste into `competitors.public.ts` (Task 2 uses this).

**Tests:** score the six known-good pages from **committed fixtures** (`tests/fixtures/` — check what exists; if the real pages are not fixtured, build small representative ones) → all pass; a Vercel-shaped shell (few prices, no tier headings) → fail with a reason naming which signal was missing; a page with prices but no tiers → fail; a page with tiers but no prices → fail; proximity: prices and headings 50 KB apart → fail; the whitespace-closer page (the M3 Linear shape) → still scores correctly; canary proposal never returns a string containing a digit; workflow-level: an injected fetcher, an error verdict on a 404, idempotent re-run.

- [ ] Steps: migration → failing tests → pure scorer → workflow → CLI → full suite + typecheck → commit `feat(qualify): screen candidates for server-rendered pricing`.

### Task 2: Screen the pool and admit the passers

**Files:** `src/config/competitors.public.ts`, and whatever `--emit-config` needs to be correct.

This task is **controller-run for the network part** (screening real sites is a live burst and is not a subagent's to make), then an implementer folds the results in. The implementer's job:
- Take the emitted config (the controller will provide the actual verdicts as a file in the workspace), merge it into `competitors.public.ts` preserving the existing six **and their current canaries unless qualify proposed a strictly better one** — an upgraded canary changes collection behaviour, so each change is called out in the report.
- Every admitted entry gets `cadenceHours: 24` and `kind: 'pricing'`.
- Update `tests/seed.test.ts` (or equivalent) for the new count, and confirm `seedCompetitors` is genuinely idempotent at this size — it will now run against ~50 rows on every container start.
- Sanity: no duplicate slugs, every URL https, every canary non-empty and digit-free.

- [ ] Steps: merge → tests → full suite → commit `feat(config): admit the qualified watch list`.

### Task 3: The ribbon at fifty — row and spark scales, and label collision

The two M6 deferrals, now prerequisites. **Files:** `web/components/Ribbon.tsx`, `web/app/page.tsx`, `web/lib/*` as needed.

- **Wire `row` and `spark`.** They exist and are correct but have no call site. Per R4, the board renders hero ribbons at ≤ 8 competitors and a **small-multiple grid** above that: one spark per competitor, name and current entry price beside it, linking to `/c/<slug>`. One named threshold constant.
- **Near-date collision.** Notch labels overlap when two changes fall close in time but not on the same day (reproduced on Notion's May/June 2025). The same-date case already merges; this needs x-collision detection. Measure each label's approximate width, walk them left to right, and where two would overlap, drop the later one's text but keep its notch and its `<title>` — never render two labels on top of each other. At hero scale only.
- Re-verify the milestone-critical invariants after any geometry change: **zero diagonal polyline segments** across every built page (step-after is a correctness rule), gaps still render as gaps, `<title>` still present, and the accessible name still attaches to the focusable element.

- [ ] Steps: wire scales → collision → gates (build, grep rendered HTML, diagonal count) → commit `feat(web): small multiples at scale and near-date label collision`.

### Task 4: Publish the boundary

**Files:** `src/workflow/mechanics.ts`, `src/workflow/export.ts`, `web/app/data/page.tsx`, `web/app/how-it-works/page.tsx`, tests.

Spec §11.2: *"The screening results are themselves publishable: 'screened N companies; M publish server-rendered pricing' is a finding no competitor reports, and it belongs on the `/data` page."* Spec §14.5: naming the exclusions is what makes the inclusions credible.

- Extend `buildMechanics` with a `screening` block derived from `candidates`: total screened, passed, failed, errored, pass rate, and the failures grouped by reason. Keep R4-of-M6's rule — every figure queried, nothing estimated, anything uncomputable omitted.
- `/data`'s boundary section becomes data-driven: the current hand-written "Vercel and Jira were screened out for client-side rendering" is replaced by the real list with each one's recorded reason. Keep the prose framing.
- Add the headline finding to `/how-it-works` alongside the filter table.

- [ ] Steps: mechanics extension + tests → pages → build + rendered-HTML gates → commit `feat(web): publish the screening boundary`.

## Post-execution (controller — the network and money steps)

- [ ] `bw migrate` on the Mac, then `bw qualify --all` against the real pool. This is ~45 polite fetches at one per host with jitter; expect several minutes. **Read the verdicts before admitting anything** — spot-check two passes and two failures against the live pages by eye, because a mis-screen admits a source that will fail extraction nightly.
- [ ] Feed the verdicts to Task 2's implementer; review the resulting config diff for canary upgrades on the existing six.
- [ ] `bw collect` once to seed the new sources, then `bw backfill --months 12 --budget 8.00`. Expect roughly 500 captures and **$4–6**. Slice it (`--limit 50`) and eyeball the first batch before completing, as M3 did.
- [ ] `bw export`, eyeball the board's small-multiple grid at desktop and 375px, then `bw export --publish`.
- [ ] Homelab: `git pull && docker compose up -d --build`, and **watch the first nightly run at 50 sources** — collection is now ~50 polite fetches, so confirm it completes inside the window and the healthcheck stays green. Check disk: the archive will grow materially.

## Deferred

- A headless-browser path for client-rendered pricing (Vercel, Jira). It would roughly double the addressable pool but adds a browser to the container and a new failure class. The boundary is more valuable stated than erased.
- Re-screening on a cadence to catch a site that becomes server-rendered (or stops being). `candidates.screened_at` exists for it.
- `qualify`-proposed replacement canaries for degraded sources (spec §15.6) — the proposal exists per-candidate now; wiring it into the degraded-source alert is a small follow-up.
