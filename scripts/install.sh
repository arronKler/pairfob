#!/bin/sh
# Install pairfobd from https://pairfob.com/dl (or $PAIRFOB_DOWNLOAD_BASE).
set -eu

usage() {
  cat <<'EOF'
usage: install.sh [--origin URL] [--prefix DIR] [--grant jg_…] [--no-service] [--no-enroll]

Downloads the pairfobd binary for this machine, verifies SHA-256, enrolls
against pairfob.com (or --origin), and installs a user-level service that
starts at login.

  curl -fsSL https://pairfob.com/install.sh | sh
EOF
}

GRANT=""
ORIGIN=""
PREFIX="${PAIRFOB_INSTALL_PREFIX:-}"
NO_SERVICE=0
NO_ENROLL=0
BASE="${PAIRFOB_DOWNLOAD_BASE:-https://pairfob.com/dl}"
BASE="${BASE%/}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --grant)
      [ "$#" -ge 2 ] || { echo "install.sh: --grant needs a value" >&2; exit 1; }
      GRANT="$2"
      shift 2
      ;;
    --grant=*)
      GRANT="${1#--grant=}"
      shift
      ;;
    --origin)
      [ "$#" -ge 2 ] || { echo "install.sh: --origin needs a value" >&2; exit 1; }
      ORIGIN="$2"
      shift 2
      ;;
    --origin=*)
      ORIGIN="${1#--origin=}"
      shift
      ;;
    --prefix)
      [ "$#" -ge 2 ] || { echo "install.sh: --prefix needs a value" >&2; exit 1; }
      PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      PREFIX="${1#--prefix=}"
      shift
      ;;
    --no-service)
      NO_SERVICE=1
      shift
      ;;
    --no-enroll)
      NO_ENROLL=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "install.sh: unknown argument $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *)
    echo "install.sh: unsupported OS $(uname -s)" >&2
    exit 1
    ;;
esac
case "$arch" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *)
    echo "install.sh: unsupported architecture $(uname -m)" >&2
    exit 1
    ;;
esac
name="pairfobd-${os}-${arch}"

if [ -z "$PREFIX" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    PREFIX=/usr/local/bin
  elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    PREFIX=/usr/local/bin
  else
    PREFIX="${HOME}/.local/bin"
  fi
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "install.sh: missing $1" >&2
    exit 1
  }
}
need curl
need mktemp

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sums_hash() {
  awk -v name="$1" '
    $2 == name || $2 == ("*" name) { print $1; found=1 }
    END { if (!found) exit 1 }
  '
}

workdir="$(mktemp -d "${TMPDIR:-/tmp}/pairfob-install.XXXXXX")"
cleanup() { rm -rf "$workdir"; }
trap cleanup 0

echo "downloading ${name} from ${BASE}"
curl -fsSL "${BASE}/SHA256SUMS" -o "${workdir}/SHA256SUMS"
curl -fsSL "${BASE}/${name}" -o "${workdir}/${name}"
want="$(sums_hash "$name" <"${workdir}/SHA256SUMS")"
got="$(file_sha256 "${workdir}/${name}")"
if [ "$want" != "$got" ]; then
  echo "install.sh: SHA-256 mismatch for ${name}" >&2
  exit 1
fi
chmod 0755 "${workdir}/${name}"

mkdir -p "$PREFIX"
dest="${PREFIX}/pairfobd"
mv "${workdir}/${name}" "$dest"
chmod 0755 "$dest"
echo "installed ${dest}"

if [ "$NO_ENROLL" -eq 0 ]; then
  set --
  if [ -n "$GRANT" ]; then
    set -- "$@" --grant "$GRANT"
  fi
  if [ -n "$ORIGIN" ]; then
    set -- "$@" --origin "$ORIGIN"
  fi
  "$dest" enroll "$@"
fi

if [ "$NO_SERVICE" -eq 0 ]; then
  "$dest" service install
  echo "waiting for pairfobd…"
  ok=0
  attempt=0
  while [ "$attempt" -lt 40 ]; do
    if "$dest" pair status >/dev/null 2>&1; then
      ok=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  if [ "$ok" -eq 1 ]; then
    echo "Pairfob is running."
  else
    echo "Installed, but not answering yet. Check ~/.config/pairfob/pairfobd.log" >&2
  fi
fi

case ":${PATH}:" in
  *":${PREFIX}:"*) ;;
  *)
    echo "Add ${PREFIX} to PATH, then:"
    ;;
esac

echo "On this computer:     pairfobd pair"
echo "On the other device:  https://pairfob.com/pair"
echo "Scan or type the code, then press Enter here."
