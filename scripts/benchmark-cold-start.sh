#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="${XUANWU_BINARY:-$ROOT_DIR/dist/xuanwu}"
DURATION_SECONDS=2100
WARMUP_SECONDS=300
INTERVAL_SECONDS=5
PORT=39101
OUTPUT_DIR=""
WEB_DIR="$ROOT_DIR/frontend/dist"

usage() {
  cat <<'EOF'
Usage: scripts/benchmark-cold-start.sh [options]
  --binary PATH       compiled runner binary
  --duration SECONDS  total run time, including warmup (default: 2100)
  --warmup SECONDS    exclude initial warmup from P95/drift (default: 300; leaves 30 minutes measured)
  --interval SECONDS  sample interval (default: 5)
  --port PORT         isolated listen port (default: 39101)
  --web-dir PATH      frontend/static directory (default: frontend/dist)
  --output-dir PATH   artifact directory (default: /tmp/xuanwu-cold-start-<timestamp>)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary) BINARY="$2"; shift 2 ;;
    --duration) DURATION_SECONDS="$2"; shift 2 ;;
    --warmup) WARMUP_SECONDS="$2"; shift 2 ;;
    --interval) INTERVAL_SECONDS="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --web-dir) WEB_DIR="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -x "$BINARY" ]] || { echo "runner binary is not executable: $BINARY" >&2; exit 1; }
[[ "$DURATION_SECONDS" =~ ^[0-9]+$ ]] || { echo "duration must be an integer" >&2; exit 2; }
[[ "$WARMUP_SECONDS" =~ ^[0-9]+$ ]] || { echo "warmup must be an integer" >&2; exit 2; }
[[ "$INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "interval must be a positive integer" >&2; exit 2; }
(( DURATION_SECONDS > WARMUP_SECONDS )) || { echo "duration must be greater than warmup" >&2; exit 2; }

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/xuanwu-cold-start-$STAMP}"
STATE_DIR="$OUTPUT_DIR/state"
URL="http://127.0.0.1:$PORT"
mkdir -p "$OUTPUT_DIR" "$STATE_DIR" "$STATE_DIR/sessions"
[[ -d "$WEB_DIR" ]] || { echo "frontend/static directory does not exist: $WEB_DIR" >&2; exit 1; }
SAMPLES="$OUTPUT_DIR/samples.jsonl"
TRACE="$OUTPUT_DIR/startup-trace.log"
SUMMARY="$OUTPUT_DIR/summary.json"
PID=""

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

git -C "$ROOT_DIR" status --porcelain --untracked-files=normal > "$OUTPUT_DIR/git-status.txt"
{
  printf 'sample_started_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'binary=%s\n' "$BINARY"
  printf 'build_stamp=%s\n' "$(cat "$BINARY.build.stamp" 2>/dev/null || printf unknown)"
  printf 'git_revision=%s\n' "$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || printf nogit)"
  printf 'git_tree=%s\n' "$(test -s "$OUTPUT_DIR/git-status.txt" && printf dirty || printf clean)"
  printf 'os=%s\n' "$(sw_vers -productVersion 2>/dev/null || uname -sr)"
  printf 'arch=%s\n' "$(uname -m)"
  printf 'bun=%s\n' "$(bun --version)"
  printf 'duration_seconds=%s\n' "$DURATION_SECONDS"
  printf 'warmup_seconds=%s\n' "$WARMUP_SECONDS"
  printf 'interval_seconds=%s\n' "$INTERVAL_SECONDS"
  printf 'web_dir=%s\n' "$WEB_DIR"
} > "$OUTPUT_DIR/metadata.txt"

XUANWU_COLD_START_TRACE=1 "$BINARY" serve \
  --addr "127.0.0.1:$PORT" \
  --state-dir "$STATE_DIR" \
  --db "$STATE_DIR/runner.db" \
  --web-dir "$WEB_DIR" \
  --codex-sessions-dir "$STATE_DIR/sessions" \
  > "$OUTPUT_DIR/runner.out.log" 2> "$TRACE" &
PID=$!

for _ in $(seq 1 300); do
  curl --max-time 30 -fsS "$URL/health" >/dev/null 2>&1 && break
  kill -0 "$PID" 2>/dev/null || { cat "$TRACE" >&2; exit 1; }
  sleep 0.1
done
curl --max-time 30 -fsS "$URL/health" > "$OUTPUT_DIR/health.json"
curl --max-time 30 -fsS "$URL/api/system/status" > "$OUTPUT_DIR/system-status.initial.json"
curl --max-time 30 -fsS "$URL/api/issues" > "$OUTPUT_DIR/issues.json"
curl --max-time 30 -fsS "$URL/api/projects" > "$OUTPUT_DIR/projects.json"
curl --max-time 30 -fsS "$URL/api/runs" > "$OUTPUT_DIR/runs.json"
curl --max-time 30 -sS -o "$OUTPUT_DIR/frontend.body" -w '%{http_code}\n' "$URL/" > "$OUTPUT_DIR/frontend.status"
[[ "$(cat "$OUTPUT_DIR/frontend.status")" == "200" ]] || { echo "frontend/static smoke did not return 200" >&2; exit 1; }

ps -o pid=,ppid=,etime=,rss=,vsz=,command= -p "$PID" > "$OUTPUT_DIR/ps.initial.txt"
command -v footprint >/dev/null && footprint "$PID" > "$OUTPUT_DIR/footprint.initial.txt" 2>&1 || true
command -v vmmap >/dev/null && vmmap -summary "$PID" > "$OUTPUT_DIR/vmmap.initial.txt" 2>&1 || true

STARTED_AT="$(date +%s)"
WARMUP_CAPTURED=0
while true; do
  NOW="$(date +%s)"
  ELAPSED=$((NOW - STARTED_AT))
  (( ELAPSED > DURATION_SECONDS )) && break
  PS_RSS_KIB="$(ps -o rss= -p "$PID" | tr -d ' ')"
  [[ -n "$PS_RSS_KIB" ]] || { echo "runner exited during benchmark" >&2; exit 1; }
  STATUS_FILE="$OUTPUT_DIR/.status.json"
  curl --max-time 30 -fsS "$URL/api/system/status" > "$STATUS_FILE"
  if (( WARMUP_CAPTURED == 0 && ELAPSED >= WARMUP_SECONDS )); then
    cp "$STATUS_FILE" "$OUTPUT_DIR/system-status.warmup.json"
    ps -o pid=,ppid=,etime=,rss=,vsz=,command= -p "$PID" > "$OUTPUT_DIR/ps.warmup.txt"
    command -v footprint >/dev/null && footprint "$PID" > "$OUTPUT_DIR/footprint.warmup.txt" 2>&1 || true
    command -v vmmap >/dev/null && vmmap -summary "$PID" > "$OUTPUT_DIR/vmmap.warmup.txt" 2>&1 || true
    WARMUP_CAPTURED=1
  fi
  python3 - "$STATUS_FILE" "$SAMPLES" "$PS_RSS_KIB" "$ELAPSED" <<'PY'
import json, sys
from datetime import datetime, timezone
status = json.load(open(sys.argv[1], encoding="utf-8"))
memory = (status.get("service") or {}).get("memory") or {}
sample = {
    "api_rss_bytes": int(memory.get("rss_bytes") or 0),
    "elapsed_seconds": int(sys.argv[4]),
    "heap_used_bytes": int(memory.get("heap_used_bytes") or 0),
    "ps_rss_bytes": int(sys.argv[3]) * 1024,
    "sampled_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
with open(sys.argv[2], "a", encoding="utf-8") as output:
    output.write(json.dumps(sample, sort_keys=True) + "\n")
PY
  sleep "$INTERVAL_SECONDS"
done

curl --max-time 30 -fsS "$URL/api/system/status" > "$OUTPUT_DIR/system-status.final.json"
ps -o pid=,ppid=,etime=,rss=,vsz=,command= -p "$PID" > "$OUTPUT_DIR/ps.final.txt"
command -v footprint >/dev/null && footprint "$PID" > "$OUTPUT_DIR/footprint.final.txt" 2>&1 || true
command -v vmmap >/dev/null && vmmap -summary "$PID" > "$OUTPUT_DIR/vmmap.final.txt" 2>&1 || true

python3 - "$SAMPLES" "$SUMMARY" "$WARMUP_SECONDS" <<'PY'
import json, math, sys
samples = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
warmup = int(sys.argv[3])
measured = [s for s in samples if s["elapsed_seconds"] >= warmup]
rss = sorted(max(s["api_rss_bytes"], s["ps_rss_bytes"]) for s in measured)
p95 = rss[max(0, math.ceil(len(rss) * 0.95) - 1)] if rss else 0
drift = (max(rss) - min(rss)) if rss else 0
summary = {
    "budget": {"rss_drift_bytes": 32 * 1024 * 1024, "rss_p95_bytes": 256 * 1024 * 1024},
    "measured_samples": len(rss),
    "rss_drift_bytes": drift,
    "rss_p95_bytes": p95,
    "measured_seconds": max((s["elapsed_seconds"] for s in measured), default=warmup) - warmup,
    "total_samples": len(samples),
    "within_budget": bool(rss) and p95 <= 256 * 1024 * 1024 and drift <= 32 * 1024 * 1024,
}
with open(sys.argv[2], "w", encoding="utf-8") as output:
    json.dump(summary, output, indent=2, sort_keys=True)
    output.write("\n")
print(json.dumps(summary, sort_keys=True))
raise SystemExit(0 if summary["within_budget"] else 1)
PY
