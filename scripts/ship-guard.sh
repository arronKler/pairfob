# Guards for pairfobd artifacts that may land on pairfob.com/dl.
# Sourced by release.sh and pack-origin-assets.sh.
# PAIRFOB_ALLOW_DIRTY=1 is for local fixtures only — never for pairfob.com.

pairfob_require_clean_tree() {
  local root="${1:-.}"
  if [[ "${PAIRFOB_ALLOW_DIRTY:-}" == "1" ]]; then
    return 0
  fi
  if ! command -v git >/dev/null 2>&1; then
    return 0
  fi
  if ! git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi
  local dirty
  dirty="$(git -C "$root" status --porcelain)"
  if [[ -n "$dirty" ]]; then
    echo "working tree is dirty; will not compile pairfobd for /dl" >&2
    echo "commit or stash, or set PAIRFOB_ALLOW_DIRTY=1 for a local artifact" >&2
    return 1
  fi
  return 0
}

pairfob_require_shipable_version() {
  local v="${1:-}"
  local label="${2:-VERSION}"
  if [[ "${PAIRFOB_ALLOW_DIRTY:-}" == "1" ]]; then
    return 0
  fi
  if [[ -z "$v" || "$v" == "dev" || "$v" == *-dirty ]]; then
    echo "$label: '$v' is not shippable (empty, dev, or *-dirty)" >&2
    echo "rebuild from a clean git tree, or set PAIRFOB_ALLOW_DIRTY=1 for a local artifact" >&2
    return 1
  fi
  return 0
}

pairfob_require_shipable_version_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "missing $path (PAIRFOB_PACK_DL=1 needs a shippable dist/dl)" >&2
    return 1
  fi
  local v
  v="$(tr -d '[:space:]' <"$path")"
  pairfob_require_shipable_version "$v" "$path"
}
