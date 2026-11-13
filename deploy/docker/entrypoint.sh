#!/usr/bin/env bash
# multi-dsh user-container entrypoint (prototype)
#
# Starts the gateway in the background, then runs `dsh web` on loopback and
# captures its one-time launch token from the startup line.
set -euo pipefail

DSH_HOME=${DSH_HOME:-/data/dsh-home}
DATA_DIR=$(dirname "$DSH_HOME")
RUN_DIR=${RUN_DIR:-/run/dsh}
TOKEN_FILE=${TOKEN_FILE:-$RUN_DIR/launch-token}
TEMPLATE_DIR=${TEMPLATE_DIR:-/opt/multi-dsh/template/dsh-home}
GATEWAY_ENTRY=${GATEWAY_ENTRY:-/opt/multi-dsh/app/services/gateway/server.mjs}
PATCH_FILE=${PATCH_FILE:-/opt/multi-dsh/patch/deploy.yml}
DSH_WEB_HOST=${DSH_WEB_HOST:-127.0.0.1}
DSH_WEB_PORT=${DSH_WEB_PORT:-3080}
: "${DSH_COMMAND:=dsh}"

# The gateway and the healthcheck must probe the same port dsh listens on.
export DSH_PORT="$DSH_WEB_PORT"

log() { printf 'entrypoint: %s\n' "$*" >&2; }

mkdir -p "$DATA_DIR" "$RUN_DIR" "$DSH_HOME" "${HOME:-/data/home}"

# One-time DSH_HOME initialization from the image template.
if [ ! -e "$DSH_HOME/profiles" ]; then
  if [ -d "$TEMPLATE_DIR" ] && [ -n "$(ls -A "$TEMPLATE_DIR" 2>/dev/null || true)" ]; then
    log "initializing $DSH_HOME from $TEMPLATE_DIR"
    cp -a "$TEMPLATE_DIR"/. "$DSH_HOME"/
  else
    log "no template content; dsh will initialize its profile on first boot"
  fi
fi

if [ "$(id -u)" -eq 0 ]; then
  chown -R dsh:dsh "$DATA_DIR" "$RUN_DIR" 2>/dev/null || true
fi

rm -f "$TOKEN_FILE"

read -r -a dsh_cmd <<< "$DSH_COMMAND"
dsh_args=(--profile web --host "$DSH_WEB_HOST" --port "$DSH_WEB_PORT" --no-open)
if [ -n "${DSH_PUBLIC_URL:-}" ]; then
  dsh_args+=(--public-url "$DSH_PUBLIC_URL")
fi
if [ -n "${DSH_TRUSTED_HOST:-}" ]; then
  dsh_args+=(--trusted-host "$DSH_TRUSTED_HOST")
fi
# An empty or comments-only patch file makes dsh fail to boot, so only pass a non-empty one.
if [ -s "$PATCH_FILE" ]; then
  dsh_args+=(--patch "$PATCH_FILE")
fi

log "starting gateway"
node "$GATEWAY_ENTRY" &
gateway_pid=$!

dsh_pid=''
cleanup() {
  if [ -n "$dsh_pid" ]; then kill -TERM "$dsh_pid" 2>/dev/null || true; fi
  kill -TERM "$gateway_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'cleanup; exit 143' TERM INT

log "starting dsh"
coproc DSH_PROC { exec "${dsh_cmd[@]}" "${dsh_args[@]}"; }
dsh_pid=$DSH_PROC_PID

captured=0
while IFS= read -r line; do
  has_token=0
  if [[ "$line" == *"token="* ]]; then
    has_token=1
    if [ "$captured" -eq 0 ]; then
      token=$(printf '%s\n' "$line" | sed -n 's/.*[?&]token=\([^ &"]*\).*/\1/p')
      if [ -n "$token" ]; then
        umask 077
        printf '%s' "$token" > "$TOKEN_FILE.tmp"
        mv "$TOKEN_FILE.tmp" "$TOKEN_FILE"
        captured=1
        log "launch token captured"
      fi
    fi
  fi
  # Never write the launch token to the container log.
  if [ "$has_token" -eq 1 ]; then
    printf '%s\n' "$line" | sed -E 's/([?&]token=)[^ &"]*/\1***/'
  else
    printf '%s\n' "$line"
  fi
done <&"${DSH_PROC[0]}"

status=0
wait "$dsh_pid" || status=$?
log "dsh exited with status $status"
exit "$status"
