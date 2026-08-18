# Bellwether

The open archive of developer-infrastructure pricing.

Bellwether checks a set of public pricing pages daily, stores a deduplicated
raw archive of what it finds, and publishes a free, citable board of verified
source state. Structured change detection and analysis are coming in M2 and
beyond — see Status. It runs on a homelab for well under a dollar a month —
against published entry pricing of roughly $15,000/year for enterprise
competitive-intelligence platforms.

**Intended address:** bellwether.cmxlogic.com (not deployed yet — see Status)

## How it works

    collect -> extract -> detect -> export        (daily)
                              \-> synthesize      (adaptive)

The raw HTML archive never leaves the homelab. Only extracted facts and
original analysis are published, committed to git so every historical state of
the dataset is retrievable.

Cost is controlled by a layered filter that spends nothing until something
actually changed. This is the cost model the pipeline is designed to hit once
extraction and synthesis exist; in M1 only collection runs, no LLM calls
happen yet, and actual spend today is $0 — the figures below are the target,
not a measurement:

| Gate | Cost | Removes |
|---|---|---|
| Raw hash | $0 | ~80% of runs |
| Normalized hash | $0 | most of the remainder |
| Extraction cache | $0 | repeat page states |
| Structured extract | ~$0.009 | — |
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

## Status

M1 complete: the pipeline collects pricing pages on cadence, stores them, and
exports a JSON dataset; the board renders it. Publishing is git-based and
guarded — see `src/workflow/export.ts` — but no GitHub remote or hosting is
connected yet, so the board is not live at the intended address above.

M2 next: structured extraction and change detection.

## Data licence

The published dataset is CC BY 4.0. A `/data` page with the full schema,
methodology, and citation block is planned for M4 and does not exist yet.
