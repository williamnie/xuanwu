#!/usr/bin/env bash
set -euo pipefail

LABEL="${CODEX_RUNNER_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner}"
ADDR="${CODEX_RUNNER_ADDR:-127.0.0.1:3008}"
DOMAIN="gui/$(id -u)"

service_url() {
  if [[ "$ADDR" == :* ]]; then
    printf 'http://127.0.0.1%s' "$ADDR"
  else
    printf 'http://%s' "$ADDR"
  fi
}

echo "[status] launchd label: $LABEL"
if launchctl print "$DOMAIN/$LABEL" >/tmp/codex-issue-runner.launchd.$$.txt 2>/dev/null; then
  awk '/state =|pid =|last exit code =/ { print "[status] " $0 }' \
    /tmp/codex-issue-runner.launchd.$$.txt || true
  rm -f /tmp/codex-issue-runner.launchd.$$.txt
else
  rm -f /tmp/codex-issue-runner.launchd.$$.txt
  echo "[status] launchd service is not loaded"
fi

PORT="${ADDR##*:}"
echo "[status] listening sockets for port $PORT:"
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true

URL="$(service_url)"
echo "[status] health check: $URL/health"
if curl -fsS "$URL/health" >/dev/null; then
  echo "[status] API OK"
else
  echo "[status] API not reachable"
  exit 1
fi
