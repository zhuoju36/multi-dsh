#!/usr/bin/env bash
# One-shot local bootstrap: platform + MinIO + migrations + user image + pilot tenants.
# Run as root via pkexec/sudo:
#
#   pkexec /usr/bin/bash /home/hzj/WorkSpace/multi-dsh/deploy/bootstrap-local.sh
#
# Idempotency: compose up and migrations are safe to re-run; image builds rebuild;
# tenant creation is NOT idempotent (existing usernames fail and are reported).
set -euo pipefail

REPO_ROOT=/home/hzj/WorkSpace/multi-dsh
ENV_FILE=/srv/multi-dsh/secrets/platform.env
DATA_ROOT=/srv/multi-dsh
DSH_IMAGE=multi-dsh/dsh:0.2.2-rc.2
DSH_VERSION=0.2.2-rc.2
export PATH="/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

cd "$REPO_ROOT"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }

# The deploy user was added to the docker group, but this already-running
# session has the old supplementary groups. Grant socket access immediately so
# the rest of the deployment can be verified without another login.
if [ -S /var/run/docker.sock ]; then
  if command -v setfacl >/dev/null 2>&1; then
    setfacl -m u:hzj:rw /var/run/docker.sock 2>/dev/null || true
  else
    chown root:hzj /var/run/docker.sock 2>/dev/null || true
    chmod 660 /var/run/docker.sock 2>/dev/null || true
  fi
fi

echo "=== [1/8] docker sanity"
docker info >/dev/null
docker compose version

echo "=== [2/8] pull base images (explicit mirrors + retag)"
# Docker's daemon-level mirror fallback falls through to the blocked Docker Hub
# and hangs, so pull explicit mirror hosts (first that works) and retag.
pull() {
  local src=$1 dst=$2
  shift 2
  if docker image inspect "$dst" >/dev/null 2>&1; then
    echo "have $dst"
    return 0
  fi
  local host
  for host in "$@"; do
    if docker pull "$host/$src"; then
      docker tag "$host/$src" "$dst"
      return 0
    fi
  done
  echo "failed to pull $src from: $*" >&2
  return 1
}
pull library/postgres:16 postgres:16 docker.m.daocloud.io docker.1panel.live
pull minio/minio:latest minio/minio:latest docker.1panel.live docker.m.daocloud.io
pull minio/mc:latest minio/mc:latest docker.1panel.live docker.m.daocloud.io
pull library/node:24 node:24 docker.m.daocloud.io docker.1panel.live
pull library/node:24-slim node:24-slim docker.m.daocloud.io docker.1panel.live

echo "=== [3/8] start platform (build auth + llm-gateway)"
docker compose -f deploy/compose/compose.platform.yml --env-file "$ENV_FILE" up -d --build

echo "=== [4/8] wait for auth and minio-init"
for _ in $(seq 1 60); do
  curl -fsS --max-time 2 http://127.0.0.1:18080/healthz >/dev/null 2>&1 && break
  sleep 2
done
if ! curl -fsS --max-time 2 http://127.0.0.1:18080/healthz >/dev/null 2>&1; then
  echo "auth did not become healthy" >&2
  docker compose -f deploy/compose/compose.platform.yml --env-file "$ENV_FILE" ps >&2
  exit 1
fi
# minio-init is one-shot; wait for it to settle.
for _ in $(seq 1 30); do
  state=$(docker inspect -f '{{.State.Status}}' multi-dsh-platform-minio-init-1 2>/dev/null || true)
  [ "$state" = "exited" ] && break
  sleep 2
done

echo "=== [5/8] database migration"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
DATABASE_URL="postgres://${POSTGRES_USER:-multi_dsh}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB:-multi_dsh}"
/usr/local/bin/node db/migrate.mjs

echo "=== [6/8] start hub control plane"
systemctl enable --now multi-dsh-hub.service

echo "=== [6.5/8] build user image"
DSH_COMMIT=$(git -C /home/hzj/deepseek-harness rev-parse --short HEAD)
docker buildx build \
  -f deploy/docker/Dockerfile \
  --build-context dsh=/home/hzj/deepseek-harness \
  --build-arg DSH_VERSION="$DSH_VERSION" \
  --build-arg DSH_COMMIT="$DSH_COMMIT" \
  -t "$DSH_IMAGE" .

echo "=== [7/8] provision pilot tenants"
export DATABASE_URL DSH_IMAGE DSH_VERSION
export TENANT_MEMORY=1536m
bash deploy/provision-pilot.sh
chown hzj:hzj "$DATA_ROOT/secrets/pilot-tenants.txt" 2>/dev/null || true

echo "=== [8/8] restic repository init"
set -a
# shellcheck disable=SC1091
. "$DATA_ROOT/secrets/restic.env"
set +a
if restic snapshots >/dev/null 2>&1; then
  echo "restic repository already initialized"
else
  restic init
fi

echo "=== bootstrap complete"
docker compose -f deploy/compose/compose.platform.yml --env-file "$ENV_FILE" ps
