#!/bin/sh
set -eu

case "${1:-}" in
  pair | doctor) entrypoint="$1" ;;
  *)
    echo "usage: open-pane.sh pair|doctor" >&2
    exit 2
    ;;
esac

if [ -z "${HERDR_BIN_PATH:-}" ]; then
  echo "Pairfob plugin: HERDR_BIN_PATH is missing" >&2
  exit 1
fi

plugin_id="${HERDR_PLUGIN_ID:-pairfob}"
exec "$HERDR_BIN_PATH" plugin pane open \
  --plugin "$plugin_id" \
  --entrypoint "$entrypoint" \
  --placement overlay \
  --focus
