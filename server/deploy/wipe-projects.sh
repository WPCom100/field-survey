#!/usr/bin/env bash
# One-off (T198, D287 (7), D292 (5)): remove every project's data and the device-type library on the
# Droplet, keeping users, installs, the app-level vocabulary and rule defaults (app/wipe.py says
# exactly what goes). Run as root, once, on Landry's go, after every iPad has synced and
# cold-launched onto the one-library update (docs/ops.md §4.4):
#   bash /opt/field-survey/server/deploy/wipe-projects.sh          # dry run: row counts, nothing changes
#   bash /opt/field-survey/server/deploy/wipe-projects.sh --run    # backups, counts, confirm, delete
# Add --all (after --run, or alone for its dry run) to empty every table, users and the app vocabulary
# too, and delete every blob object (Landry, 2026-11-18).
# --run asks you to type WIPE (or set WIPE_CONFIRM=WIPE). It takes an R2 dump (app.backup) and a local
# dump in /root first, stops the API and the worker around the delete and starts them again even if
# the delete fails. The delete is one transaction: a failure leaves the database as it was.
set -euo pipefail

main() {
REPO="${REPO:-/opt/field-survey}"
cd "$REPO/server"
step() { echo "wipe $(date -u +%FT%TZ) $*"; }

ALL=""
[[ "${2:-}" == "--all" || "${1:-}" == "--all" ]] && ALL="--all"
if [[ "${1:-}" != "--run" ]]; then
  [[ -z "${1:-}" || "$1" == "--all" ]] || { echo "usage: wipe-projects.sh [--run] [--all]" >&2; exit 2; }
  docker compose exec -T api python -m app.wipe $ALL
  exit 0
fi

step "backup to R2"
docker compose exec -T worker python -m app.backup dump
DUMP="/root/pre-wipe-$(date -u +%Y-%m-%dT%H%M%SZ).dump"
step "local dump to $DUMP"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "$DUMP.part"
mv "$DUMP.part" "$DUMP"

step "what goes"
docker compose exec -T api python -m app.wipe $ALL
answer="${WIPE_CONFIRM:-}"
if [[ -z "$answer" ]]; then
  read -r -p "Type WIPE to delete all of the above: " answer
fi
[[ "$answer" == "WIPE" ]] || { echo "wipe: not confirmed, nothing changed" >&2; exit 1; }

step "stop api and worker"
docker compose stop api worker
trap 'step "start api and worker"; docker compose start api worker' EXIT
step "delete"
docker compose run --rm --no-deps -T api python -m app.wipe $ALL --yes
step "done; restore with docs/ops.md §3.3 from $DUMP if needed"
}

main "$@"
