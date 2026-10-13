#!/usr/bin/env bash
# Deploy one exact commit on the Droplet (D154, docs/ops.md §2). Run as root:
#   bash /opt/field-survey/server/deploy/deploy.sh <full sha>
# CI's key is a forced command in /root/.ssh/authorized_keys (docs/ops.md §2.3), so there the
# sha arrives as the ssh command line ($SSH_ORIGINAL_COMMAND) and nothing else can be run.
# CI's deploy job runs exactly this over ssh; it is also the manual path and the rollback
# (pass the previous sha). Idempotent: deploying the sha that is already up just rebuilds from
# cache and waits for /health again. Any failure exits non-zero before `up -d`, so the old
# containers keep serving. Migrations run automatically, behind a dump (D154 (3)).
set -euo pipefail

# Everything runs inside main(), so bash has parsed the whole file before the checkout below
# replaces it: a run always finishes with the script it started with.
main() {
SHA="${1:-${SSH_ORIGINAL_COMMAND:-}}"
[[ -n "$SHA" ]] || { echo "usage: deploy.sh <full commit sha>" >&2; exit 2; }
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "deploy: need the full 40-character sha, got '$SHA'" >&2; exit 2; }
REPO="${REPO:-/opt/field-survey}"
DUMPS="${DUMPS:-/root/deploys}"
KEEP="${KEEP:-10}"

step() { echo "deploy $(date -u +%FT%TZ) $*"; }

# One deploy at a time on the box too (CI has its own concurrency group).
exec 9>/var/lock/field-survey-deploy.lock
flock -n 9 || { echo "deploy: another deploy is running" >&2; exit 3; }

cd "$REPO"
step "fetch $SHA"
git fetch --quiet origin
git cat-file -e "$SHA^{commit}" 2>/dev/null && git merge-base --is-ancestor "$SHA" origin/main   || { echo "deploy: $SHA is not a commit on origin/main" >&2; exit 4; }
git checkout --quiet --detach "$SHA"
[[ "$(git rev-parse HEAD)" == "$SHA" ]]

cd server
export GIT_SHA="$SHA"
step "build"
docker compose build --quiet api worker

step "dump to $DUMPS/$SHA.dump"
mkdir -p "$DUMPS"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "$DUMPS/$SHA.dump.part"
mv "$DUMPS/$SHA.dump.part" "$DUMPS/$SHA.dump"
ls -1t "$DUMPS"/*.dump | tail -n +$((KEEP + 1)) | xargs -r rm -f --

step "migrate"
docker compose run --rm --no-deps api alembic upgrade head

step "up"
docker compose up -d --remove-orphans

step "wait for /health to report $SHA"
for _ in $(seq 1 60); do
  # Straight at the api container: the check must not depend on Caddy or DNS.
  body="$(docker compose exec -T api curl -fsS --max-time 5 http://localhost:8000/health 2>/dev/null || true)"
  if [[ "$body" == *"\"commit\":\"$SHA\""* ]]; then
    step "ok $body"
    docker image prune -f >/dev/null || true
    exit 0
  fi
  sleep 2
done
echo "deploy: /health did not report $SHA within 2 minutes (last: ${body:-no answer})" >&2
docker compose ps >&2
exit 5
}

main "$@"
