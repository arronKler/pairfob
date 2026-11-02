#!/usr/bin/env bash
# Fail when a handwritten source file grows past the 800-line limit in AGENTS.md.
set -euo pipefail

ROOT="${1:-"$(cd "$(dirname "$0")/.." && pwd)"}"
if [ ! -d "$ROOT" ]; then
  echo "check-source-size.sh: not a directory: $ROOT" >&2
  exit 2
fi
ROOT="$(cd "$ROOT" && pwd)"

LIMIT=800

# Tracked and untracked-but-not-ignored files when the root is a git checkout,
# so build output and local scratch trees stay out of the count. A plain
# directory (release tarball, temp fixture) falls back to find with the same
# exclusions.
list_files() {
  if command -v git >/dev/null 2>&1 &&
    git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ROOT" ls-files -z --cached --others --exclude-standard -- \
      '*.go' '*.rs' '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' \
      '*.css' '*.scss' '*.sh' '*.bash' '*.py' \
      ':(exclude)**/node_modules/**' ':(exclude)**/dist/**' \
      ':(exclude)**/desktop/target/**'
  else
    find "$ROOT" \
      \( -name node_modules -o -name .git -o -name dist \
      -o -path "$ROOT/desktop/target" \
      -o -name '*.lock' -o -name 'bun.lock*' -o -name package-lock.json \
      -o -name pnpm-lock.yaml -o -name yarn.lock \) -prune -o \
      -type f \( -name '*.go' -o -name '*.rs' -o -name '*.ts' -o -name '*.tsx' \
      -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.cjs' \
      -o -name '*.css' -o -name '*.scss' -o -name '*.sh' -o -name '*.bash' \
      -o -name '*.py' \) -print0
  fi
}

# wc counts newlines; a final line without one needs the exact count, so files
# at or above the limit are recounted with awk.
offenders=()
while read -r count file; do
  [ "$file" = total ] && continue
  [ "$count" -ge "$LIMIT" ] || continue
  case "$file" in
    /*) path="$file" ;;
    *) path="$ROOT/$file" ;;
  esac
  exact="$(awk 'END { print NR }' "$path")"
  if [ "$exact" -gt "$LIMIT" ]; then
    offenders+=("${path#"$ROOT"/}: $exact")
  fi
done < <(cd "$ROOT" && list_files | xargs -0 wc -l)

if [ "${#offenders[@]}" -gt 0 ]; then
  printf '%s\n' "${offenders[@]}"
  echo "check-source-size.sh: handwritten files must stay at or under ${LIMIT} lines; split them by duty" >&2
  exit 1
fi
