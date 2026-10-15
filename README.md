# Bellwether

![CI](https://github.com/Ncomeaux3/bellwether/actions/workflows/ci.yml/badge.svg)

The open archive of developer-infrastructure pricing.

Bellwether checks a set of public pricing pages daily, stores a deduplicated
raw archive of what it finds, extracts structured pricing with Claude, detects
confirmed changes, and publishes a free, citable board of verified source
state. See Status for what has run.

**Live:** https://bellwether-nicholas-projects-cdfeb046.vercel.app

## How it works

    collect -> extract -> detect -> export        (daily)
                              \-> synthesize      (adaptive)

The raw HTML archive never leaves the homelab. Only extracted facts and
original analysis are published, committed to git so every historical state of
the dataset is retrievable.

Cost is controlled by a layered filter that spends nothing until something
actually changed. The figures below are a design target. They have never been
measured:

| Gate | Cost | Removes |
|---|---|---|
| Raw hash | $0 | ~80% of runs |
| Normalized hash | $0 | most of the remainder |
| Extraction cache | $0 | repeat page states |
| Structured extract | ~$0.009 | n/a |
| Object diff | $0 | copy tweaks entirely |
| Materiality score | $0 | feature-list churn |
| Two-observation confirmation | $0 | extractor phantoms |

Collection frequency does not drive cost: 365 daily fetches producing three
real changes cost the same as three fetches.

## Setup

See `docs/superpowers/specs/2026-08-18-bellwether-design.md` section 22, or:

    cp .env.example .env     # fill in the documented values
    docker compose run --rm bellwether doctor
    docker compose up -d

`doctor` checks every prerequisite and tells you what to fix. Run it until it
is green.

`docker compose up -d` runs the full daily pipeline once on every start:
`migrate`, `seed`, `collect`, `export`. Then it idles until the container is
restarted. That is safe to repeat: `collect`'s cadence gate skips any source
already fetched within its `cadence_hours` window, so a restart loop cannot
re-fetch the watched sites (see `src/workflow/collect.ts`). Host-side cron scripts exist in `ops/`, but
nothing is scheduled now, so a restart is what re-runs the pipeline.

## Publishing

`bellwether export --publish` commits and pushes `web/public/data` so the
board rebuilds. Run it **on the host**, not inside the container. The
container has no git remote and no deploy key, so `--publish` there will
always fail at the push step. `bellwether export` without `--publish` is safe
to run anywhere; it only rewrites the local JSON files.

## Status

Merged milestones per git log: M1 (collection, storage, guarded publishing,
board), M2 (extraction, diffing, confirmed change detection), M3 (Wayback
backfill and price timeline), M4 (synthesis and distribution), M5 (unattended
operation), M6 (portfolio surface), and part of M3.5 (the `qualify` command and
the 27-source watch list).

The pipeline ran collect, Claude extraction (`src/agents/extract_pricing.ts`),
two-observation change detection, and a Claude-written weekly digest
(`src/agents/synthesize_weekly.ts`) across 27 sources. The board is live at the
URL above, with a `/data` page and per-source pages under `web/app`.

The last data run was 2026-08-21 (`web/public/data/status.json`). Nothing is
running on a schedule now, so the board is a snapshot of that date.

## Data licence

The published dataset is CC BY 4.0. The `/data` page has the schema and
citation block.
