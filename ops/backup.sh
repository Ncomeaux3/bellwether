#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$HOME/bellwether}"
cd "$REPO"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# A dev machine and a fresh install must not fail just because restic isn't
# wired up yet — this is a silent no-op until RESTIC_REPOSITORY is set.
if [ -z "${RESTIC_REPOSITORY:-}" ]; then
  echo "backup: restic not configured, skipping"
  exit 0
fi

if ! command -v restic >/dev/null 2>&1; then
  echo "backup: restic not installed — run 'sudo apt install restic' (see docs/homelab.md)"
  exit 1
fi

if ! restic backup "$REPO/data/backup"; then
  echo "backup: restic backup failed"
  exit 1
fi

if ! restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune; then
  echo "backup: restic forget/prune failed"
  exit 1
fi

echo "backup: pushed $REPO/data/backup to $RESTIC_REPOSITORY, pruned to 7 daily / 4 weekly / 12 monthly"
