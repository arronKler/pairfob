#!/bin/sh
set -eu

fail() {
  echo "Pairfob plugin: $*" >&2
  exit 1
}

plugin_root() {
  if [ -n "${HERDR_PLUGIN_ROOT:-}" ]; then
    printf '%s\n' "$HERDR_PLUGIN_ROOT"
    return
  fi
  script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  CDPATH= cd -- "$script_dir/../.." && pwd
}

find_pairfob() {
  if command -v pairfob >/dev/null 2>&1; then
    command -v pairfob
    return
  fi

  if [ -n "${HOME:-}" ] && [ -x "$HOME/.local/bin/pairfob" ]; then
    printf '%s\n' "$HOME/.local/bin/pairfob"
    return
  fi

  if [ -x /usr/local/bin/pairfob ]; then
    printf '%s\n' /usr/local/bin/pairfob
    return
  fi
  return 1
}

require_pairfob() {
  if pairfob_bin="$(find_pairfob)"; then
    printf '%s\n' "$pairfob_bin"
    return
  fi
  fail "Pairfob is not installed. Run the “Pairfob: Pair a device” action first."
}

install_pairfob() {
  [ -n "${HOME:-}" ] || fail "HOME is missing"
  root="$(plugin_root)"
  installer="$root/scripts/install.sh"
  [ -f "$installer" ] || fail "installer is missing: $installer"
  echo "Pairfob is not installed; downloading the verified release…"
  sh "$installer"
}

wait_until_live() {
  pairfob_bin="$1"
  attempt=0
  while [ "$attempt" -lt 40 ]; do
    if "$pairfob_bin" pair status >/dev/null 2>&1; then
      return
    fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  fail "the background service did not become ready; run Pairfob: Check this computer"
}

start_pairfob() {
  pairfob_bin="$1"
  if "$pairfob_bin" pair status >/dev/null 2>&1; then
    echo "Pairfob is already running."
    return
  fi
  if ! "$pairfob_bin" service start >/dev/null 2>&1; then
    "$pairfob_bin" service install
  fi
  wait_until_live "$pairfob_bin"
  echo "Pairfob is running."
}

pause_if_interactive() {
  if [ -t 0 ]; then
    printf '\nPress Enter to close…'
    IFS= read -r _ || true
  fi
}

case "${1:-}" in
  pair)
    if pairfob_bin="$(find_pairfob)"; then
      :
    else
      install_pairfob
      pairfob_bin="$(find_pairfob)" || fail "installation finished but the pairfob binary was not found"
    fi
    start_pairfob "$pairfob_bin"
    exec "$pairfob_bin" pair
    ;;
  doctor)
    pairfob_bin="$(require_pairfob)"
    status=0
    "$pairfob_bin" doctor || status=$?
    pause_if_interactive
    exit "$status"
    ;;
  start)
    pairfob_bin="$(require_pairfob)"
    start_pairfob "$pairfob_bin"
    ;;
  stop)
    pairfob_bin="$(require_pairfob)"
    exec "$pairfob_bin" service stop
    ;;
  update)
    pairfob_bin="$(require_pairfob)"
    exec "$pairfob_bin" update
    ;;
  *)
    echo "usage: pairfob.sh pair|doctor|start|stop|update" >&2
    exit 2
    ;;
esac
