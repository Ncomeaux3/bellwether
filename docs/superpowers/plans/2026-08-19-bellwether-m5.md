# Bellwether M5 — Unattended Operation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bellwether runs itself: the homelab collects, synthesizes, publishes, backs up, and raises alarms with no human in the loop. The Mac becomes a development machine.

**Architecture:** The canonical archive migrates to the box (post-execution step). A new `pipeline` command chains the whole daily sequence — collect → extract → detect → synthesize → export → heartbeat — so the host cron is one line, fixing the existing bug where the box's cron ran only `collect && export` and never extracted. Publishing runs **on the host, not in the container**: the container writes guarded JSON to `/data/export`; a small host script copies it into the repo, commits with the fixed message, and pushes with a dedicated deploy key. Alerts are one Telegram HTTP call. Backup is nightly `VACUUM INTO` (container) + `restic` to Backblaze B2 (host), with a monthly restore verification that raises the same alarm as a dead collector.

**Tech Stack:** unchanged, plus two host-side shell scripts and restic on the box. No new npm dependencies — Telegram is a bare `fetch`.

**Spec:** `docs/superpowers/specs/2026-08-18-bellwether-design.md` §7.3 (durability), §14.1 (publish mechanics), §15 (reliability rails), §22 (accounts).

## Global Constraints

- **The LLM never decides control flow.** M5 adds zero LLM calls.
- **Secrets live in `.env` only** (gitignored, doctor-validated). New keys: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (container), `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY` (host). **Every alerting/backup feature is a silent no-op when its keys are unset** — dev machines and CI run without credentials and without errors.
- **The deploy key lives on the HOST, never in the container** (deviation from spec §14.1's "container holds a deploy key", ruled below).
- Alerts are outcome-based (spec §15.3): assert on "no successful snapshot in 48h", not on mechanisms. Silence means healthy; one weekly "all green" makes a dead channel detectable.
- Publish never force-pushes; a conflict aborts and retries next run (spec §14.1).
- Every run writes a `runs` row (spec §15.4) — including `export`, closing the M4-parked gap.
- No test makes a network request: Telegram gets an injected `fetch`; backup tests use temp dirs; nothing touches real credentials.
- Shell scripts: `set -euo pipefail`, shellcheck-clean by inspection, small enough to read in one screen.
- TypeScript strict + `noUncheckedIndexedAccess`; `.js` imports; run locks via `acquireRun`/`finishRun`; conventional commits.

## Rulings made before execution

**R1 — The deploy key lives on the host, not in the container.** Spec §14.1 says "the homelab container holds a deploy key with write access." The container fetches and parses adversarial third-party HTML nightly; the host does not. Putting the sole write-capable credential in the process with the largest attack surface is backwards. The container writes guarded artifacts to the bind mount; the host script (which handles the key) only copies files and runs git. Strictly better than the spec on its own §5.3 security posture. *Cost if wrong:* one extra moving part (a host script) outside the container's test surface — mitigated by keeping it under 40 lines and doctor-checking its preconditions.

**R2 — The box becomes the canonical archive via one-time migration.** The Mac's DB holds the backfill and the first digest; the box's shadow DB holds neither. Publishing from the box without migrating would silently unpublish 18 months of history. Post-execution: stop the container, copy `bellwether.db` from Mac to box, restart, verify counts match. The Mac's copy becomes a dev database. *Cost if wrong:* recoverable — the Mac copy is untouched, and B2 backup (this milestone) makes the box's copy durable within a day.

**R3 — Heartbeat runs inside `pipeline`, not as a separate cron entry.** One more cron line is one more thing that dies silently. The heartbeat query is read-only and cheap; it runs after export in the daily sequence, so a dead cron kills the heartbeat too — which the weekly "all green" message then exposes by its absence (spec §15.3's dead-channel detection).

**R4 — `pipeline` replaces the cron's command list and `start`'s body.** The existing box cron ran `collect && export`, silently skipping extract/detect/synthesize daily — an operational bug shipped in M2. One `bw pipeline` command owns the sequence; `start` becomes `pipeline` + idle; the cron becomes one exec. Steps that fail must not abort the sequence where later steps are safe: each step gets the same try/log/continue treatment `start` gave synthesize in M4, EXCEPT collect→extract ordering (nothing to extract if collect died is fine — extract still runs over the backlog).

## File Structure

| File | Responsibility |
|---|---|
| `src/workflow/pipeline.ts` (create) | `runPipeline(db, deps)`: the daily sequence with per-step isolation and a stats summary. |
| `src/tools/telegram.ts` (create) | `sendTelegram(text, deps)`: one POST to api.telegram.org; silent no-op without env; never throws. |
| `src/ops/heartbeat.ts` (create) | Outcome queries: stale sources (48h), 3+-consecutive degraded, weekly all-green; composes messages; calls telegram. |
| `src/workflow/export.ts` (modify) | `exportData` acquires/writes a `runs` row (kind `export`). |
| `src/cli.ts` (modify) | `bw pipeline`, `bw ops heartbeat`, `bw ops backup`, `bw ops verify-backup`; `start` delegates to pipeline. |
| `src/ops/backup.ts` (create) | `VACUUM INTO` a dated snapshot in `/data/backup/`, prune >7 local; `verifyBackup(path)` row-count tolerance check. |
| `ops/publish.sh` (create) | Host: copy `/data/export` artifacts into the repo, commit fixed message, push; abort on conflict. |
| `ops/backup.sh` (create) | Host: restic backup of the latest snapshot to B2, retention 7/4/12; forget+prune. |
| `.github/workflows/ci.yml` (create) | Tests + typecheck + `LLM_ENABLED=false` pipeline + web build on push/PR. |
| `docs/homelab.md` (modify) | The new crontab (pipeline, publish, backup, monthly verify), key setup, credential checklist. |
| `docker-compose.yml` (modify) | Pass the Telegram env vars through. |
| Tests | `tests/pipeline.test.ts`, `tests/telegram.test.ts`, `tests/heartbeat.test.ts`, `tests/backup.test.ts` (create); `tests/export.test.ts` (runs-row). |

---

### Task 1: `pipeline` + export runs-row

**Interfaces produced:** `runPipeline(db, opts?: { skipCollect?: boolean }, deps?): Promise<PipelineStats>` where `PipelineStats = { steps: { name: string; ok: boolean; summary: string }[] }`; `exportData` unchanged signature but now writes a `runs` row.

- Sequence: collect → extract → detect → synthesize → export → heartbeat (heartbeat stub-injected until Task 3; call it via `deps.heartbeat?`). Each step in try/catch: a failure records `{ ok: false, summary: err.message }` and CONTINUES (ruling R4); the pipeline itself never throws. Every step already writes its own `runs` row; export gains one: wrap `exportData`'s body in `acquireRun(db, 'export')`/`finishRun` — on guard trips `finishRun(..., false, ...)` then rethrow (callers depend on the throw; `runPipeline` catches it).
- `start` in `cli.ts` becomes: migrate, seed, `runPipeline`, print step table, idle. `bw pipeline` runs it once and exits non-zero if any step failed (cron visibility).
- Tests: a step that throws doesn't stop later steps; export failure recorded in `runs` (kind `export`, state `failed`); all-green pipeline returns every step ok; `exportData` success writes an ok export run. Update any `tests/export.test.ts` case that counts runs rows.
- Commit: `feat(pipeline): one daily sequence with per-step isolation; export writes a runs row`.

### Task 2: Telegram + heartbeat

**`src/tools/telegram.ts`:** `sendTelegram(text: string, deps?: { env?, fetchImpl? }): Promise<{ sent: boolean; detail: string }>` — POST `https://api.telegram.org/bot<token>/sendMessage` with `{ chat_id, text, disable_web_page_preview: true }`. Unset env → `{ sent: false, detail: 'telegram not configured' }` with no call. Network/API errors are caught and returned, never thrown — an alert failure must not break the pipeline it reports on. 4096-char truncation.

**`src/ops/heartbeat.ts`:** `runHeartbeat(db, deps?): Promise<HeartbeatStats>`:
- **Stale sources** (spec §15.3): active sources with no `ok=1` snapshot in 48h → one message listing them.
- **Degraded**: sources where `degraded_reason IS NOT NULL` → included with reasons.
- **Publish/backup watchdog**: latest `runs` row per kind in (`export`,`backup`) with `state='failed'` and `ended_at` in the last 25h → alert.
- **Weekly all-green** (spec §15.3): when today is Monday in CT (reuse the `Intl` weekday pattern from `synthesize.ts`) and nothing above fired → send "all green: N sources healthy, last publish <date>, spend this month $X".
- Injected `now` and `fetchImpl` throughout; tests cover each trigger, the all-green Monday, silence on a healthy Tuesday, and unset-env no-op. Wire as `deps.heartbeat` into `runPipeline` and as `bw ops heartbeat`.
- Commit: `feat(ops): telegram alerts and the outcome-based heartbeat`.

### Task 3: publish from the box

**`ops/publish.sh`** (host, ~35 lines): `set -euo pipefail`; cd repo root (arg 1, default `~/bellwether`); preconditions: `/data/export/board.json` exists and is <26h old (else exit 1 with message — the heartbeat's export watchdog covers alerting); `git pull --ff-only` (abort on conflict per spec — no rebase, no force); copy `data/export/{board,status,changes,timeline,digest,dataset}.json` + `dataset.csv` → `web/public/data/`, `data/export/{changes.xml,llms.txt}` → `web/public/`; if `git status --porcelain web/public` is empty, exit 0 ("nothing to publish"); else `git add web/public`, commit `data: <changes> changes, <sources> sources, <date>` (parse the two counts from `status.json` with `python3 -c` or `node -e` — the box has node via docker only, so use `sed`/`grep` on the JSON, keep it dumb), push. On push failure exit 1 without retry (next cron retries).
- **Wait — the container's exportData writes changes.xml/llms.txt to `/data` (siteDir = outDir/..), not `/data/export`.** Fix properly in `src/cli.ts`/compose instead of special-casing the script: add `BELLWETHER_SITE_EXPORT_DIR` env consumed by the export CLI path (`deps.siteDir`), set it to `/data/export` in compose so ALL nine artifacts land in one directory. Update the M4 test expectation if any pinned the default.
- Deploy key: `docs/homelab.md` gains the exact steps — `ssh-keygen -t ed25519 -f ~/.ssh/bellwether_deploy -N ""`, `~/.ssh/config` host alias `github.com-bellwether` with `IdentityFile`, repo remote rewritten to `git@github.com-bellwether:Ncomeaux3/bellwether.git`, pub key added as a GitHub deploy key with write access (via `gh repo deploy-key add` from the Mac, or the web UI). The controller performs this post-execution.
- Crontab (documented in `docs/homelab.md`): `0 7 * * *  cd ~/bellwether && docker compose exec -T bellwether pnpm bw pipeline >> cron.log 2>&1 && ./ops/publish.sh >> cron.log 2>&1`.
- Tests: shell is untestable in vitest — instead `bw doctor` gains checks: site-export dir configured, publish script executable. Keep the script logic minimal enough to review by eye.
- Commit: `feat(publish): host-side publish script and single export directory`.

### Task 4: backup + verify

**`src/ops/backup.ts`:** `backupSnapshot(db, dir, deps?): { path: string; bytes: number; pruned: string[] }` — `VACUUM INTO '<dir>/bellwether-<YYYYMMDD>.db'` (idempotent per day: if today's exists, replace via tmp+rename), prune local snapshots beyond 7 newest. `verifyBackup(livePath, snapshotPath)` opens both readonly, compares `snapshots`/`extractions`/`changes` counts — snapshot within 2% or 200 rows of live → ok. CLI: `bw ops backup` (writes `runs` kind `backup`), `bw ops verify-backup [--file <path>]` (defaults to newest local snapshot; verifying the B2 copy happens host-side by restoring to a temp dir first — documented). Failures send a Telegram alert (injected).
**`ops/backup.sh`** (host, ~25 lines): sources `.env` for restic/B2 vars (exit 0 silently if unset); `restic backup data/backup/<newest>` ; `restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune`. Crontab: nightly after publish; monthly verify line: restore newest to a tmpdir, run `docker compose exec -T bellwether pnpm bw ops verify-backup --file /data/restore-check.db` (restore into the bind mount), alert on failure via the command's own exit + heartbeat watchdog.
- Tests: backup creates the dated file and prunes to 7; same-day re-run replaces atomically; verify passes on a fresh copy and fails on a truncated one; unset-env script path documented not tested.
- Commit: `feat(backup): nightly VACUUM INTO with restic push and tested restore`.

### Task 5: CI

`.github/workflows/ci.yml`: on push/PR to main — Node 24, corepack pnpm install, `pnpm vitest run`, `pnpm typecheck`, then the credential-free pipeline steps run INDIVIDUALLY against a temp `BELLWETHER_DB`: `bw migrate`, `bw seed`, `bw extract --dry-run`, `bw detect`, `bw export`. Deliberately NOT `bw pipeline`: collect makes real network fetches, and CI must be deterministic with zero network — per-step invocation proves the sequence runs credential-free without importing that flakiness. Finish with `cd web && pnpm build`.
- Commit: `ci: tests, typecheck, credential-free pipeline steps, web build`.

## Post-execution (controller)

- [ ] Deploy key: generate on box, add to GitHub with write access, rewrite the box remote, `ssh -T` verify.
- [ ] **Archive migration (R2):** stop container, back up box DB aside, `scp` Mac `data/bellwether.db` → box `data/`, start container, verify counts (snapshots/extractions/changes/digests) match Mac, run `bw pipeline` on box, then `ops/publish.sh` by hand once — confirm the site updates from the box.
- [ ] Install the new crontab lines; remove the old `collect && export` entry.
- [ ] Credentials checklist for the user: Telegram bot token + chat id (BotFather); B2 bucket + app key; install restic on the box (`apt install restic`). Wire into box `.env`; verify with `bw ops heartbeat` (test message) and a first `ops/backup.sh` run.
- [ ] Watch the next 07:00 CT run end-to-end; confirm site freshness moves without the Mac.

## Deferred

- Degraded-source replacement-canary proposals (spec §15.6's `qualify` integration) — M3.5.
- The digest email channel — Telegram covers alerting; email distribution is a distribution feature, not reliability.
- Container image hardening (non-root user, read-only fs) — worth doing at 50 competitors.
