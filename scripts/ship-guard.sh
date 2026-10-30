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

# Hosted pairfob binaries are SemVer: vMAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH.
# Origin BUILD stays YYYY-MM-DD.N and is not a binary version.
pairfob_semver_ok() {
  [[ "${1:-}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

pairfob_require_shipable_version() {
  local v="${1:-}"
  local label="${2:-VERSION}"
  if [[ "${PAIRFOB_ALLOW_DIRTY:-}" == "1" ]]; then
    return 0
  fi
  if pairfob_semver_ok "$v"; then
    return 0
  fi
  echo "$label: '$v' is not shippable semver (need vX.Y.Z or X.Y.Z)" >&2
  echo "tag this commit, set VERSION, or set PAIRFOB_ALLOW_DIRTY=1 for a local artifact" >&2
  return 1
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

  # pairfob-chat ships with the daemon from this version on. A directory without
  # it stays valid so releases that predate the chat host still pass the guard.
  local -a chat_names=(
    pairfob-chat-darwin-amd64
    pairfob-chat-darwin-arm64
    pairfob-chat-linux-amd64
    pairfob-chat-linux-arm64
  )
  local chat_count=0 chat_name
  for chat_name in "${chat_names[@]}"; do
    if [[ -e "$dir/$chat_name" || -L "$dir/$chat_name" ]]; then
      chat_count=$((chat_count + 1))
    fi
  done
  local allowed="pairfob-darwin-amd64 pairfob-darwin-arm64 pairfob-linux-amd64 pairfob-linux-arm64 VERSION"
  if (( chat_count > 0 )); then
    if (( chat_count != ${#chat_names[@]} )); then
      echo "incomplete pairfob-chat artifact set in $dir" >&2
      return 1
    fi
    for chat_name in "${chat_names[@]}"; do
      path="$dir/$chat_name"
      if [[ ! -f "$path" || -L "$path" ]]; then
        echo "release directory requires a regular file: $path" >&2
        return 1
      fi
      if [[ ! -x "$path" ]]; then
        echo "release binary is not executable: $path" >&2
        return 1
      fi
      allowed="$allowed $chat_name"
    done
  fi
  local expected_count=$((5 + chat_count))

  for path in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    if [[ ! -e "$path" && ! -L "$path" ]]; then
      continue
    fi
    name="${path##*/}"
    case "$name" in
      pairfob-darwin-amd64|pairfob-darwin-arm64|pairfob-linux-amd64|pairfob-linux-arm64|pairfob-chat-darwin-amd64|pairfob-chat-darwin-arm64|pairfob-chat-linux-amd64|pairfob-chat-linux-arm64|VERSION|SHA256SUMS) ;;
      # publish-android-beta.sh stages the Android channel in dist/dl/android/beta,
      # and a pack copies only the top-level files, so a directory of that name
      # never reaches the relay's /dl.
      android)
        [[ -d "$path" && ! -L "$path" ]] && continue
        echo "unexpected release artifact: $path" >&2
        return 1
        ;;
      *)
        echo "unexpected release artifact: $path" >&2
        return 1
        ;;
    esac
  done

  if ! awk -v expected_count="$expected_count" -v allowed_names="$allowed" '
    BEGIN {
      count = split(allowed_names, names, " ")
      for (i = 1; i <= count; i++) allowed[names[i]] = 1
    }
    {
      name = $2
      sub(/^\*/, "", name)
      if (NF != 2 || length($1) != 64 || $1 ~ /[^[:xdigit:]]/ || !(name in allowed) || seen[name]++) {
        exit 1
      }
    }
    END {
      if (NR != expected_count) exit 1
      for (name in allowed) if (!seen[name]) exit 1
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

# Desktop release directories are built per platform, so their artifact set is
# a known subset rather than all four. SHA256SUMS still covers VERSION and
# every binary in the directory.
pairfob_require_desktop_dir() {
  local dir="${1:-}"
  if [[ ! -d "$dir" ]]; then
    echo "missing desktop release directory $dir" >&2
    return 1
  fi
  pairfob_require_shipable_version_file "$dir/VERSION" || return 1
  if [[ ! -f "$dir/SHA256SUMS" || -L "$dir/SHA256SUMS" ]]; then
    echo "missing desktop checksums: $dir/SHA256SUMS" >&2
    return 1
  fi

  local path name count=0 allowed="VERSION"
  for path in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    if [[ ! -e "$path" && ! -L "$path" ]]; then
      continue
    fi
    name="${path##*/}"
    case "$name" in
      VERSION|SHA256SUMS) ;;
      pairfob-desktop-darwin-amd64|pairfob-desktop-darwin-arm64|pairfob-desktop-linux-amd64|pairfob-desktop-linux-arm64)
        if [[ ! -f "$path" || -L "$path" ]]; then
          echo "desktop release requires a regular file: $path" >&2
          return 1
        fi
        if [[ ! -x "$path" ]]; then
          echo "desktop release binary is not executable: $path" >&2
          return 1
        fi
        allowed="$allowed $name"
        count=$((count + 1))
        ;;
      *)
        echo "unexpected desktop release artifact: $path" >&2
        return 1
        ;;
    esac
  done
  if (( count == 0 )); then
    echo "desktop release has no platform binary: $dir" >&2
    return 1
  fi

  if ! awk -v expected_count=$((count + 1)) -v allowed_names="$allowed" '
    BEGIN {
      count = split(allowed_names, names, " ")
      for (i = 1; i <= count; i++) allowed[names[i]] = 1
    }
    {
      name = $2
      sub(/^\*/, "", name)
      if (NF != 2 || length($1) != 64 || $1 ~ /[^[:xdigit:]]/ || !(name in allowed) || seen[name]++) {
        exit 1
      }
    }
    END {
      if (NR != expected_count) exit 1
      for (name in allowed) if (!seen[name]) exit 1
    }
  ' "$dir/SHA256SUMS"; then
    echo "invalid SHA256SUMS manifest in $dir" >&2
    return 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$dir" && sha256sum -c SHA256SUMS >/dev/null) || {
      echo "desktop artifact checksum verification failed in $dir" >&2
      return 1
    }
  else
    (cd "$dir" && shasum -a 256 -c SHA256SUMS >/dev/null) || {
      echo "desktop artifact checksum verification failed in $dir" >&2
      return 1
    }
  fi
}
