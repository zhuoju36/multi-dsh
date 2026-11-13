#!/usr/bin/env bash
# Create the pilot tenants (run as root: the provisioner chowns data dirs to UID 10001).
#
#   sudo -E DATABASE_URL=... DSH_IMAGE=multi-dsh/dsh:0.2.2-rc.2 DSH_VERSION=0.2.2-rc.2 \
#     TENANT_MEMORY=1536m bash deploy/provision-pilot.sh
#
# Credentials are printed once and appended to /srv/multi-dsh/secrets/pilot-tenants.txt (0600).
set -uo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${DSH_IMAGE:?DSH_IMAGE is required}"
: "${DSH_VERSION:=unknown}"
USERS=${PILOT_USERS:-"user1 user2 user3 user4 user5"}
CRED_FILE=${CRED_FILE:-/srv/multi-dsh/secrets/pilot-tenants.txt}

if [ "$(id -u)" -ne 0 ] && [ "${ALLOW_NONROOT:-0}" != "1" ]; then
  echo "run as root (provisioner must chown tenant data dirs to UID 10001)," >&2
  echo "or pre-create the dirs owned by 10001 and set ALLOW_NONROOT=1" >&2
  exit 1
fi
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

umask 077
: > "$CRED_FILE"
export DATABASE_URL DSH_IMAGE DSH_VERSION

for user in $USERS; do
  echo "=== $user ===" | tee -a "$CRED_FILE"
  if node services/provisioner/src/cli.mjs create --username "$user" 2>&1 | tee -a "$CRED_FILE"; then
    echo "created $user"
  else
    echo "FAILED $user (see output above)" | tee -a "$CRED_FILE"
  fi
done

chmod 600 "$CRED_FILE"
echo "credentials: $CRED_FILE"
