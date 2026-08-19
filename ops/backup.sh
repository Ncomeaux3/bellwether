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

# Same visibility contract as ops/publish.sh's record() — see its comment.
record() {  # $1 = ok|failed, $2 = detail
  docker compose exec -T bellwether pnpm bw ops record --kind restic --state "$1" --detail "$2" >/dev/null 2>&1 || true
}

# A dev machine and a fresh install must not fail — or report anything at
# all — just because restic isn't wired up yet: recording here would
# manufacture a health signal for a leg the operator never opted into. The
# heartbeat watchdog treats "restic never ran" as quiet for exactly this
# reason.
if [ -z "${RESTIC_REPOSITORY:-}" ]; then
  echo "backup: restic not configured, skipping"
  exit 0
fi

if ! command -v restic >/dev/null 2>&1; then
  MSG="backup: restic not installed — run 'sudo apt install restic' (see docs/homelab.md)"
  echo "$MSG"
  record failed "$MSG"
  exit 1
fi

# The whole dir, not just today's file: restic dedups unchanged content so
# the extra cost is negligible, and re-sending the retained dailies means a
# night whose push failed self-heals on the next run instead of leaving a
# permanent hole in the remote history.
if ! restic backup "$REPO/data/backup"; then
  MSG="backup: restic backup failed"
  echo "$MSG"
  record failed "$MSG"
  exit 1
fi

if ! restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune; then
  MSG="backup: restic forget/prune failed"
  echo "$MSG"
  record failed "$MSG"
  exit 1
fi

DETAIL="pushed $REPO/data/backup to $RESTIC_REPOSITORY, pruned to 7 daily / 4 weekly / 12 monthly"
echo "backup: ${DETAIL}"
record ok "$DETAIL"
