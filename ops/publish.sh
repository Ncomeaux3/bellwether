#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$HOME/bellwether}"
cd "$REPO"

# Host-side legs run outside the container and are otherwise invisible to
# the heartbeat watchdog — this makes every outcome (success AND failure)
# visible as a `runs` row it can check. The `|| true` matters: if the
# container is down, this call itself fails, and that must not turn a
# publish failure (or success!) into a script crash — the 48h stale-source
# check below already covers a dead container on its own.
record() {  # $1 = ok|failed, $2 = detail
  docker compose exec -T bellwether pnpm bw ops record --kind publish --state "$1" --detail "$2" >/dev/null 2>&1 || true
}

BRANCH="$(git symbolic-ref --short -q HEAD || true)"
if [ "$BRANCH" != "main" ]; then
  MSG="publish: refusing — on branch '${BRANCH:-detached HEAD}', expected main"
  echo "$MSG"
  record failed "$MSG"
  exit 1
fi

SRC="$REPO/data/export"

if ! find "$SRC" -maxdepth 1 -name board.json -size +1c -mmin -1560 2>/dev/null | grep -q .; then
  MSG="publish: refusing — $SRC/board.json missing, empty, or older than 26h"
  echo "$MSG"
  record failed "$MSG"
  exit 1
fi

SOURCES=$(grep -o '"total_sources": *[0-9]*' "$SRC/status.json" 2>/dev/null | grep -o '[0-9]*$' || true)
if [ -z "$SOURCES" ]; then
  MSG="publish: refusing — cannot read total_sources from $SRC/status.json"
  echo "$MSG"
  record failed "$MSG"
  exit 1
fi
CHANGES=$(grep -c '"change_type"' "$SRC/changes.json" 2>/dev/null || true)
CHANGES="${CHANGES:-0}"

# Everything under web/public is regenerated from $SRC below, so a dirty tree
# left by a crashed run is noise — discarding it turns a permanent wedge
# (pull --ff-only refuses forever) into a self-heal.
git restore --worktree --staged web/public 2>/dev/null || true

if ! git pull --ff-only; then
  MSG="publish: git pull --ff-only failed — resolve manually, next run retries"
  echo "$MSG"
  record failed "$MSG"
  exit 1
fi

# The filename set below is static and copied wholesale — if a future export
# stops producing one of the files, its last published copy is never
# removed. Changing the set is a code change, not a data change.
for f in board.json status.json changes.json timeline.json digest.json dataset.json mechanics.json dataset.csv; do
  if [ -s "$SRC/$f" ]; then cp "$SRC/$f" web/public/data/; fi
done
for f in changes.xml llms.txt; do
  if [ -s "$SRC/$f" ]; then cp "$SRC/$f" web/public/; fi
done
mkdir -p web/public/data/competitors
for f in "$SRC"/competitors/*.json; do
  if [ -s "$f" ]; then cp "$f" web/public/data/competitors/; fi
done

if [ -z "$(git status --porcelain web/public)" ]; then
  # A site correctly unchanged is a SUCCESS, not silence — recording anything
  # less would make a healthy no-op publisher look dead to the watchdog.
  echo "publish: nothing to publish"
  record ok "nothing to publish"
  exit 0
fi

git add web/public
git commit -m "data: ${CHANGES} changes, ${SOURCES} sources, $(date +%F)"

if ! git push; then
  MSG="publish: git push failed — next run retries"
  echo "$MSG"
  record failed "$MSG"
  exit 1
fi

DETAIL="pushed ${CHANGES} changes, ${SOURCES} sources"
echo "publish: ${DETAIL} on $(date +%F)"
record ok "$DETAIL"
