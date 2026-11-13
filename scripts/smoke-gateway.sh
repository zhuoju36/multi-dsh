#!/usr/bin/env bash
# End-to-end smoke test without Docker: entrypoint + gateway + a local DSH
# checkout, in gateway dev mode (no platform auth).
#
#   DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/smoke-gateway.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DSH_CHECKOUT=${DSH_CHECKOUT:-$HOME/deepseek-harness}
DSH_BIN="$DSH_CHECKOUT/apps/cli/lib/bin.js"
PORT=${SMOKE_PORT:-8097}
DSH_PORT=${SMOKE_DSH_PORT:-3097}

if [ ! -f "$DSH_BIN" ]; then
  echo "smoke: DSH checkout not found at $DSH_CHECKOUT (set DSH_CHECKOUT)" >&2
  exit 1
fi

TMP=$(mktemp -d "$PWD/.tmp-smoke-XXXXXX")
PID=''
cleanup() {
  if [ -n "$PID" ]; then kill -TERM "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "smoke: starting gateway + dsh on 127.0.0.1:$PORT"
TMPDIR=/tmp DSH_HOME="$TMP/dsh-home" RUN_DIR="$TMP/run" TOKEN_FILE="$TMP/run/launch-token" \
  LISTEN_PORT="$PORT" DSH_WEB_PORT="$DSH_PORT" USER_HOST="127.0.0.1:$PORT" TENANT_ID=dev \
  GATEWAY_DEV_MODE=1 \
  DSH_COMMAND="node $DSH_BIN" \
  GATEWAY_ENTRY="$PWD/services/gateway/server.mjs" \
  TEMPLATE_DIR="$PWD/deploy/docker/template/dsh-home" \
  PATCH_FILE="$TMP/no-patch.yml" \
  bash deploy/docker/entrypoint.sh >"$TMP/entrypoint.log" 2>&1 &
PID=$!

ready=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "smoke: gateway did not become healthy" >&2
  tail -40 "$TMP/entrypoint.log" >&2
  exit 1
fi

health=$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz")
[[ "$health" == *'"ok":true'* ]] || { echo "smoke: bad healthz: $health" >&2; exit 1; }

status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/")
[ "$status" = "303" ] || { echo "smoke: expected 303 token exchange, got $status" >&2; exit 1; }

body=$(curl -sS -c "$TMP/cookies" -b "$TMP/cookies" -L --max-time 10 "http://127.0.0.1:$PORT/")
case "$body" in
  *"<!doctype html>"*) ;;
  *) echo "smoke: expected the DSH page after token exchange" >&2; exit 1 ;;
esac

if grep -qE '[?&]token=[A-Za-z0-9_-]{8,}' "$TMP/entrypoint.log"; then
  echo "smoke: launch token was written to the log" >&2
  exit 1
fi

echo "smoke: OK (healthz 200, token exchange 303, page loaded, token redacted in logs)"
