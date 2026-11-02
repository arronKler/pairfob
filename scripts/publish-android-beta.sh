#!/usr/bin/env bash
# Publish a signed Android beta APK to the self-hosted channel:
# https://dl.pairfob.com/android/beta/latest.json
#
# The channel lives on its own Worker, so a publish never deploys the relay and
# never resets the daemons' WebSockets. --legacy-relay additionally updates the
# old relay-hosted channel for builds before beta.9. --legacy-only republishes
# the staged build to that legacy channel without touching the new channel.
#
# Every path validates the APK signature, keeps versionCode monotonic, and
# verifies the deployed bytes. A failed deploy can be retried with the same
# version and hash.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOWNLOADS="$ROOT/workers/pairfob-downloads"
DL_PUBLIC="$DOWNLOADS/public/android/beta"
RELAY="$ROOT/workers/pairfob-origin"
RELAY_PUBLIC="$RELAY/public-dist/dl/android/beta"
STAGE="$ROOT/dist/dl/android/beta"
ORIGIN="${PAIRFOB_DOWNLOAD_ORIGIN:-https://dl.pairfob.com}"
BASE="$ORIGIN/android/beta"
RELAY_ORIGIN="${PAIRFOB_ORIGIN:-https://pairfob.com}"
RELAY_BASE="$RELAY_ORIGIN/dl/android/beta"
PACKAGE="com.pairfob.app"
MIN_SDK=24
BETA_CERT_SHA256="1df205898f9e85ab178d280d3a7a5af5a683e5c686ac7e0df3c37057a64349dc"

APK="${APK:-$ROOT/mobile/android/app/build/outputs/apk/release/app-release.apk}"
NOTES="Beta update."
NOTES_ZH=""
DEPLOY=0
LEGACY_RELAY=0
LEGACY_ONLY=0

usage() {
  echo "usage: publish-android-beta.sh [--apk PATH] [--notes TEXT] [--notes-zh TEXT] [--deploy] [--legacy-relay] [--legacy-only]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apk) APK="${2:?missing value}"; shift 2 ;;
    --notes) NOTES="${2:?missing value}"; shift 2 ;;
    --notes-zh) NOTES_ZH="${2:?missing value}"; shift 2 ;;
    --deploy) DEPLOY=1; shift ;;
    --legacy-relay) LEGACY_RELAY=1; shift ;;
    --legacy-only) LEGACY_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "$LEGACY_ONLY" == "1" || "$LEGACY_RELAY" == "1" ]] && [[ "$DEPLOY" != "1" ]]; then
  echo "--legacy-only and --legacy-relay deploy the relay; pass --deploy" >&2
  exit 2
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing $1" >&2; exit 1; }; }
need python3
need curl
need shasum

export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
[[ -n "$BUILD_TOOLS" ]] || { echo "no Android build-tools under $ANDROID_HOME" >&2; exit 1; }
AAPT2="${BUILD_TOOLS}aapt2"
APKSIGNER="${BUILD_TOOLS}apksigner"
[[ -x "$AAPT2" && -x "$APKSIGNER" ]] || { echo "aapt2 or apksigner missing in $BUILD_TOOLS" >&2; exit 1; }
[[ -f "$DOWNLOADS/wrangler.jsonc" ]] || { echo "download worker missing: $DOWNLOADS" >&2; exit 1; }
if [[ "$LEGACY_ONLY" == "1" || "$LEGACY_RELAY" == "1" ]]; then
  [[ -f "$RELAY/public-dist/index.html" ]] || { echo "relay live asset pack is missing; run scripts/pack-origin-assets.sh first" >&2; exit 1; }
fi

# Both publishers deploy the same Worker. Keep the lock outside the checkout so
# two checkouts on one machine cannot publish concurrently.
DOWNLOAD_LOCK="${PAIRFOB_PUBLISH_LOCK:-$HOME/.cache/pairfob/publish.lock}"
mkdir -p "$(dirname "$DOWNLOAD_LOCK")"
if ! mkdir "$DOWNLOAD_LOCK" 2>/dev/null; then
  echo "another download publication is running: $DOWNLOAD_LOCK" >&2
  exit 1
fi
other_snapshot="$(mktemp)"
desktop_snapshot="$(mktemp)"
trap 'rm -f "$other_snapshot" "$desktop_snapshot"; rmdir "$DOWNLOAD_LOCK" 2>/dev/null || true' EXIT
mkdir -p "$STAGE"
LOCK="$STAGE/.publish.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "another publish is already running (lock: $LOCK)" >&2
  exit 1
fi
trap 'rm -f "$other_snapshot" "$desktop_snapshot"; rmdir "$LOCK" "$DOWNLOAD_LOCK" 2>/dev/null || true' EXIT

json_field() {
  python3 -c 'import json,sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)
value = data.get(sys.argv[2])
if value is None:
    sys.exit(1)
print(value)' "$1" "$2"
}

valid_code() { [[ "$1" =~ ^[1-9][0-9]*$ ]] && (( $1 <= 2147483647 )); }
valid_sha() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }

fetch_manifest() {
  local url="$1" out="$2" status
  status="$(curl -sS -o "$out" -w "%{http_code}" --max-time 20 "$url" || echo 000)"
  case "$status" in
    200) return 0 ;;
    404) return 2 ;;
    *) echo "manifest fetch failed ($status): $url" >&2; return 1 ;;
  esac
}

apk_meta() {
  local path="$1" line badging certs
  badging="$("$AAPT2" dump badging "$path" 2>/dev/null)" || { echo "aapt2 failed: $path" >&2; return 1; }
  line="$(printf '%s\n' "$badging" | head -1)"
  VERSION_CODE="$(printf '%s\n' "$line" | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p")"
  VERSION_NAME="$(printf '%s\n' "$line" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
  PACKAGE_NAME="$(printf '%s\n' "$line" | sed -n "s/package: name='\([^']*\)'.*/\1/p")"
  [[ "$PACKAGE_NAME" == "$PACKAGE" ]] || { echo "APK package is $PACKAGE_NAME, expected $PACKAGE" >&2; return 1; }
  [[ "$VERSION_CODE" =~ ^[1-9][0-9]*$ && -n "$VERSION_NAME" ]] || { echo "cannot read APK version" >&2; return 1; }
  [[ "$VERSION_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "unsafe versionName: $VERSION_NAME" >&2; return 1; }
  certs="$("$APKSIGNER" verify --print-certs "$path" 2>&1)" || { echo "apksigner failed: $path" >&2; return 1; }
  CERT="$(printf '%s\n' "$certs" | sed -n 's/.*certificate SHA-256 digest: //p' | head -1)"
  [[ "$CERT" == "$BETA_CERT_SHA256" ]] || { echo "APK is not signed by the beta key (got ${CERT:-none})" >&2; return 1; }
  APK_SHA="$(shasum -a 256 "$path" | awk '{print $1}')" || return 1
  [[ "$APK_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "cannot hash APK" >&2; return 1; }
  APK_SIZE="$(wc -c <"$path" | tr -d ' ')" || return 1
  [[ "$APK_SIZE" =~ ^[1-9][0-9]*$ ]] || { echo "cannot size APK" >&2; return 1; }
}

verify_staged() {
  local manifest="$1" apk="$2"
  [[ -f "$apk" ]] || { echo "staged APK missing: $apk" >&2; return 1; }
  apk_meta "$apk" || return 1
  local code name sha size
  code="$(json_field "$manifest" versionCode)" || { echo "staged manifest is unreadable" >&2; return 1; }
  name="$(json_field "$manifest" versionName)" || return 1
  sha="$(json_field "$manifest" sha256)" || return 1
  size="$(json_field "$manifest" size)" || return 1
  [[ "$code" == "$VERSION_CODE" && "$name" == "$VERSION_NAME" ]] || { echo "staged manifest does not match the APK version" >&2; return 1; }
  [[ "$sha" == "$APK_SHA" && "$size" == "$APK_SIZE" ]] || { echo "staged manifest does not match the APK bytes" >&2; return 1; }
}

write_manifest() {
  local path="$1" url_path="$2" code="$3" name="$4" sha="$5" size="$6" commit="$7" dirty="$8"
  python3 - "$path" "$url_path" "$code" "$name" "$sha" "$size" "$NOTES" "$NOTES_ZH" "$commit" "$dirty" <<'PY'
import json, sys, datetime
path, url_path, code, name, sha, size, notes, notes_zh, commit, dirty = sys.argv[1:11]
manifest = {
    "channel": "beta",
    "versionCode": int(code),
    "versionName": name,
    "minSdk": 24,
    "url": url_path,
    "sha256": sha,
    "size": int(size),
    "publishedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "commit": commit,
    "dirty": dirty == "1",
    "notes": notes,
}
if notes_zh:
    manifest["notesZh"] = notes_zh
with open(path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
}

# Read build-time provenance from the signed APK, never from the publishing checkout.
commit=""
dirty=0

# ---------------------------------------------------------------------------
# Legacy channel only: republish the staged build to pairfob.com/dl/android.
# ---------------------------------------------------------------------------
if [[ "$LEGACY_ONLY" == "1" ]]; then
  [[ -f "$STAGE/latest.json" ]] || { echo "no staged manifest at $STAGE/latest.json" >&2; exit 1; }
  staged_url="$(json_field "$STAGE/latest.json" url)" || { echo "staged manifest is unreadable" >&2; exit 1; }
  file_name="$(basename "$staged_url")"
  verify_staged "$STAGE/latest.json" "$STAGE/$file_name" || exit 1
  commit="$(python3 "$ROOT/scripts/android-provenance.py" apk "$STAGE/$file_name")"
  staged_code="$VERSION_CODE"
  staged_name="$VERSION_NAME"
  staged_sha="$APK_SHA"
  staged_size="$APK_SIZE"
  dest_name="pairfob-$staged_name-$staged_code.apk"

  tmp="$(mktemp)"
  rc=0
  fetch_manifest "$RELAY_BASE/latest.json" "$tmp" || rc=$?
  case "$rc" in
    0)
      live_code="$(json_field "$tmp" versionCode)" || { rm -f "$tmp"; echo "live legacy manifest is unreadable" >&2; exit 1; }
      live_sha="$(json_field "$tmp" sha256)" || { rm -f "$tmp"; echo "live legacy manifest is unreadable" >&2; exit 1; }
      valid_code "$live_code" && valid_sha "$live_sha" || { rm -f "$tmp"; echo "live legacy manifest has invalid fields" >&2; exit 1; }
      if (( live_code > staged_code )) || { (( live_code == staged_code )) && [[ "$live_sha" != "$staged_sha" ]]; }; then
        rm -f "$tmp"
        echo "legacy channel has a newer or different build (versionCode $live_code); refusing" >&2
        exit 1
      fi
      ;;
    2) ;;
    *) rm -f "$tmp"; exit 1 ;;
  esac
  rm -f "$tmp"

  mkdir -p "$RELAY_PUBLIC"
  cp "$STAGE/$file_name" "$RELAY_PUBLIC/$dest_name"
  write_manifest "$RELAY_PUBLIC/latest.json" "/dl/android/beta/$dest_name" "$staged_code" "$staged_name" "$staged_sha" "$staged_size" "$commit" "$dirty"
  (cd "$RELAY" && bunx wrangler deploy)

  live="$(curl -fsS --retry 6 --retry-delay 2 --retry-all-errors --max-time 20 "$RELAY_BASE/latest.json?published=$staged_code")"
  live_code="$(printf '%s' "$live" | python3 -c 'import json,sys; print(json.load(sys.stdin)["versionCode"])')"
  live_sha="$(printf '%s' "$live" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha256"])')"
  [[ "$live_code" == "$staged_code" && "$live_sha" == "$staged_sha" ]] || { echo "live legacy manifest mismatch" >&2; exit 1; }
  live_apk_sha="$(curl -fsS --retry 6 --retry-delay 2 --retry-all-errors --max-time 120 "$RELAY_ORIGIN/dl/android/beta/$dest_name" | shasum -a 256 | awk '{print $1}')"
  [[ "$live_apk_sha" == "$staged_sha" ]] || { echo "live legacy APK hash mismatch" >&2; exit 1; }
  echo "legacy relay channel points at $dest_name"
  exit 0
fi

# ---------------------------------------------------------------------------
# New channel publication.
# ---------------------------------------------------------------------------
[[ -f "$APK" ]] || { echo "APK not found: $APK" >&2; exit 1; }
apk_meta "$APK" || exit 1
commit="$(python3 "$ROOT/scripts/android-provenance.py" apk "$APK")"
candidate_code="$VERSION_CODE"
candidate_name="$VERSION_NAME"
candidate_sha="$APK_SHA"
candidate_size="$APK_SIZE"
file_name="pairfob-$candidate_name-$candidate_code.apk"

prev_code=0
prev_sha=""
prev_url=""
prev_origin=""
live_dl_url=""
live_dl_sha=""

consider() {
  local file="$1" origin="$2" code sha url
  code="$(json_field "$file" versionCode)" || { echo "manifest is unreadable: $file" >&2; return 1; }
  sha="$(json_field "$file" sha256)" || { echo "manifest has no sha256: $file" >&2; return 1; }
  url="$(json_field "$file" url)" || { echo "manifest has no url: $file" >&2; return 1; }
  valid_code "$code" || { echo "manifest has an invalid versionCode: $file" >&2; return 1; }
  valid_sha "$sha" || { echo "manifest has an invalid sha256: $file" >&2; return 1; }
  if [[ "$origin" == "$ORIGIN" ]]; then
    [[ "$url" =~ ^/android/beta/[A-Za-z0-9._-]+\.apk$ ]] || { echo "manifest has an invalid download path: $file" >&2; return 1; }
  else
    [[ "$url" =~ ^/dl/android/beta/[A-Za-z0-9._-]+\.apk$ ]] || { echo "manifest has an invalid legacy path: $file" >&2; return 1; }
  fi
  if (( code == prev_code )) && [[ "$sha" != "$prev_sha" ]]; then
    echo "channels disagree at versionCode $code ($file)" >&2
    return 1
  fi
  if (( code > prev_code )); then
    prev_code="$code"
    prev_sha="$sha"
    prev_url="$url"
    prev_origin="$origin"
  fi
}

tmp="$(mktemp)"
rc=0
fetch_manifest "$BASE/latest.json" "$tmp" || rc=$?
case "$rc" in
  0)
    consider "$tmp" "$ORIGIN" || { rm -f "$tmp"; exit 1; }
    live_dl_url="$(json_field "$tmp" url)" || { rm -f "$tmp"; exit 1; }
    live_dl_sha="$(json_field "$tmp" sha256)" || { rm -f "$tmp"; exit 1; }
    ;;
  2) ;;
  *) rm -f "$tmp"; exit 1 ;;
esac
rm -f "$tmp"

tmp="$(mktemp)"
rc=0
fetch_manifest "$RELAY_BASE/latest.json" "$tmp" || rc=$?
case "$rc" in
  0) consider "$tmp" "$RELAY_ORIGIN" || { rm -f "$tmp"; exit 1; } ;;
  2) ;;
  *) rm -f "$tmp"; exit 1 ;;
esac
rm -f "$tmp"

if [[ -f "$STAGE/latest.json" ]]; then
  consider "$STAGE/latest.json" "$ORIGIN" || exit 1
fi


if (( candidate_code < prev_code )); then
  echo "versionCode $candidate_code is lower than published $prev_code; Android would refuse the update" >&2
  exit 1
fi
if (( candidate_code == prev_code )) && [[ "$candidate_sha" != "$prev_sha" ]]; then
  echo "versionCode $candidate_code already exists with different bytes; bump the versionCode" >&2
  exit 1
fi

check_live_download() {
  local out="$1" status code sha
  status="$(curl -sS -o "$out" -w "%{http_code}" --max-time 20 "$BASE/latest.json" || echo 000)"
  case "$status" in
    404) return 0 ;;
    200) ;;
    *) echo "live download manifest check failed ($status)" >&2; return 1 ;;
  esac
  code="$(json_field "$out" versionCode)" || return 1
  sha="$(json_field "$out" sha256)" || return 1
  valid_code "$code" && valid_sha "$sha" || { echo "live download manifest has invalid fields" >&2; return 1; }
  if (( code > candidate_code )) || { (( code == candidate_code )) && [[ "$sha" != "$candidate_sha" ]]; }; then
    echo "live download channel changed to versionCode $code; refusing to overwrite" >&2
    return 1
  fi
}

check_live_legacy() {
  local out="$1" status code sha
  status="$(curl -sS -o "$out" -w "%{http_code}" --max-time 20 "$RELAY_BASE/latest.json" || echo 000)"
  case "$status" in
    404) return 0 ;;
    200) ;;
    *) echo "live legacy manifest check failed ($status)" >&2; return 1 ;;
  esac
  code="$(json_field "$out" versionCode)" || return 1
  sha="$(json_field "$out" sha256)" || return 1
  valid_code "$code" && valid_sha "$sha" || { echo "live legacy manifest has invalid fields" >&2; return 1; }
  if (( code > candidate_code )) || { (( code == candidate_code )) && [[ "$sha" != "$candidate_sha" ]]; }; then
    echo "live legacy channel changed to versionCode $code; refusing to overwrite" >&2
    return 1
  fi
}

tmp="$(mktemp)"
check_live_download "$tmp" || { rm -f "$tmp"; exit 1; }
rm -f "$tmp"

previous_file="$STAGE/previous.json"
retain_code=0
retain_sha=""
retain_url=""
retain_origin=""
if (( candidate_code > prev_code )) && (( prev_code > 0 )); then
  retain_code="$prev_code"
  retain_sha="$prev_sha"
  retain_url="$prev_url"
  retain_origin="$prev_origin"
  python3 - "$previous_file" "$retain_code" "$retain_url" "$retain_sha" "$retain_origin" <<'PY'
import json, sys
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump({
        "versionCode": int(sys.argv[2]),
        "url": sys.argv[3],
        "sha256": sys.argv[4],
        "origin": sys.argv[5],
    }, handle, indent=2)
    handle.write("\n")
PY
elif (( candidate_code == prev_code )) && [[ -f "$previous_file" ]]; then
  retain_code="$(json_field "$previous_file" versionCode)" || { echo "retry metadata is unreadable" >&2; exit 1; }
  retain_sha="$(json_field "$previous_file" sha256)" || exit 1
  retain_url="$(json_field "$previous_file" url)" || exit 1
  retain_origin="$(json_field "$previous_file" origin)" || exit 1
  valid_code "$retain_code" && valid_sha "$retain_sha" || { echo "retry metadata has invalid fields" >&2; exit 1; }
  if (( retain_code >= candidate_code )); then
    echo "retry metadata does not point at an older release" >&2
    exit 1
  fi
fi

# A fresh checkout may not have the daemon files that are live on this Worker.
python3 "$ROOT/scripts/download-channel.py" preserve --channel daemon --require-present --origin "$ORIGIN" \
  --public "$DOWNLOADS/public" --receipt "$other_snapshot"
# The desktop channel is optional until its first release, but a live one must
# survive this deployment; the Worker serves every channel from the same assets.
python3 "$ROOT/scripts/download-channel.py" preserve --channel desktop --origin "$ORIGIN" \
  --public "$DOWNLOADS/public" --receipt "$desktop_snapshot"
mkdir -p "$STAGE" "$DL_PUBLIC"
cp "$APK" "$STAGE/$file_name"
cp "$APK.provenance.json" "$STAGE/$file_name.provenance.json"
write_manifest "$STAGE/latest.json" "/android/beta/$file_name" "$candidate_code" "$candidate_name" "$candidate_sha" "$candidate_size" "$commit" "$dirty"

prev_name="$(basename "${retain_url:-}")"
if [[ -n "$prev_name" && "$prev_name" != "$file_name" ]]; then
  if [[ -f "$STAGE/$prev_name" ]]; then
    if [[ "$(shasum -a 256 "$STAGE/$prev_name" | awk '{print $1}')" != "$retain_sha" ]]; then
      rm -f "$STAGE/$prev_name"
    fi
  fi
  if [[ ! -f "$STAGE/$prev_name" ]]; then
    prev_tmp="$(mktemp)"
    if ! curl -fsS --retry 3 --retry-delay 1 --retry-all-errors --max-time 120 -o "$prev_tmp" "$retain_origin$retain_url"; then
      rm -f "$prev_tmp"
      echo "cannot fetch the previous APK ($retain_origin$retain_url); refusing to publish without it" >&2
      exit 1
    fi
    if [[ "$(shasum -a 256 "$prev_tmp" | awk '{print $1}')" != "$retain_sha" ]]; then
      rm -f "$prev_tmp"
      echo "previous APK hash mismatch; refusing to publish" >&2
      exit 1
    fi
    mv "$prev_tmp" "$STAGE/$prev_name"
  fi
fi

live_name="$(basename "${live_dl_url:-}")"
if [[ -n "$live_name" && "$live_name" != "$file_name" && "$live_name" != "$prev_name" ]]; then
  if [[ -f "$STAGE/$live_name" ]] && [[ "$(shasum -a 256 "$STAGE/$live_name" | awk '{print $1}')" != "$live_dl_sha" ]]; then
    rm -f "$STAGE/$live_name"
  fi
  if [[ ! -f "$STAGE/$live_name" ]]; then
    live_tmp="$(mktemp)"
    if ! curl -fsS --retry 3 --retry-delay 1 --retry-all-errors --max-time 120 -o "$live_tmp" "$ORIGIN$live_dl_url"; then
      rm -f "$live_tmp"
      echo "cannot fetch the currently published APK ($live_dl_url); refusing to publish without it" >&2
      exit 1
    fi
    if [[ "$(shasum -a 256 "$live_tmp" | awk '{print $1}')" != "$live_dl_sha" ]]; then
      rm -f "$live_tmp"
      echo "currently published APK hash mismatch; refusing to publish" >&2
      exit 1
    fi
    mv "$live_tmp" "$STAGE/$live_name"
  fi
fi

for old in "$STAGE"/*.apk; do
  [[ -e "$old" ]] || continue
  name="$(basename "$old")"
  if [[ "$name" != "$file_name" && "$name" != "$prev_name" && "$name" != "$live_name" ]]; then
    rm -f "$old"
  fi
done

rm -rf "$DL_PUBLIC"
mkdir -p "$DL_PUBLIC"
cp -R "$STAGE/." "$DL_PUBLIC/"

echo "staged $candidate_name (versionCode $candidate_code, $candidate_size bytes)"
echo "manifest: $BASE/latest.json"
echo "apk: $BASE/$file_name"
echo "sha256: $candidate_sha"

if [[ "$DEPLOY" != "1" ]]; then
  echo "not deployed; run: (cd workers/pairfob-downloads && bunx wrangler deploy)"
else
  tmp="$(mktemp)"
  check_live_download "$tmp" || { rm -f "$tmp"; exit 1; }
  rm -f "$tmp"

  python3 "$ROOT/scripts/download-channel.py" check --receipt "$other_snapshot"
  python3 "$ROOT/scripts/download-channel.py" check --receipt "$desktop_snapshot"
  (cd "$DOWNLOADS" && bunx wrangler deploy)
  python3 "$ROOT/scripts/download-channel.py" check --receipt "$other_snapshot"
  python3 "$ROOT/scripts/download-channel.py" check --receipt "$desktop_snapshot"

  live="$(curl -fsS --retry 6 --retry-delay 2 --retry-all-errors --max-time 20 "$BASE/latest.json?published=$candidate_code")"
  live_code="$(printf '%s' "$live" | python3 -c 'import json,sys; print(json.load(sys.stdin)["versionCode"])')"
  live_sha="$(printf '%s' "$live" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha256"])')"
  [[ "$live_code" == "$candidate_code" && "$live_sha" == "$candidate_sha" ]] || { echo "live manifest mismatch" >&2; exit 1; }
  live_apk_sha="$(curl -fsS --retry 6 --retry-delay 2 --retry-all-errors --max-time 120 "$BASE/$file_name" | shasum -a 256 | awk '{print $1}')"
  [[ "$live_apk_sha" == "$candidate_sha" ]] || { echo "live APK hash mismatch" >&2; exit 1; }
  echo "verified live manifest and APK hash on $ORIGIN"
fi

if [[ "$LEGACY_RELAY" == "1" ]]; then
  tmp="$(mktemp)"
  check_live_legacy "$tmp" || { rm -f "$tmp"; exit 1; }
  rm -f "$tmp"
  mkdir -p "$RELAY_PUBLIC"
  cp "$APK" "$RELAY_PUBLIC/$file_name"
  write_manifest "$RELAY_PUBLIC/latest.json" "/dl/android/beta/$file_name" "$candidate_code" "$candidate_name" "$candidate_sha" "$candidate_size" "$commit" "$dirty"
  (cd "$RELAY" && bunx wrangler deploy)

  legacy="$(curl -fsS --retry 6 --retry-delay 2 --retry-all-errors --max-time 20 "$RELAY_BASE/latest.json?published=$candidate_code")"
  legacy_code="$(printf '%s' "$legacy" | python3 -c 'import json,sys; print(json.load(sys.stdin)["versionCode"])')"
  legacy_sha="$(printf '%s' "$legacy" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha256"])')"
  [[ "$legacy_code" == "$candidate_code" && "$legacy_sha" == "$candidate_sha" ]] || { echo "legacy relay manifest mismatch" >&2; exit 1; }
  echo "updated the legacy relay channel once; future publishes need no relay deploy"
fi
