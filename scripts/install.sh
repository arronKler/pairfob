#!/bin/sh
# Install pairfob from https://pairfob.com/dl (or $PAIRFOB_DOWNLOAD_BASE).
set -eu

usage() {
  cat <<'EOF'
usage: install.sh [--origin URL] [--prefix DIR] [--no-service] [--no-enroll] [--install-herdr] [--non-interactive] [--skip-herdr-check]

Downloads the pairfob binary for this machine, verifies SHA-256, enrolls
against pairfob.com (or --origin), and installs a user-level service that
starts at login.

  --install-herdr     Install pinned Herdr if missing (no prompt)
  --non-interactive   Never prompt; missing Herdr fails unless --install-herdr
  --skip-herdr-check  Install Pairfob only; does not claim session readiness

  curl -fsSL https://pairfob.com/install.sh | sh
EOF
}

ORIGIN=""
PREFIX="${PAIRFOB_INSTALL_PREFIX:-}"
NO_SERVICE=0
NO_ENROLL=0
INSTALL_HERDR=0
NON_INTERACTIVE=0
SKIP_HERDR_CHECK=0
BASE="${PAIRFOB_DOWNLOAD_BASE:-https://pairfob.com/dl}"
BASE="${BASE%/}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --grant | --grant=*)
      echo "install.sh: this setup does not use a join grant" >&2
      exit 1
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
    --install-herdr) INSTALL_HERDR=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --skip-herdr-check) SKIP_HERDR_CHECK=1; shift ;;
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
name="pairfob-${os}-${arch}"

# Match the login service's startup directory, while preserving relative prefixes.
case "$PREFIX" in
  "" | /*) ;;
  *) PREFIX="$(pwd)/$PREFIX" ;;
esac
cd "$HOME"

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

# Check with the verified new CLI before replacing binaries or services.
if [ "$SKIP_HERDR_CHECK" -eq 0 ]; then
  set --
  if [ "$INSTALL_HERDR" -eq 1 ]; then set -- "$@" --install-herdr; fi
  if [ "$NON_INTERACTIVE" -eq 1 ]; then set -- "$@" --non-interactive; fi
  "${workdir}/${name}" setup "$@" || {
    echo "Setup incomplete: Herdr is not ready. Existing Pairfob installation was preserved." >&2
    exit 1
  }
fi

mkdir -p "$PREFIX"
dest="${PREFIX}/pairfob"
legacy="${PREFIX}/pairfobd"

# One lock covers preflight, file replacement, enroll and service readiness.
"${workdir}/${name}" service with-install-lock sh -s -- "$workdir" "$name" "$dest" "$legacy" "$NO_SERVICE" "$NO_ENROLL" "$ORIGIN" "$SKIP_HERDR_CHECK" <<'INSTALL_TRANSACTION'
set -eu
workdir="$1" name="$2" dest="$3" legacy="$4"
NO_SERVICE="$5" NO_ENROLL="$6" ORIGIN="$7" SKIP_HERDR_CHECK="$8"

# A reinstall is also the supported migration from the pre-release pairfobd
# command. The verified new binary owns cleanup, so an older uninstaller cannot
# silently leave a running service behind before its executable is replaced.
if [ -x "$legacy" ] && [ ! -L "$legacy" ]; then
  "${workdir}/${name}" service migrate-legacy
fi
"${workdir}/${name}" service prepare-install "$dest"

mv "${workdir}/${name}" "$dest"
chmod 0755 "$dest"
ln -s pairfob "${workdir}/pairfobd"
mv -f "${workdir}/pairfobd" "$legacy"
echo "installed ${dest}"

if [ "$NO_ENROLL" -eq 0 ]; then
  set --
  if [ -n "$ORIGIN" ]; then
    set -- "$@" --origin "$ORIGIN"
  fi
  "$dest" enroll "$@"
fi

if [ "$NO_SERVICE" -eq 0 ]; then
  "$dest" service install
  if [ "$SKIP_HERDR_CHECK" -eq 0 ]; then
    "$dest" doctor || { echo "Setup incomplete: run pairfob doctor." >&2; exit 1; }
    echo "Pairfob and Herdr are ready."
  else
    echo "Pairfob is running; Herdr readiness was not checked."
  fi
else
  "$dest" service uninstall
fi
INSTALL_TRANSACTION

case ":${PATH}:" in
  *":${PREFIX}:"*) ;;
  *)
    echo "Add ${PREFIX} to PATH, then:"
    ;;
esac

if [ "$SKIP_HERDR_CHECK" -eq 1 ] || [ "$NO_SERVICE" -eq 1 ]; then
  echo "Installation complete; session setup is not verified. Run pairfob setup, start Pairfob, then run pairfob doctor before pairing."
  exit 0
fi

echo "On this computer:     pairfob pair"
echo "On the other device:  https://pairfob.com/pair"
echo "Scan or type the code, then press Enter here."
