# Bellwether — Design Spec

- **Date:** 2026-08-18
- **Status:** Approved, pending implementation plan
- **Author:** Nicholas Comeaux
- **Working directory:** `~/VsCode/Competitor Watcher/` (rename to `bellwether/` deferred — paths are load-bearing per `~/VsCode/ROUTER.md`)

## 1. Positioning

**Bellwether is the open archive of developer-infrastructure pricing, and the engine that
maintains it.**

The pitch, in one line each:

- **For the operator:** see every pricing change in your market, confirmed and explained, for
  under a dollar a month — against $15,000+/year for enterprise CI.
- **For the public:** the pricing history of developer infrastructure — free, citable, and
  recorded daily.

The boundary is deliberate. "Some SaaS companies I picked" is not a dataset anyone cites;
"every developer-infrastructure and tooling company's pricing, monthly" is. Coherence makes a
dataset linkable, and a stated boundary makes it defensible. Scope: hosting, databases, auth,
email, observability, CI, API tooling, search, payments infrastructure, and adjacent developer
services. Target 40-60 companies (section 11.1).

This is a positioning claim, not a feature claim, and it was chosen after surveying the market
(section 2). Every comparable product is a closed subscription producing a private dashboard.
None publishes its dataset. That is the empty slot, and occupying it serves all three goals at
once: an open dataset gets linked and cited where a private dashboard gets screenshotted; the
engine is the defensible part while the data is the distribution; and none of it costs extra,
because the archive is being stored regardless.

Goals in priority order:

1. **Portfolio artifact.** A public URL and dataset a stranger can evaluate in sixty seconds,
   backed by a readable repo. This wins when goals conflict.
2. **Working system.** Runs unattended on the homelab and stays alive without nursing.
3. **Business seed.** The same engine, pointed at a private config, watches a real competitive
   set. Multi-tenancy remains out of scope.

## 2. Competitive landscape

Surveyed 2026-08-18. The space is crowded; the honest differentiation is narrow and specific.

| Tier | Products | Price | What they do |
|---|---|---|---|
| Enterprise CI | Klue, Crayon, Kompyte | $15k–$100k/yr | Battlecards, sales enablement, human analysts |
| General change monitors | Visualping (~2M users), changedetection.io (OSS) | $0–78/mo | Watch any page, alert on diff |
| SaaS-pricing-specific | SaaS Price Pulse, Tierly, PageCrawl, Apify actors | ~$10–50/mo | Extract plans and prices, chart history |
| Archive tooling | Apify Wayback actors | pay-per-run | CDX timeline plus regex price extraction |

### 2.1 What is NOT differentiated

Recording these explicitly so they are never claimed in the README or on the site.

- **AI noise filtering.** changedetection.io ships plain-English intent rules and AI change
  summaries, free and self-hosted. Visualping claims its AI suppresses 83% of detected changes.
- **Structured pricing extraction.** This is the entire tier-3 category.
- **Wayback backfill.** An existing Apify actor pulls the CDX timeline and extracts prices by regex.

### 2.2 What is differentiated

1. **You own the archive.** Every comparable product is a subscription; the history dies when
   payment stops. Bellwether's archive is a SQLite file holding raw HTML. Because extraction is
   content-addressed, the prompt can be improved and the full history reprocessed under a better
   schema — impossible on a platform that owns the pipeline and rents you the output.
2. **Schema-first, not diff-first.** Tier-2 tools produce a text diff and ask a model whether it
   matters. Bellwether never produces a text diff; it produces a typed object and compares
   objects. The output type is a queryable time series, not a stream of alerts.
3. **The dataset is public, and the moat is elapsed time.** No competitor publishes theirs —
   but "nobody does this yet" is an empty slot, not a defense; anyone could copy the idea next
   month. What cannot be copied is the record itself. Wayback gives every latecomer the same
   monthly-resolution past; from the day Bellwether goes live it accumulates **daily-resolution,
   confirmed, grounded observations that exist nowhere else**. A copycat starting later has a
   permanent hole where this archive's coverage is, and every day widens the gap. Features don't
   compound; archives do. The claim is not "I publish data" — it is "I started recording first."

The time moat only matters if the dataset is found and cited, so it is paired with a
**distribution layer** (14.4): per-competitor pages titled to own their search queries, an RSS
feed of confirmed changes, `llms.txt` and clean JSON endpoints so AI assistants cite Bellwether
when answering pricing questions, and a zero-effort citation block. All static files generated at
export; the flywheel is search traffic -> citations -> age -> authority.

For the portfolio goal, note that novelty matters less than engineering judgment — nobody
evaluating the work will care that Visualping exists. The positioning matters for goal 3.

## 3. Non-goals

- Multi-tenant SaaS, signup, billing, per-customer configuration
- Any authenticated, paywalled, or robots-disallowed source
- Republishing scraped page content — only extracted facts and original analysis are published
- Real-time or intraday detection; daily is the finest cadence
- JavaScript-rendered pages (no headless browser in scope)

## 4. Definition of done

Setup — prerequisites, quickstart, and the `doctor` first-run check — is section 22.

Each milestone in section 18 ends deployable. The project is complete when:

1. A public URL shows six competitors' current pricing side by side.
2. A timeline shows real historical price changes seeded from the Internet Archive.
3. Confirmed material changes carry a written implication generated by Claude.
4. The dataset is downloadable as CSV and JSON under an explicit license.
5. The site displays its own per-source health and its own cumulative LLM cost.
6. `docker compose up` on the Ubuntu box runs the pipeline on a schedule unattended.
7. The README carries an architecture diagram, the filter table, and a measured cost figure.
8. A stranger with the six prerequisites can go from clone to green `doctor` in under an hour
   using section 22 alone.
9. The distribution layer is live: competitor pages carry search-titled metadata, the RSS feed
   validates, `llms.txt` resolves.

## 5. Architecture

Two halves in one repo, communicating through git.

```
HOMELAB (Docker, private)                          VERCEL (public, static)
+-------------------------------------+            +----------------------+
|  node-cron                          |            |  Next.js             |
|   +- collect   (daily, jittered)    |            |  output: 'export'    |
|   +- extract                        |            |                      |
|   +- detect                         |            |  reads at build time |
|   +- export    (writes JSON, pushes)|            |   web/public/data/   |
|   +- synthesize (Mon 06:00 CT)      |  git push  |     board.json       |
|                                     |----------->|     timeline.json    |
|  backfill (one-shot CLI, queued)    |  triggers  |     changes.json     |
|                                     |  rebuild   |     status.json      |
|  bellwether.db <- raw HTML, private,|            |     dataset.json/.csv|
|                   never published   |            |                      |
+-------------------------------------+            +----------------------+
```

**The raw HTML archive never leaves the homelab.** Only extracted facts and original analysis
cross the boundary. This keeps the public repo small, keeps the legal posture clean (publishing
observations, not republishing pages), and makes the committed JSON diff a readable changelog
of the market.

### 5.1 Layer discipline

Adapted from the `soltreya-ops` Tools / Agents / Workflows pattern. The shape is reused; the code
is not — Bellwether is standalone and must not depend on private business code.

| Layer | Contents | LLM | Failure mode |
|---|---|---|---|
| **Tools** | fetch, normalize, slice, hash, diff, materiality, token guard, export, wayback | Never | Typed error, loud |
| **Agents** | `extract_pricing`, `annotate_and_synthesize` — two, total | One schema-constrained call each | Zod rejection, retry, then degrade |
| **Workflow** | The pipeline steps | Never | Step skipped; next run retries |

**Governing principle: the LLM never decides control flow. It only fills in a schema.** Every
branch, threshold, retry, and skip is deterministic code. Neither agent is an agentic loop; both
are single-shot calls with a structured output format. Roughly 70% of the code lives in `tools/`
and contains zero nondeterminism.

### 5.2 The database is the queue

Every step is independently invocable and idempotent. No step holds in-memory state from
another; each queries SQLite for outstanding work.

```
bellwether collect      # any active source past its cadence -> fetch, write snapshot
bellwether extract      # any snapshot lacking an extraction at current prompt_version
bellwether detect       # any consecutive extraction pair lacking a change row; run confirmation
bellwether export       # rebuild all JSON and dataset files from current DB state
bellwether synthesize   # weekly: annotate confirmed changes AND write the digest, one call
bellwether backfill     # one-shot: enqueue Wayback captures, then drain the queue
bellwether qualify      # screen candidate URLs for server-rendered pricing (see 11.2)
```

Daily cron runs `collect extract detect export`. Weekly cron adds `synthesize export`. A step
that dies mid-run leaves a backlog the next run clears with no special handling. Every command
supports `--limit N` and `--dry-run`.

### 5.3 Production stack coverage

Audit of the full production stack, layer by layer. The strongest engineering claim here is not
the layers implemented but the layers **deliberately eliminated** — a static architecture deletes
whole categories of production risk instead of managing them.

| Layer | How Bellwether handles it |
|---|---|
| Frontend | Next.js static export; UI spec in 14.3 |
| APIs & backend logic | The pipeline (5.2); public "API" is stable static JSON endpoints (14.4) — versioned, cacheable, unbreakable |
| Database & storage | SQLite WAL, content-addressed raw storage (7.2), migrations tracked (`schema_migrations`) |
| Auth & permissions | **Eliminated.** The public site is static with zero auth surface; the homelab is reachable only via Tailscale; the sole credential in production is a single-repo deploy key |
| Hosting & deployment | Vercel (public) + Docker Compose on the homelab (private) |
| Cloud & compute | **Eliminated.** No cloud compute bill, no cold starts; Vercel serves bytes |
| CI/CD & version control | Git is the transport *and* the deploy trigger; **GitHub Actions** runs tests + full pipeline with `LLM_ENABLED=false` on every PR; Vercel builds on push to `main` |
| Security & data access | Secrets only in `.env` (gitignored, doctor-validated); raw archive never leaves the box; **no inbound ports on the homelab — outbound-only**; robots.txt honored |
| Rate limiting | Outbound: 10s/host + jitter, Wayback 1/4s (11, 12.1). Inbound: **eliminated** — Vercel's CDN absorbs any load a static site can receive |
| Caching & CDN | Vercel CDN for the site; internally, the three zero-cost cache gates (9) are the cost model |
| Load balancing & scaling | **Eliminated** for serving (CDN scales alone). Pipeline scaling is the 50→100 competitor path (16), bounded by config not architecture |
| Observability & logs | `runs` table → `status.json` → public health display; per-call cost ledger; compose healthcheck on runs freshness; Telegram alerts (15.3) |
| Availability & recovery | Backup + tested restore (7.3); export guards (15.7); heartbeat (15.3). **The public site cannot go down when the homelab does — it goes stale**, and `status.json`'s last-updated timestamp makes staleness visible rather than silent |

That last property is the availability story in one line: decoupling collection from serving
means the failure mode of the entire homelab is "the data is a day old," not "the site is down."

## 6. Repository layout

```
src/
  tools/       fetch.ts  normalize.ts  slice.ts  hash.ts  diff.ts  materiality.ts
               token_guard.ts  export.ts  wayback.ts  qualify.ts
  agents/      extract_pricing.ts  annotate_and_synthesize.ts  _client.ts
  workflow/    collect.ts  extract.ts  detect.ts  export.ts  synthesize.ts  backfill.ts
  ops/         migrate.ts  health.ts  cost.ts
  config/      competitors.public.ts   (committed)
               competitors.private.ts  (gitignored)
  schema/      pricing.ts  change.ts  synthesis.ts
  cli.ts
migrations/    001_init.sql  ...
web/           Next.js App Router, output: 'export', Tailwind
               public/data/*.json, dataset.csv  (generated, committed)
docker-compose.yml   # ONE service
```

Stack: Node 24 LTS, TypeScript, pnpm, `better-sqlite3` (WAL mode — readers never block the
single writer, so `export` can read while `collect` writes), Zod, Next.js App Router with
Tailwind. Tests: **Vitest**. The Docker Compose service defines a **healthcheck that queries
`runs` freshness** — "has any step succeeded in 26 hours" — so Portainer shows real pipeline
health, not merely that the container process exists.

Frontend decisions, fixed:

- **Domain: `bellwether.cmxlogic.com`.** Free, tied to your existing identity, and a stable
  citation URL from day one. All 14.4 metadata, JSON-LD, and citation blocks use it. If the
  project outgrows the subdomain, a dedicated domain with permanent redirects is a later,
  reversible call.
- **Charts: hand-rolled SVG in React.** The change ribbon is a custom primitive no library
  ships; step-after interpolation and gap rendering are a few hundred lines of owned SVG. Zero
  chart dependencies. Palette still passes the dataviz validator (14.3).
- **Components: hand-rolled Tailwind.** The ledger direction is deliberately custom and the site
  has roughly six interactive controls. No component library; keyboard focus and ARIA handled
  directly, held to the 14.3 quality floor.
One Zod schema serves three roles — the structured-output format sent to Claude, the runtime
validator, and the dashboard's type.

## 7. Data model

```sql
CREATE TABLE competitors (
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  homepage TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY, competitor_id INTEGER NOT NULL REFERENCES competitors(id),
  kind TEXT NOT NULL,                 -- 'pricing' now; 'jobs' | 'changelog' later
  url TEXT NOT NULL, canary_string TEXT NOT NULL,
  cadence_hours INTEGER NOT NULL DEFAULT 24,
  active INTEGER NOT NULL DEFAULT 1, degraded_reason TEXT);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id),
  observed_at TEXT NOT NULL,          -- CAPTURE time, not fetch time (see 12)
  fetched_at TEXT NOT NULL,
  ok INTEGER NOT NULL, http_status INTEGER, error TEXT,
  raw_content TEXT,                   -- NULL when raw_hash already stored (see 7.2)
  raw_hash TEXT, normalized_hash TEXT,
  provenance TEXT NOT NULL);          -- 'live' | 'wayback:20250314120000'
CREATE INDEX idx_snap_source_time ON snapshots(source_id, observed_at);
CREATE INDEX idx_snap_raw_hash ON snapshots(source_id, raw_hash);

CREATE TABLE extractions (
  id INTEGER PRIMARY KEY, normalized_hash TEXT NOT NULL, source_kind TEXT NOT NULL,
  data_json TEXT NOT NULL, extraction_confidence TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',      -- non-USD excluded from diffing (12.4)
  grounded INTEGER NOT NULL DEFAULT 1,       -- all prices found in source text (12.6)
  is_backfill INTEGER NOT NULL DEFAULT 0,    -- excluded from the recurring ceiling (15.2)
  model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, cost_micros INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (normalized_hash, prompt_version));

CREATE TABLE changes (
  id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id),
  from_snapshot_id INTEGER NOT NULL, to_snapshot_id INTEGER NOT NULL,
  change_type TEXT NOT NULL, json_path TEXT NOT NULL,
  before_json TEXT, after_json TEXT,
  materiality INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'candidate',   -- candidate | confirmed | disputed | retracted
  observed_at TEXT NOT NULL,
  UNIQUE (source_id, from_snapshot_id, to_snapshot_id, json_path));

-- Written by the weekly synthesize step, not by a separate analysis agent (see 14.1).
CREATE TABLE analyses (
  id INTEGER PRIMARY KEY, change_id INTEGER NOT NULL REFERENCES changes(id),
  implication TEXT NOT NULL, so_what TEXT NOT NULL, confidence TEXT NOT NULL,
  model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (change_id, prompt_version));

CREATE TABLE digests (
  id INTEGER PRIMARY KEY, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  body_md TEXT NOT NULL, item_count INTEGER NOT NULL,
  model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  cost_micros INTEGER, created_at TEXT NOT NULL,   -- cost of the whole merged call
  UNIQUE (period_start, prompt_version));

CREATE TABLE backfill_queue (
  id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id),
  wayback_ts TEXT NOT NULL, target_url TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',     -- pending | fetched | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL,
  UNIQUE (source_id, wayback_ts));

CREATE TABLE runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT,
  state TEXT NOT NULL DEFAULT 'running',     -- running | ok | failed | crashed
  ok INTEGER, stats_json TEXT, error TEXT);
CREATE INDEX idx_runs_kind_state ON runs(kind, state, started_at);

CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL);
```

### 7.1 Why `extractions` is separate

Keyed on `(normalized_hash, prompt_version)`, this table earns its place three ways:

1. **Extraction happens once per unique page state, ever.** Backfill and live collection share
   the cache. Identical captures cost nothing after the first.
2. **Reprocessing history under a better prompt is one command.** Bump `EXTRACT_PROMPT_VERSION`,
   run `bellwether extract --all`; old rows survive for comparison. This is differentiator 2.2.1.
3. **Cost is attributable per row.** Summing `cost_micros` across `extractions` and `digests`
   produces the figure shown on the public About page.

Nothing is discarded. Sub-threshold changes still get a `changes` row; they never reach an LLM.

### 7.2 Content-addressed raw storage

`raw_content` is written **only when `raw_hash` is new for that source.** When the hash repeats,
the snapshot row is still written — it is the proof the source was checked that day — but
`raw_content` is left NULL and the bytes are recovered by joining to the earliest snapshot
sharing that `(source_id, raw_hash)`.

This matters entirely at scale. At 50 competitors averaging 800 KB per page, storing every daily
snapshot would write roughly **14.6 GB/year** of near-identical HTML. With dedup, the same watch
list costs about **240 MB/year** — a sixty-fold reduction from one conditional. The archive is
the compounding asset, so it has to stay cheap to keep forever.

### 7.3 Durability

The archive is described throughout as the compounding asset and the primary differentiator. It
therefore cannot live on exactly one disk with no copy.

- **Nightly:** `VACUUM INTO` a dated snapshot, then push to **Backblaze B2** with `restic`
  (native B2 support; bucket and app key in `.env`). Retain 7 daily, 4 weekly, 12 monthly. At
  ~240 MB/year the storage bill rounds to zero.
- **Restore is tested, not assumed.** `bellwether ops verify-backup` downloads the most recent
  archive, opens it, and asserts row counts within tolerance of live. Run monthly by cron; a
  failure raises the same alarm as a dead collector.
- **The derived layer is already redundant** — `dataset.json`, `dataset.csv`, and every JSON
  export live in public git history, so even total loss of the box leaves the published dataset
  and its full version history intact. Only raw HTML would be lost, and only back to the last
  backup.

Storage cost at 50 competitors is roughly 240 MB/year, so retention is effectively free.

## 8. Schemas

```ts
// Two version constants. Each is stored on the rows it produces, so any generated artifact
// traces to the exact prompt behind it and can be reprocessed independently.
export const EXTRACT_PROMPT_VERSION = 'extract-pricing-v1';
export const SYNTH_PROMPT_VERSION   = 'annotate-synthesize-v1';

const Tier = z.object({
  name: z.string(),
  monthly_price_usd: z.number().nullable(),   // null = "contact sales"
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
  usage_rates: z.array(z.object({
    metric: z.string(), unit_price_usd: z.number(),
  })).max(12),
  notes: z.string().nullable(),
  extraction_confidence: z.enum(['high', 'medium', 'low']),
});

// One weekly call returns BOTH the per-change annotations and the digest.
export const WeeklySynthesis = z.object({
  annotations: z.array(z.object({
    change_id: z.number(),
    implication: z.string(),
    so_what: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
  })),
  digest_md: z.string(),
  top_five_change_ids: z.array(z.number()).max(5),
});
```

`usage_rates` exists because Supabase and Sentry price on consumption; without it the two most
interesting competitors extract to almost nothing. `extraction_confidence` is the extractor
self-reporting and gates change confirmation (section 12).

## 9. The layered filter

| # | Gate | Mechanism | Cost | Removes |
|---|---|---|---|---|
| 1 | Raw hash | matches previous snapshot -> stop | $0 | ~80% of runs |
| 2 | Normalized hash | strip, slice, re-hash, compare -> stop | $0 | most of the remainder |
| 3 | Extraction cache | `(normalized_hash, prompt_version)` exists -> reuse | $0 | repeat page states |
| 4 | Structured extract | Haiku 4.5 + Zod, retry once on validation failure | ~$0.009 | — |
| 5 | Object diff | deep-diff two `PricingSnapshot` objects | $0 | copy tweaks entirely |
| 6 | Materiality | deterministic score vs. threshold | $0 | feature-list churn |
| 7 | Confirmation | change must be observed twice (section 12) | $0 | extractor phantoms |
| 8 | Annotate + digest | Sonnet 5, one merged call per week | ~$0.05 | — |

**Collection frequency does not drive cost.** The hash gate means 365 daily fetches producing
three real changes cost the same as three fetches. Daily collection is therefore kept: it is
free, and it makes two-observation confirmation resolve in a day.

### 9.1 Normalization and slicing

Strip `<script>`, `<style>`, `<svg>`, HTML comments, all `data-*` attributes, `nonce`,
`integrity`, any attribute value matching a UUID or `[a-f0-9]{16,}`, asset query strings, and
elements matching known cookie-banner and chat-widget class patterns.

**Then always slice** — select the DOM subtree with the highest density of currency symbols and
tier-like headings, and discard the rest. This is applied on every extraction, not only as an
over-budget fallback, because it roughly halves per-extraction cost. Collapse whitespace,
extract text, re-hash.

Golden-file tested: fixture HTML in, expected sliced text and stable hash out.

### 9.2 Token guard

Before every LLM call, in code:

```
normalize -> slice -> count_tokens -> over budget?
  -> widen the slice once and retry the count
    -> still over? mark source degraded, skip, log. Never send an oversized request.
```

Budget: **20,000 input tokens** (hard cap). Sliced pricing pages are expected near 6,000, which
is the figure the cost model uses. Uses the `count_tokens` endpoint, so the check is real rather
than estimated. Figma's raw page is 2.3 MB and is the reason this exists.

## 10. Materiality

A pure function over two `PricingSnapshot` objects. No LLM.

| Change | Score |
|---|---|
| Tier added or removed | 100 |
| `monthly_price_usd` changed | 80 + min(20, abs(delta %)) |
| `billing_unit` changed | 70 |
| `is_enterprise` or `is_free` flipped | 60 |
| `included_seats` changed | 50 |
| A `usage_rates` entry changed | 45 |
| Tier renamed (identity preserved, 12.3) | 35 |
| `headline_features` changed | 10 |
| `notes` changed | 5 |

**Threshold: 40.** Feature-list churn scores 10 because it is copy churn the large majority of
the time. It is still recorded and visible under a "minor changes" toggle; if a month of real
data proves the weighting wrong, it is one number to tune.

## 11. Collection and politeness

Deliberately conservative, because the day this is a business is the day it matters.

- Identifying User-Agent carrying a contact URL
- `robots.txt` fetched, cached 24h, and honored
- Minimum 10s between requests to the same host; jittered start times
- 3 retries with exponential backoff
- **A failed fetch writes `ok=0` with no `raw_content` and never overwrites the last good snapshot**
- Redirect cap 5; body cap 5 MB; public pages only
- Canary string asserted post-fetch; failure marks the source degraded and skips extraction
  rather than feeding garbage downstream

### 11.1 Watch list

Verified 2026-08-18 as server-rendered with prices and tier names present in raw HTML:

| Competitor | URL | Raw size |
|---|---|---|
| Linear | `https://linear.app/pricing` | 783 KB |
| Notion | `https://www.notion.com/pricing` | 430 KB |
| Figma | `https://www.figma.com/pricing/` | 2.3 MB |
| Supabase | `https://supabase.com/pricing` | 371 KB |
| Sentry | `https://sentry.io/pricing/` | 1.1 MB |
| Postman | `https://www.postman.com/pricing/` | 997 KB |

Excluded after verification: **Vercel** (24 KB shell, pricing hydrated client-side) and
**Jira/Atlassian** (fully client-rendered, no prices in HTML). Both would need a headless browser.

These six are the M1-M3 working set. The full target watch list is 40-60 developer-infrastructure
companies, admitted by qualification (11.2) at M3.5.

Candidate pool to screen — hosting (Netlify, Railway, Render, Fly.io, Heroku), databases (Neon,
PlanetScale, Turso, Upstash, MongoDB Atlas, Redis Cloud, Convex, Xata), auth (Clerk, Auth0,
WorkOS, Stytch), email (Resend, Postmark, SendGrid, Loops), observability (Datadog, New Relic,
Honeycomb, Grafana Cloud, Better Stack, PostHog), CI and build (CircleCI, Buildkite, Depot,
GitHub, GitLab), edge and CDN (Cloudflare, Fastly, Bunny), search (Algolia, Meilisearch,
Typesense), vector stores (Pinecone, Weaviate, Qdrant), payments infrastructure (Stripe, Paddle,
Lemon Squeezy), feature flags (LaunchDarkly, Statsig), secrets (Doppler, Infisical), and data
tooling (Prisma, Hasura). Vercel is a known qualification failure and is a useful test case.

### 11.2 Qualification

`bellwether qualify <url...>` screens candidates without human judgment: fetch once, count
currency symbols and tier-like headings present in the **raw** HTML, and emit a verdict plus a
proposed `canary_string` drawn from the most stable-looking tier heading. Pass means the page is
server-rendered and extractable; fail means it hydrates client-side and is out of scope.

This exists because human qualification is the real cost of expansion — roughly two minutes per
company, which is two hours at fifty and a wasted day at two hundred. Automating it converts that
cost into code written once.

The screening results are themselves publishable: "screened N companies; M publish
server-rendered pricing" is a finding no competitor reports, and it belongs on the `/data` page.

## 12. Backfill and change confirmation

### 12.1 Backfill

A one-shot CLI command backed by `backfill_queue`, claiming one row at a time. It **never blocks
the main pipeline** — the rest of the system reads whatever has landed. Four of six competitors
with history is a working timeline. Docker Compose runs one service; backfill does not need its own.

- Discovery: Wayback CDX API per URL, `collapse=timestamp:6` (one capture per month),
  `filter=statuscode:200`, 18-month window
- Fetch: `https://web.archive.org/web/<ts>id_/<url>` — the `id_` suffix returns original bytes
  without the injected Archive toolbar
- Rate limit: 1 request per 4s; Wayback is slow and will return 429
- **Extraction of the backfill corpus runs through the Message Batches API at 50% cost.** It is
  not latency-sensitive, so there is no reason to pay the synchronous rate.
- **Backfill carries its own explicit one-time budget** (`bellwether backfill --budget 10.00`),
  tracked separately from the recurring monthly ceiling. Backfilling 50-100 competitors costs
  $4-8 in a single month and would otherwise trip a $5 recurring cap that is correct for steady
  state. Bulk historical work is a deliberate, acknowledged expense; recurring spend stays capped.
- Tail competitors added at M3.5 backfill at **12 months** rather than 18, cutting one-time cost
  by a third. The original six keep the full 18-month window.
- Restartable any number of times; resumes from `state='pending'`
- **Batch cost is estimated before submission, not after.** A Batches job of 3,600 extractions
  cannot be budget-checked mid-flight, so `backfill` counts pending rows, multiplies by the
  measured mean cost per extraction, and refuses to submit a job that would exceed `--budget`.
  Actual usage is reconciled into `extractions` when results are retrieved, and a variance beyond
  20% is logged as a warning to recalibrate the estimate.

**`snapshots.observed_at` is the capture time, not the fetch time.** Getting this wrong puts
eighteen months of history on today's date.

### 12.2 Detection semantics

Under-specifying this is the single most likely source of silently wrong data, because three
things interleave: failed fetches, deduplicated snapshots, and backfilled history arriving after
live collection has already run.

**Pairing rule.** `detect` walks each source's snapshots ordered by `observed_at`, considering
**only rows with `ok=1` and a non-null `normalized_hash`**, and pairs each *distinct* consecutive
`normalized_hash`. Failed fetches are skipped entirely — they are gaps in observation, never
evidence of change. Repeated hashes collapse: five days of an unchanged page is one state, not
five. A change row's `from`/`to` snapshot ids always name the **first** snapshot exhibiting each
hash, so the recorded `observed_at` is the earliest moment the new state was seen.

**Backfill invalidates prior detection, and this must be handled explicitly.** Live collection
creates changes between adjacent live snapshots. Backfill then inserts snapshots whose
`observed_at` falls *before* them, so pairs that were adjacent no longer are. Any change row
spanning a newly-inserted snapshot is now wrong.

Therefore: **`bellwether detect --rebuild <source>` deletes and re-derives every change row for
the affected sources, and backfill invokes it automatically on completion.** Re-derivation is
free because extractions are content-addressed and cached — no LLM call is repeated. Annotations
in `analyses` are re-linked by `(source_id, json_path, observed_at)` where the change survives
rebuild, and orphaned annotations are deleted.

This makes detection a pure function of the snapshot set, which is the property that keeps the
dataset trustworthy after any historical import.

### 12.3 Tier identity across renames

The timeline is the flagship view, and naive name-keyed tier matching breaks it. If Linear renames
"Pro" to "Professional", name-keyed matching emits *tier removed* plus *tier added* — materiality
200, two spurious entries, and a broken price series exactly where continuity matters most.

Tiers are matched between two snapshots in this order:

1. **Exact name match.**
2. **Normalized name match** — case-folded, punctuation stripped, common suffixes ("Plan", "Tier")
   removed.
3. **Positional and price proximity** — same ordinal position in the tier list AND
   `monthly_price_usd` within 15% or both null. Emits `tier_renamed` (materiality 35, below
   threshold — a rename is not a pricing event) and **preserves series continuity**.
4. Otherwise: genuinely added or removed.

`tier_renamed` carries both names so the timeline can label the transition without breaking the line.

### 12.4 Currency and geography

Pricing pages commonly vary by geo-IP, and Wayback captures were taken from arbitrary locations.
Without a rule, a EUR-served capture reads as a systemic price change across every tier.

**Only `currency == 'USD'` extractions participate in diffing.** A snapshot extracting to any
other currency is recorded, marked `currency_mismatch`, and excluded from change detection — it is
a collection anomaly, not a pricing event. If a source produces three consecutive mismatches, it
is marked degraded and raises the heartbeat, because that means the collector's apparent location
has changed.

### 12.5 Confirmation

> A candidate change is not published until its new value is observed a second time.

- **Live path:** today's change is confirmed by tomorrow's collection.
- **Backfill path:** a change between captures N and N+1 is confirmed if the value persists into N+2.

One rule, one implementation, both paths. A real price change stays changed; an extraction
hallucination almost never reproduces. This eliminates the phantom-change class of bugs at zero
marginal cost, and the one-day lag is invisible in a weekly digest.

A change where either side reports `extraction_confidence: 'low'` never leaves `candidate`.
Only `state='confirmed'` changes reach synthesis or the public change feed.

**The consecutive-change gap.** Persistence alone produces a false negative when a price moves in
two consecutive observations (A -> B -> C): B appears once, so a real change is suppressed. With
monthly Wayback captures this is not rare. Such changes therefore land in **`disputed`** rather
than being dropped, and are resolved by a single re-extraction of both snapshots. Agreement
promotes to `confirmed`; disagreement retracts. Volume is a few per month, so the cost is cents
and the entire false-negative class disappears.

State machine: `candidate -> confirmed | disputed | retracted`, and `disputed -> confirmed | retracted`.

### 12.6 Extraction grounding

`extraction_confidence` is self-reported, and a model confident enough to hallucinate a price is
confident enough to report `high`. It is a useful signal, not a validator.

**Every numeric price in an extraction must be findable in the sliced input text.** After Zod
validation and before the row is written, assert that each `monthly_price_usd`,
`annual_price_usd`, and `usage_rates[].unit_price_usd` appears as a numeral in the source the
model was given. A price the model produced but the page never contained is fabricated by
construction — detectable deterministically, at zero cost, with no judgment involved.

Failure retries once with the grounding violation named in the prompt, then marks the source
degraded rather than writing an ungrounded row. This is the strongest single guarantee of data
quality in the system, and it is pure code.

## 13. Analysis

**One synthesis call**, `claude-sonnet-5`, structured output per `WeeklySynthesis`.

**Cadence is adaptive, not fixed weekly.** Six competitors change price roughly four times a year
each — about one confirmed change every two weeks. A fixed weekly digest would therefore be empty
most weeks, which is both a wasted call and a bad artifact: "this week, nothing happened" trains
the reader to stop looking. Synthesis fires when **at least three confirmed changes are pending,
or thirty days have elapsed since the last digest, whichever comes first**, evaluated Mondays at
06:00 CT. At the M3.5 watch list of 50 companies the three-change trigger will fire roughly
weekly on its own, so the same rule produces a monthly cadence early and a weekly one later
without any change in code.

Input: the week's confirmed material changes plus the prior four digests' bodies. Output: an
annotation for every confirmed change, the digest body, and a ranked top five. The prompt asks
explicitly for cross-time patterns, which is the only thing a single-change call cannot produce.
**Hard cap of five items** in the digest; the model ranks and cuts.

This replaces a separate per-change analysis agent. Merging removes an agent, a pipeline step, a
prompt version, and a table write path. The trade-off is that change-feed entries are unannotated
until the Monday run — acceptable given the confirmation lag already present, and the feed shows
the raw structured before/after in the meantime, which is legible on its own.

`model` and `prompt_version` are stored on every generated row.

## 14. Delivery

### 14.1 Export

`bellwether export` rebuilds `web/public/data/` from current DB state, commits, and pushes.
Vercel rebuilds on push. Files: `board.json`, `timeline.json`, `changes.json`, `status.json`,
`dataset.json`, `dataset.csv`.

The site serves at **`bellwether.cmxlogic.com`** (CNAME to Vercel).
Mechanics: the repo is **public on GitHub** and connected to a Vercel project rooted at `web/`.
The homelab container holds a **deploy key with write access** and pushes to `main`.
`competitors.private.ts`, `.env`, and `bellwether.db` are gitignored — the public repo never
receives the raw archive or the private watch list. Export commits use a fixed message format
(`data: <n> changes, <n> sources, <date>`) so `git log` reads as a market changelog. If a push
conflicts, export aborts and retries next run; it never force-pushes.

### 14.2 Dashboard views

1. **Board** — all six competitors, current tiers side by side. Renders correctly with one
   snapshot and zero history, so it is never empty.
2. **Timeline** — price over time per competitor with change markers. What backfill buys.
3. **Change feed** — reverse-chronological confirmed material changes with annotations,
   filterable by competitor; sub-threshold changes collapsed under a "minor" toggle.
4. **Competitor pages** — a stable URL per competitor (`/c/linear`) showing that company's full
   pricing history. These are the citable, linkable units of the dataset.
5. **How it works** — architecture diagram, the filter table with live hit rates, per-source
   health (last verified, canary status), and cumulative LLM spend pulled from the DB.

View 5 is the portfolio. A dashboard that publishes its own failure state and running cost is
both the most persuasive detail for a technical reader and the strongest forcing function
against silent decay.

### 14.3 UI design

Not deferred. "Looks good" is a specification, and left to implementation it reverts to a
template.

**Direction — the ledger.** The subject is an archive of prices, not a marketing dashboard and
not an analytics product. Its nearest real-world artifact is a ledger: a dated, append-only
record where every line is evidence and the reader's question is always "what changed, when, and
how do you know." Everything follows from that — tabular numerals throughout, rules that mark
observation boundaries rather than decorate, and the before/after diff as the one repeated
primitive. Deliberately avoided: cream-and-serif-with-terracotta, near-black-with-acid-accent,
and broadsheet hairline pastiche. Those are defaults, not choices.

**Signature — the change ribbon.** One horizontal, time-scaled band per competitor. Every
observation is a tick; every confirmed change is a notch labelled `$16 → $18`; every gap in
observation is a visible gap. It renders at three scales and carries three jobs at once — the
timeline, the change feed, and source health:

```
Linear    ├─┬────────────┬──────────────┬──────────┤   ● live
             $8→$10       $10→$14        $14→$16
          2025-03      2025-09        2026-02      2026-08
```

- **Row scale** on the board: 18 months compressed into a table cell.
- **Hero scale** on a competitor page: full width, crosshair, tooltips.
- **Small multiple** on the index at 50 companies: sparkline density, no axes.

One primitive at three scales is what makes fifty companies legible on a single screen.

**Typography.**

| Role | Face | Why |
|---|---|---|
| Display | Bricolage Grotesque (variable) | Editorial-technical with real character; not a default choice |
| Body | Public Sans | Holds up at small sizes in dense tables; less defaulted than Inter |
| Data | IBM Plex Mono, `font-variant-numeric: tabular-nums` | Prices must align in columns |

Tabular numerals everywhere, including inline in body copy. In a price archive, digits that do
not line up are a defect.

**Color — three systems that never mix.**

1. **Diverging pair — price direction.** The semantically correct use of a diverging scale:
   increase and decrease around a neutral midpoint. This is the emotional core of the dataset and
   earns the strongest color in the system.
2. **Categorical, four hues — tier identity.** Free / Entry / Mid / Enterprise, assigned in fixed
   ordinal order, never cycled.
3. **Status, three — source health.** ok / degraded / failed. Reserved, never reused as a fourth
   series, and always shipped with an icon and a label so state is never color-alone.

**Color encodes tier, never competitor.** At fifty companies a categorical scale is impossible —
the eighth hue is already a stretch and the ninth is a bug. Competitors are separated by small
multiples and position, never by hue. This is a hard rule, and it is why the ribbon exists.

The implementation **must run `scripts/validate_palette.js`** from the `dataviz` skill against
both the light and dark surfaces before any color ships; adjacent-pair CVD separation is computed,
not judged. Dark mode is a selected set of steps validated against the dark surface, not an
inversion of the light one.

**Charts.**

- **Step-after interpolation, never smooth lines.** Prices are piecewise constant. A line sloping
  from $16 to $18 between two monthly observations asserts a continuous change that did not
  happen. This is a correctness rule, not a stylistic one, and it is the most common way a
  pricing chart lies.
- **Observation gaps render as gaps.** Where Wayback has no capture, the series breaks. Never
  bridge missing data.
- **One axis. Never dual-axis.** Two measures at different scales become two charts or an indexed
  common base.
- **Crosshair and tooltip** on every ribbon and chart; hit targets larger than the marks.
- **Legend present at two or more series; direct labels at four or fewer.**
- **A table view exists for every chart** — trivially satisfied, since the dataset page is one.

**Copy.** Active voice, sentence case, named from the reader's side. Empty and failure states
carry direction rather than mood:

- Not "No data" but "No confirmed changes since 12 August. Last checked 3 hours ago."
- Not "Error loading" but "Sentry's pricing page changed structure on 4 August. Collection is
  paused until the parser is updated."

Errors never apologise and are never vague about what happened. An empty state is an invitation
to look at something else specific.

**Quality floor**, met without announcing it: responsive to mobile, visible keyboard focus,
`prefers-reduced-motion` respected, semantic `<table>` for tabular data, and every chart readable
at 200% zoom.

### 14.4 Distribution

The mechanics that make the dataset found and cited (the flywheel claimed in 2.2). All are
static files generated by `export`; none adds a running service or a meaningful cost.

- **Per-competitor pages own their queries.** `/c/linear` is titled "Linear pricing history —
  every change since 2025" with matching meta description and JSON-LD `Dataset` markup. "<company>
  pricing history" is a real query with no good answer today; fifty companies is fifty queries
  where Bellwether is the best page on the internet.
- **RSS/Atom feed** of confirmed changes at `/changes.xml` — the subscribe channel for readers
  who will never bookmark a dashboard. Entry title is the change ("Linear Business $16 → $18"),
  body is the annotation.
- **`llms.txt` and stable JSON endpoints.** AI assistants answering "what does Neon cost?" cite
  sources that are structured and fetchable. `/llms.txt` describes the dataset and points to
  `/data/*.json`; every competitor page links its own JSON. Being the source AI answers cite is
  the compounding channel.
- **Citation block and badge.** A copy-paste citation (plain, BibTeX) on every competitor page
  and `/data`, plus a small "pricing data: Bellwether" badge snippet. Citing must be effortless,
  and every citation is a backlink.

### 14.5 The dataset

The differentiating artifact. A `/data` page providing:

- **`dataset.csv`** — one row per (competitor, tier, observed_at) with price, billing unit,
  seats, and flags. The flat form anyone can open in a spreadsheet.
- **`dataset.json`** — the same data nested, plus the change log with annotations.
- **A documented schema** — field names, types, null semantics (`monthly_price_usd: null` means
  "contact sales", not "free").
- **Stated methodology** — sources, cadence, extraction method, the confirmation rule, the
  qualification criterion and its pass rate, and known limitations, so the data is defensible.
- **A stated boundary** — which companies are in scope and why, and which were screened out for
  client-side rendering. Naming the exclusions is what makes the inclusions credible.
- **Stated resolution limits** — backfilled history is monthly, so a change is dated to within a
  month, and two changes inside one month appear as one. Live observations are daily. Both are
  labelled per row via `provenance`, so a reader can tell reconstructed history from observed
  history. A dataset that overstates its own precision is worse than one with gaps.
- **License: CC BY 4.0**, with a copy-paste citation block.

Both files are regenerated by `bellwether export` and committed, so the dataset is versioned in
git and every historical state is retrievable.

## 15. Reliability rails

1. **Kill switch.** `LLM_ENABLED=false` runs the whole pipeline with extraction and synthesis
   skipped, so collection, detection, export, and the site build are testable at zero cost.
   CI runs in this mode.
2. **Hard cost ceiling: $5/month on recurring spend.** Before any LLM call, sum `cost_micros`
   for the current month across `extractions` and `digests`, excluding rows tagged as backfill.
   Over the cap: refuse, log, continue. That is roughly 8x the projected steady-state spend at a
   50-company watch list. Bulk backfill runs under its own explicit `--budget` flag (12.1) so a
   one-time historical load can never silently consume the recurring allowance, and the recurring
   allowance can never silently block a deliberate backfill. Runaway spend is structurally
   impossible rather than a promise to watch.
3. **Outcome-based heartbeat.** One query: any active source with no successful snapshot in 48h?
   If yes, alert. It asserts on the outcome rather than the mechanism, so it catches blocked
   collectors, dead cron, a full disk, and bugs not yet imagined. **Channel: Telegram bot** — the
   pattern already exists in `soltreya-ops` (`src/trigger/telegram-agent.ts`), setup is a bot
   token and chat ID in `.env`, and delivery is one HTTP call with no mail infrastructure. The
   same channel carries backup failures, degraded-source notices with proposed replacement
   canaries, and the monthly restore-verification result. Silence means healthy; the heartbeat
   also posts one weekly "all green" message so that a dead alerting channel is itself detectable.
4. **Every run writes a `runs` row**, feeding `status.json` and the public health display.
5. **Single-writer lock.** A step refuses to start if a `runs` row of the same kind is `running`
   and started under 6 hours ago; older ones are marked crashed and cleared. Cron overlap on a
   slow backfill would otherwise put two writers on one SQLite file.
6. **Degraded is a state with a defined exit.** Canary failure sets `degraded_reason` and skips
   extraction. The next successful fetch whose canary passes clears it automatically. After three
   consecutive failures the heartbeat emails the source, the failing canary, and a replacement
   proposed by `qualify` — so a redesign produces a one-line config fix rather than a mystery.
7. **Export refuses to publish an empty or collapsed dataset.** Before committing, export asserts
   the generated JSON parses, `board.json` contains at least as many competitors as the previous
   published version, and no file shrank by more than 50%. A migration bug or an empty query must
   never blank the public site — the published artifact is the deliverable, and overwriting it
   with nothing is the one unrecoverable failure in the system.

## 16. Cost model

Rates as of 2026-08-18: `claude-haiku-4-5` at $1.00/$5.00 per MTok; `claude-sonnet-5` at
$3.00/$15.00, discounted to $2.00/$10.00 through 2026-08-31. Message Batches runs at 50%.

| Call | Model | Est. each | Frequency |
|---|---|---|---|
| Extract pricing (sliced, ~6k in) | Haiku 4.5 | ~$0.009 | Only on normalized-hash change |
| Extract, backfill (batched) | Haiku 4.5 | ~$0.005 | One-time |
| Annotate + digest | Sonnet 5 | ~$0.05 | Adaptive: 3 changes pending or 30 days (13) |
| Disputed re-extraction | Haiku 4.5 | ~$0.018 | A few per month |
| Grounding retry | Haiku 4.5 | ~$0.009 | Rare; bounded at one retry |

**Cost scales with changes, not with competitors watched.** A page that never changes is free
forever after its first extraction, so widening the watch list is close to free.

| Watch list | One-time backfill | Steady state |
|---|---|---|
| 6 (M1-M3) | ~$0.55 | ~$0.20/mo |
| **50 (M3.5 target)** | **~$4.05** | **~$0.65/mo** |
| 100 | ~$8.10 | ~$1.10/mo |

Fifty companies runs at roughly 13% of the recurring ceiling. Money is not the constraint on
dataset size; qualification effort and disk are, and both are addressed in 11.2 and 7.2.

These are estimates. The About page shows the measured figure.

## 17. Testing

- **Golden-file tests** for normalization and slicing — fixture HTML to expected output and hash.
- **TDD on `diff`, `materiality`, `tier identity` (12.3), and `detection pairing` (12.2)** — all
  pure functions over plain objects, table-driven. Pairing in particular gets explicit cases for
  failed fetches, repeated hashes, and out-of-order backfill insertion, because that is where
  silently wrong data comes from.
- **Grounding assertion tested against a known fabrication** — feed an extraction containing a
  price absent from the source and assert it is rejected. This test protects the strongest data
  quality guarantee in the system, so it must fail loudly if the check regresses.
- **Rebuild idempotence** — run `detect`, insert backfill, run `detect --rebuild`, and assert the
  change set equals what a from-scratch derivation produces. Detection is specified as a pure
  function of the snapshot set; this is the test that holds it to that.
- **Extraction eval set** — ten real pricing pages from the backfill corpus with hand-written
  expected tiers, run on demand, reporting per-field accuracy. This is what allows a claim about
  extraction quality rather than a vibe.
- CI runs the full pipeline with `LLM_ENABLED=false` against fixtures.

## 18. Milestones

No fixed deadline. Each milestone ends in a deployable state, so work can stop at any boundary
and still leave something real. Estimates assume focused hours.

| # | Milestone | Est. | End state |
|---|---|---|---|
| **M1** | **Skeleton that ships** — repo, migrations, config, polite fetcher, `collect`, hash gate, `runs`, minimal `export`, Next.js board view, **deployed to Vercel** | ~4h | Public URL showing six competitors' raw pricing pages' fetch status and last-seen data |
| **M2** | **Extraction and detection** — normalize, slice, token guard, `extract_pricing`, grounding check, tier identity, diff, materiality, confirmation | ~5h | Board shows real structured tiers; `changes` accumulates and confirms |
| **M3** | **History** — `backfill_queue`, Wayback CDX and fetch, batched extraction with pre-submission budget check, `detect --rebuild`, timeline view | ~4h | Eighteen months of real price history charted |
| **M3.5** | **Qualify and expand** — `qualify` tool, screen the candidate pool, admit passers, backfill the tail at 12 months | ~2h | Watch list at 40-60 companies; the dataset has a defensible boundary |
| **M4** | **Narrative, dataset, distribution** — `annotate_and_synthesize`, change feed, competitor pages with search-titled metadata and JSON-LD, `/data` page with CSV/JSON and license, RSS feed, `llms.txt`, citation block | ~4h | The differentiating artifact exists, is citable, and can be found |
| **M5** | **Hardening** — cron, Telegram heartbeat, canaries, run lock, cost ceiling, export guards, B2 backup and tested restore, `doctor`, compose healthcheck, eval set, README | ~3h | Runs unattended, survives disk loss, and a stranger could set it up from section 22 |

**Deploy at M1, not at the end.** The static export plus git transport is the piece most likely
to surprise; finding that out in hour three is cheap and in hour fifteen is not.

Cron once M5 lands: `collect extract detect export` daily at 07:00 CT with ±30m jitter;
`synthesize export` Monday 06:00 CT. Timezone `America/Chicago` throughout.

## 19. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | Wayback slow, rate-limited, or thin for some URLs | `backfill_queue` state machine, one-shot and restartable, nothing blocks on it, partial coverage acceptable |
| 2 | Figma will not fit the token budget | Always-slice plus token guard with one widen-retry, then degrade and skip; never send an oversized request |
| 3 | Extraction drift creating phantom changes | Two-observation confirmation, plus low-confidence suppression |
| 4 | A site blocks the collector | `ok=0` never overwrites good data; canary assertion; degraded state shown publicly; 48h heartbeat |
| 5 | Runaway LLM spend | Hard $5/month ceiling enforced before every call |
| 6 | The dataset is thin enough to be uninteresting | M3.5 expands to 40-60 via automated qualification. Cost scales with changes not competitors (~$0.65/mo at 50); dedup (7.2) keeps disk at ~240 MB/yr; a stated boundary makes the set citable |
| 7 | Bulk backfill trips the recurring cost ceiling | Backfill runs under a separate explicit `--budget`; recurring and one-time spend tracked apart (15.2); batch cost estimated pre-submission (12.1) |
| 8 | Homelab disk failure destroys the archive | Nightly `VACUUM INTO` + off-box `restic`; monthly tested restore; derived layer already redundant in public git (7.3) |
| 9 | Backfill silently invalidates already-derived changes | Detection is a pure function of the snapshot set; `detect --rebuild` runs automatically after backfill, free because extractions are cached (12.2) |
| 10 | A tier rename reads as remove-plus-add and breaks the timeline | Four-stage tier identity matching emits `tier_renamed` and preserves series continuity (12.3) |
| 11 | Geo-served non-USD page reads as a systemic price change | Only USD extractions are diffed; three consecutive mismatches mark the source degraded (12.4) |
| 12 | Model fabricates a price that was never on the page | Deterministic grounding assertion — every numeral in the output must exist in the input; retry once, then degrade (12.6) |
| 13 | Export publishes an empty dataset and blanks the public site | Pre-commit assertions on parse, competitor count, and file-size regression (15.7) |
| 14 | Cron overlap puts two writers on one SQLite file | Single-writer lock via `runs.state`; stale locks cleared after 6h (15.5) |

## 20. Deferred

- Email digest (Resend) — the Telegram channel carries the digest text in the meantime, so
  "deferred" costs nothing: `synthesize` already posts the digest body to Telegram at zero
  marginal effort
- Job-posting collector (ATS JSON) and changelog/feed collector
- Private Tailscale render target using `competitors.private.ts`
- `bellwether reprocess --all` for prompt-version migrations
- Headless-browser collection for JS-rendered pages such as Vercel and Jira

## 21. Business bridge

Once this exists, `soltreya-ops/workflows/competitor_analysis.md` has an engine behind it: the
private config points the same pipeline at a real competitive set. That costs one config file and
no new code, and it is the cheapest available test of whether this is a product.

## 22. Setup

The system must be settable-up by one person in under an hour, from this section alone.

### 22.1 Prerequisites

| Need | Source | Used for |
|---|---|---|
| Anthropic API key | console.anthropic.com | Extraction and synthesis |
| GitHub repo (public) + deploy key with write access | github.com | Publishing derived data |
| Vercel account, project rooted at `web/` | vercel.com (existing, per soltreya-web) | The public site |
| Telegram bot token + chat ID | @BotFather (pattern exists in soltreya-ops) | Heartbeat alerts |
| Backblaze B2 bucket + app key | backblaze.com | Off-site archive backup via restic |
| Docker + Compose on the Ubuntu box | existing | Runtime |

Every one of these lands in `.env`; `.env.example` documents each variable with the exact place
to get it.

### 22.2 Quickstart

```
git clone <repo> && cd bellwether
cp .env.example .env        # fill in the six values above
docker compose run app doctor
docker compose up -d
```

### 22.3 `bellwether doctor`

The first-run experience is: run `doctor` until it is green, then `up`. Doctor checks, in order:

1. Every required `.env` variable present and non-placeholder
2. DB path writable; WAL mode enabled; migrations current
3. Anthropic key valid — verified with a `count_tokens` call, which costs nothing
4. Git remote reachable and the deploy key can push (dry-run)
5. Each configured source URL reachable and its canary string present
6. Telegram bot can send (posts a test message)
7. B2 bucket reachable and restic repo initialized

Every failure prints **what to fix and where**, never a stack trace. Doctor is also the answer to
"is it still healthy" at any later date, and CI runs checks 1–2 against fixtures.
