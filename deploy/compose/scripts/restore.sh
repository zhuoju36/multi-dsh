#!/usr/bin/env bash
# Restore one tenant volume from restic into a staging directory.
#
# Required env:
#   RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE
# Usage:
#   restore.sh <user_id> [snapshot] [target_dir]
# Defaults: snapshot=latest, target_dir=/srv/multi-dsh/restore/<user_id>
set -euo pipefail

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"
RESTIC_BIN=${RESTIC_BIN:-restic}
DATA_ROOT=${DATA_ROOT:-/srv/multi-dsh/volumes}

user=${1:?usage: restore.sh <user_id> [snapshot] [target_dir]}
snapshot=${2:-latest}
target=${3:-/srv/multi-dsh/restore/$user}

mkdir -p "$target"
echo "restore: $user @ $snapshot -> $target"
"$RESTIC_BIN" restore "$snapshot" --target "$target" --tag "user=$user"

echo "restore: files are in $target/srv/multi-dsh/volumes/$user/data (path mirrors the backup root)"
echo "restore: to go live, stop the tenant, move the restored data into $DATA_ROOT/$user/data, then start it."
