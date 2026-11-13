#!/usr/bin/env bash
# Host preparation for running multi-dsh on THIS machine (Ubuntu).
# Run from a normal shell with sudo (or pkexec):
#
#   sudo bash deploy/host-setup.sh
#
# Optional env:
#   TARGET_USER=hzj                 account that runs docker/provisioner
#   DATA_ROOT=/srv/multi-dsh        host data root
#   REGISTRY_MIRRORS="https://docker.xuanyuan.me https://docker.1ms.run https://docker.m.daocloud.io"
#
# This script touches the host (/etc, /srv, apt packages). It is idempotent.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo bash deploy/host-setup.sh" >&2
  exit 1
fi

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET_USER=${TARGET_USER:-${SUDO_USER:-hzj}}
DATA_ROOT=${DATA_ROOT:-/srv/multi-dsh}
REGISTRY_MIRRORS=${REGISTRY_MIRRORS:-"https://docker.xuanyuan.me https://docker.1ms.run https://docker.m.daocloud.io"}

if ! id "$TARGET_USER" >/dev/null 2>&1; then
  echo "unknown TARGET_USER: $TARGET_USER" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate secrets" >&2
  exit 1
fi

echo "== installing docker.io, docker-compose-v2, docker-buildx, restic"
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
# This machine has a stale file:/mnt/iso source; do not let it block the install.
if ! apt-get update; then
  echo "warning: apt-get update failed (stale ISO source?); continuing with existing lists" >&2
fi
apt-get install -y docker.io docker-compose-v2 docker-buildx restic
systemctl enable --now docker

if ! id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "== adding $TARGET_USER to the docker group"
  usermod -aG docker "$TARGET_USER"
fi
# This session predates the group change; grant socket access now as well.
if [ -S /var/run/docker.sock ] && command -v setfacl >/dev/null 2>&1; then
  setfacl -m "u:$TARGET_USER:rw" /var/run/docker.sock 2>/dev/null || true
fi

echo "== creating $DATA_ROOT"
mkdir -p "$DATA_ROOT/pgdata" "$DATA_ROOT/volumes" "$DATA_ROOT/backup-staging" \
  "$DATA_ROOT/secrets" "$DATA_ROOT/minio" "$DATA_ROOT/run"
# Official postgres image runs as uid/gid 999.
chown 999:999 "$DATA_ROOT/pgdata"
# hzj is uid 1000; the MinIO image runs as 1000 too, so this works for both.
chown -R "$TARGET_USER":"$TARGET_USER" \
  "$DATA_ROOT/volumes" "$DATA_ROOT/backup-staging" "$DATA_ROOT/secrets" "$DATA_ROOT/minio" "$DATA_ROOT/run"
chmod 700 "$DATA_ROOT/secrets" "$DATA_ROOT/run"

echo "== configuring Docker registry mirrors"
if [ -n "$REGISTRY_MIRRORS" ]; then
  if [ -f /etc/docker/daemon.json ]; then
    cp -n /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date +%s)" || true
  fi
  python3 - $REGISTRY_MIRRORS <<'PY'
import json
import sys

path = '/etc/docker/daemon.json'
try:
    with open(path, encoding='utf-8') as handle:
        data = json.load(handle)
except (FileNotFoundError, json.JSONDecodeError):
    data = {}
mirrors = data.setdefault('registry-mirrors', [])
for mirror in sys.argv[1:]:
    if mirror not in mirrors:
        mirrors.append(mirror)
with open(path, 'w', encoding='utf-8') as handle:
    json.dump(data, handle, indent=2)
    handle.write('\n')
PY
  systemctl restart docker
fi

env_file="$DATA_ROOT/secrets/platform.env"
if [ ! -f "$env_file" ]; then
  echo "== writing $env_file (PLATFORM_API_KEY still needs to be filled in)"
  pg_password=$(openssl rand -hex 24)
  minio_password=$(openssl rand -hex 24)
  hub_token=$(openssl rand -hex 32)
  sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$pg_password|" \
      -e "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=$minio_password|" \
      -e "s|^HUB_TOKEN=.*|HUB_TOKEN=$hub_token|" \
      "$REPO_ROOT/deploy/compose/.env.example" > "$env_file"
  chown "$TARGET_USER":"$TARGET_USER" "$env_file"
  chmod 600 "$env_file"
else
  if ! grep -q '^HUB_TOKEN=' "$env_file"; then
    echo "HUB_TOKEN=$(openssl rand -hex 32)" >> "$env_file"
  fi
  sed -i 's#^AUTH_PUBLIC_URL=.*#AUTH_PUBLIC_URL=http://127.0.0.1:18000#' "$env_file"
  grep -q '^PUBLIC_ORIGIN=' "$env_file" || echo 'PUBLIC_ORIGIN=http://127.0.0.1:18000' >> "$env_file"
  minio_password=$(sed -n 's/^MINIO_ROOT_PASSWORD=//p' "$env_file" | head -n1)
  minio_user=$(sed -n 's/^MINIO_ROOT_USER=//p' "$env_file" | head -n1)
fi
minio_password=$(sed -n 's/^MINIO_ROOT_PASSWORD=//p' "$env_file" | head -n1)
minio_user=$(sed -n 's/^MINIO_ROOT_USER=//p' "$env_file" | head -n1)
minio_user=${minio_user:-multi-dsh}

restic_password_file="$DATA_ROOT/secrets/restic.password"
if [ ! -f "$restic_password_file" ]; then
  echo "== writing restic password and environment"
  openssl rand -hex 24 > "$restic_password_file"
  chown "$TARGET_USER":"$TARGET_USER" "$restic_password_file"
  chmod 600 "$restic_password_file"
fi
restic_env="$DATA_ROOT/secrets/restic.env"
if [ ! -f "$restic_env" ]; then
  cat > "$restic_env" <<EOF
RESTIC_REPOSITORY=s3:http://127.0.0.1:${MINIO_PORT:-9000}/multi-dsh-backup
RESTIC_PASSWORD_FILE=$restic_password_file
AWS_ACCESS_KEY_ID=$minio_user
AWS_SECRET_ACCESS_KEY=$minio_password
AWS_DEFAULT_REGION=us-east-1
EOF
  chown "$TARGET_USER":"$TARGET_USER" "$restic_env"
  chmod 600 "$restic_env"
fi

cat > /etc/cron.d/multi-dsh-backup <<EOF
# Daily restic backup of tenant volumes + PG dump (installed by deploy/host-setup.sh)
0 3 * * * root cd $REPO_ROOT && set -a && . $restic_env && set +a && /bin/bash deploy/compose/scripts/backup.sh >> $DATA_ROOT/backup.log 2>&1
EOF
chmod 0644 /etc/cron.d/multi-dsh-backup

echo "== installing multi-dsh-hub.service (enabled, not started)"
install -m 0644 "$REPO_ROOT/deploy/systemd/multi-dsh-hub.service" /etc/systemd/system/multi-dsh-hub.service
systemctl daemon-reload
systemctl enable multi-dsh-hub.service
touch "$DATA_ROOT/backup.log"
chown "$TARGET_USER":"$TARGET_USER" "$DATA_ROOT/backup.log"

cat <<EOF

== host setup done

data root:   $DATA_ROOT
platform env: $env_file   (set PLATFORM_API_KEY before starting)
restic env:  $restic_env
backup cron: /etc/cron.d/multi-dsh-backup (03:00 daily)

next:
  1. relogin is NOT required for automation: use `sg docker -c '<cmd>'` in this session
  2. edit $env_file and set PLATFORM_API_KEY
  3. start: docker compose -f deploy/compose/compose.platform.yml --env-file $env_file up -d --build
  4. migrate: DATABASE_URL=... node db/migrate.mjs
  5. provision tenants with root (chown to 10001):
       sudo -E DATABASE_URL=... DSH_IMAGE=multi-dsh/dsh:0.2.2-rc.2 \\
         node services/provisioner/src/cli.mjs create --username <name>

capacity warning: ~7.3 GiB RAM, ~4.5 GiB already used. Five tenants fit only
when idle; keep TENANT_MEMORY=1536m and avoid concurrent heavy sessions.
ext4 root: no XFS project quota; monitor `du -sh $DATA_ROOT/volumes/*/data`.
EOF
