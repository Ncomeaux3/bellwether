#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$HOME/bellwether}"
cd "$REPO"

BRANCH="$(git symbolic-ref --short -q HEAD || true)"
if [ "$BRANCH" != "main" ]; then
  echo "publish: refusing — on branch '${BRANCH:-detached HEAD}', expected main"
  exit 1
fi

SRC="$REPO/data/export"

if ! find "$SRC" -maxdepth 1 -name board.json -size +1c -mmin -1560 2>/dev/null | grep -q .; then
  echo "publish: refusing — $SRC/board.json missing, empty, or older than 26h"
  exit 1
fi

SOURCES=$(grep -o '"total_sources": *[0-9]*' "$SRC/status.json" 2>/dev/null | grep -o '[0-9]*$' || true)
if [ -z "$SOURCES" ]; then
  echo "publish: refusing — cannot read total_sources from $SRC/status.json"
  exit 1
fi
CHANGES=$(grep -c '"change_type"' "$SRC/changes.json" 2>/dev/null || true)
CHANGES="${CHANGES:-0}"

# Everything under web/public is regenerated from $SRC below, so a dirty tree
# left by a crashed run is noise — discarding it turns a permanent wedge
# (pull --ff-only refuses forever) into a self-heal.
git restore --worktree --staged web/public 2>/dev/null || true

if ! git pull --ff-only; then
  echo "publish: git pull --ff-only failed — resolve manually, next run retries"
  exit 1
fi

# The filename set below is static and copied wholesale — if a future export
# stops producing one of the nine files, its last published copy is never
# removed. Changing the set is a code change, not a data change.
for f in board.json status.json changes.json timeline.json digest.json dataset.json dataset.csv; do
  if [ -s "$SRC/$f" ]; then cp "$SRC/$f" web/public/data/; fi
done
for f in changes.xml llms.txt; do
  if [ -s "$SRC/$f" ]; then cp "$SRC/$f" web/public/; fi
done

if [ -z "$(git status --porcelain web/public)" ]; then
  echo "publish: nothing to publish"
  exit 0
fi

git add web/public
git commit -m "data: ${CHANGES} changes, ${SOURCES} sources, $(date +%F)"

if ! git push; then
  echo "publish: git push failed — next run retries"
  exit 1
fi
echo "publish: pushed ${CHANGES} changes, ${SOURCES} sources on $(date +%F)"
