# Guards for pairfob artifacts that may land on pairfob.com/dl.
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
    echo "working tree is dirty; will not compile pairfob for /dl" >&2
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

pairfob_require_release_dir() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    echo "missing release directory $dir" >&2
    return 1
  fi
  pairfob_require_shipable_version_file "$dir/VERSION" || return 1

  local name path
  for name in \
    pairfob-darwin-amd64 \
    pairfob-darwin-arm64 \
    pairfob-linux-amd64 \
    pairfob-linux-arm64 \
    VERSION \
    SHA256SUMS; do
    path="$dir/$name"
    if [[ ! -f "$path" || -L "$path" ]]; then
      echo "release directory requires a regular file: $path" >&2
      return 1
    fi
  done

  for name in pairfob-darwin-amd64 pairfob-darwin-arm64 pairfob-linux-amd64 pairfob-linux-arm64; do
    if [[ ! -x "$dir/$name" ]]; then
      echo "release binary is not executable: $dir/$name" >&2
      return 1
    fi
  done

  for path in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    if [[ ! -e "$path" && ! -L "$path" ]]; then
      continue
    fi
    name="${path##*/}"
    case "$name" in
      pairfob-darwin-amd64|pairfob-darwin-arm64|pairfob-linux-amd64|pairfob-linux-arm64|VERSION|SHA256SUMS) ;;
      *)
        echo "unexpected release artifact: $path" >&2
        return 1
        ;;
    esac
  done

  if ! awk '
    BEGIN {
      required["pairfob-darwin-amd64"] = 1
      required["pairfob-darwin-arm64"] = 1
      required["pairfob-linux-amd64"] = 1
      required["pairfob-linux-arm64"] = 1
      required["VERSION"] = 1
    }
    {
      name = $2
      sub(/^\*/, "", name)
      if (NF != 2 || length($1) != 64 || $1 ~ /[^[:xdigit:]]/ || !(name in required) || seen[name]++) {
        exit 1
      }
    }
    END {
      if (NR != 5) exit 1
      for (name in required) if (!seen[name]) exit 1
    }
  ' "$dir/SHA256SUMS"; then
    echo "invalid SHA256SUMS manifest in $dir" >&2
    return 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$dir" && sha256sum -c SHA256SUMS >/dev/null) || {
      echo "release artifact checksum verification failed in $dir" >&2
      return 1
    }
  else
    (cd "$dir" && shasum -a 256 -c SHA256SUMS >/dev/null) || {
      echo "release artifact checksum verification failed in $dir" >&2
      return 1
    }
  fi
}
