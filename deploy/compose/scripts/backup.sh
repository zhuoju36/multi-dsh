#!/usr/bin/env bash
# Rest → S3 backup for phase 1.
#
# Required env:
#   RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE
# Optional:
#   DATA_ROOT (default /srv/multi-dsh/volumes), TENANT_ENV_DIR, COMPOSE_FILE,
#   STAGING_DIR (default /srv/multi-dsh/backup-staging),
#   POSTGRES_CONTAINER (default multi-dsh-platform-postgres-1),
#   POSTGRES_USER / POSTGRES_DB, RESTIC_BIN (default restic)
set -euo pipefail

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"
RESTIC_BIN=${RESTIC_BIN:-restic}
DATA_ROOT=${DATA_ROOT:-/srv/multi-dsh/volumes}
COMPOSE_ROOT=$(cd "$(dirname "$0")/.." && pwd)
COMPOSE_FILE=${COMPOSE_FILE:-$COMPOSE_ROOT/compose.tenant.yml}
TENANT_ENV_DIR=${TENANT_ENV_DIR:-$COMPOSE_ROOT/tenants}
STAGING_DIR=${STAGING_DIR:-/srv/multi-dsh/backup-staging}
POSTGRES_CONTAINER=${POSTGRES_CONTAINER:-multi-dsh-platform-postgres-1}
POSTGRES_USER=${POSTGRES_USER:-multi_dsh}
POSTGRES_DB=${POSTGRES_DB:-multi_dsh}

mkdir -p "$STAGING_DIR"

echo "backup: dumping postgres"
docker exec "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" > "$STAGING_DIR/postgres.sql"

shopt -s nullglob
for env_file in "$TENANT_ENV_DIR"/*.env; do
  user=$(basename "$env_file" .env)
  data_dir="$DATA_ROOT/$user/data"
  if [ ! -d "$data_dir" ]; then
    echo "backup: skip $user (no data dir at $data_dir)"
    continue
  fi
  dsh_version=$(sed -n 's/^DSH_VERSION=//p' "$env_file" | head -n1)
  platform_cmd=(docker compose -p "dsh-$user" -f "$COMPOSE_FILE" --env-file "$env_file")

  echo "backup: stopping $user for a consistent snapshot"
  "${platform_cmd[@]}" stop

  if ! "$RESTIC_BIN" backup "$data_dir" "$STAGING_DIR/postgres.sql" \
    --tag "user=$user" \
    --tag "dsh_version=${dsh_version:-unknown}" \
    --exclude 'dsh-home/cache' \
    --exclude 'dsh-home/.cache'; then
    echo "backup: restic failed for $user; restarting the tenant" >&2
    "${platform_cmd[@]}" start
    exit 1
  fi

  echo "backup: starting $user"
  "${platform_cmd[@]}" start
done

rm -f "$STAGING_DIR/postgres.sql"
echo "backup: applying retention"
"$RESTIC_BIN" forget --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune
echo "backup: done"
