#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="$ROOT/.dev"

stop_pid() {
  local name="$1"
  local f="$DEV/${name}.pid"
  if [[ ! -f "$f" ]]; then
    return 0
  fi
  local pid
  pid=$(cat "$f" || true)
  if [[ -z "${pid:-}" ]]; then
    rm -f "$f"
    return 0
  fi
  if kill -0 "$pid" 2>/dev/null; then
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      pkill -9 -P "$pid" 2>/dev/null || true
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo "stopped $name pid $pid"
  fi
  rm -f "$f"
}

stop_pid daemon
stop_pid origin
stop_pid cahttp
