#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$HOME/bellwether}"
cd "$REPO"
SRC="$REPO/data/export"

if ! find "$SRC" -maxdepth 1 -name board.json -mmin -1560 | grep -q .; then
  echo "publish: refusing — $SRC/board.json missing or older than 26h"
  exit 1
fi

if ! git pull --ff-only; then
  echo "publish: git pull --ff-only failed — resolve manually, next run retries"
  exit 1
fi

for f in board.json status.json changes.json timeline.json digest.json dataset.json dataset.csv; do
  if [ -f "$SRC/$f" ]; then cp "$SRC/$f" web/public/data/; fi
done
for f in changes.xml llms.txt; do
  if [ -f "$SRC/$f" ]; then cp "$SRC/$f" web/public/; fi
done

if [ -z "$(git status --porcelain web/public)" ]; then
  echo "publish: nothing to publish"
  exit 0
fi

SOURCES=$(grep -o '"total_sources": *[0-9]*' "$SRC/status.json" | grep -o '[0-9]*$')
CHANGES=$(grep -c '"change_type"' "$SRC/changes.json" 2>/dev/null || true)
CHANGES="${CHANGES:-0}"
git add web/public
git commit -m "data: ${CHANGES} changes, ${SOURCES} sources, $(date +%F)"

if ! git push; then
  echo "publish: git push failed — next run retries"
  exit 1
fi
echo "publish: pushed ${CHANGES} changes, ${SOURCES} sources on $(date +%F)"
