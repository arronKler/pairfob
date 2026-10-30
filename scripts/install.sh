#!/bin/sh
# Install pairfob from https://dl.pairfob.com/daemon (or $PAIRFOB_DOWNLOAD_BASE).
set -eu

usage() {
  cat <<'EOF'
usage: install.sh [--origin URL] [--prefix DIR] [--runtime auto|herdr|core] [--no-service] [--no-enroll] [--no-install-herdr] [--non-interactive] [--skip-runtime-check]

Downloads the pairfob binary for this machine, verifies SHA-256, enrolls
against pairfob.com (or --origin), and installs a user-level service that
starts at login.

  --runtime MODE      auto (default) uses Herdr when it is present, otherwise
                      herdr-core. herdr installs and checks Herdr. core uses
                      the hc client and never installs Herdr.
  Missing Herdr is installed automatically when the selected runtime is Herdr.
  --install-herdr     Compatibility alias for the default Herdr installation behavior
  --no-install-herdr  Fail if Herdr is missing; do not download it
  --non-interactive   Never prompt; missing Herdr is still installed by default
  --skip-runtime-check
                      Install Pairfob only; runtime readiness is not checked
  --skip-herdr-check  Alias for --skip-runtime-check

  curl -fsSL https://pairfob.com/install.sh | sh
EOF
}

ORIGIN=""
PREFIX="${PAIRFOB_INSTALL_PREFIX:-}"
NO_SERVICE=0
NO_ENROLL=0
INSTALL_HERDR=0
NO_INSTALL_HERDR=0
NON_INTERACTIVE=0
SKIP_RUNTIME_CHECK=0
RUNTIME="auto"
RUNTIME_KIND=""
HC=""
BASE="${PAIRFOB_DOWNLOAD_BASE:-https://dl.pairfob.com/daemon}"
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
    --no-install-herdr) NO_INSTALL_HERDR=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --runtime)
      [ "$#" -ge 2 ] || { echo "install.sh: --runtime needs a value" >&2; exit 1; }
      RUNTIME="$2"
      shift 2
      ;;
    --runtime=*)
      RUNTIME="${1#--runtime=}"
      shift
      ;;
    --skip-runtime-check | --skip-herdr-check) SKIP_RUNTIME_CHECK=1; shift ;;
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

if [ "$INSTALL_HERDR" -eq 1 ] && [ "$NO_INSTALL_HERDR" -eq 1 ]; then
  echo "install.sh: --install-herdr conflicts with --no-install-herdr" >&2
  exit 1
fi
case "$RUNTIME" in
  auto | herdr | core) ;;
  *)
    echo "install.sh: --runtime must be auto, herdr, or core" >&2
    exit 1
    ;;
esac
if [ "$RUNTIME" = core ] && { [ "$INSTALL_HERDR" -eq 1 ] || [ "$NO_INSTALL_HERDR" -eq 1 ]; }; then
  echo "install.sh: --install-herdr and --no-install-herdr apply only to the Herdr runtime; use --runtime herdr" >&2
  exit 1
fi

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

json_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
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

# pairfob-chat is optional. A release that predates it, or a channel that lists
# it before the binary is uploaded, must not fail the daemon installation.
chat_name="pairfob-chat-${os}-${arch}"
chat_dest="${PREFIX}/pairfob-chat"
chat_src=""
if chat_want="$(sums_hash "$chat_name" <"${workdir}/SHA256SUMS")"; then
  echo "downloading ${chat_name} from ${BASE}"
  if curl -fsSL "${BASE}/${chat_name}" -o "${workdir}/${chat_name}"; then
    if [ "$(file_sha256 "${workdir}/${chat_name}")" = "$chat_want" ]; then
      chmod 0755 "${workdir}/${chat_name}"
      chat_src="${workdir}/${chat_name}"
    else
      rm -f "${workdir}/${chat_name}"
      echo "warning: ${chat_name} failed SHA-256 verification; installing pairfob without chat" >&2
    fi
  else
    rm -f "${workdir}/${chat_name}"
    echo "warning: ${chat_name} is listed in SHA256SUMS but not downloadable; installing pairfob without chat" >&2
  fi
else
  echo "warning: this release does not include ${chat_name}; installing pairfob without chat" >&2
fi

# Resolve the terminal runtime before setup and the login service so both use
# the same concrete choice. Resolution is not a readiness check, so it also runs
# when --skip-runtime-check is set. Herdr files are only prepared when checks are
# enabled; an explicit --runtime is always persisted.
runtime_json=""
if [ "$RUNTIME" != auto ]; then
  RUNTIME_KIND="$RUNTIME"
else
  runtime_selected=0
  if runtime_json="$("${workdir}/${name}" runtime --json 2>"${workdir}/runtime.err")"; then
    case "$(json_field "$runtime_json" kind)" in
      herdr) RUNTIME_KIND=herdr; runtime_selected=1 ;;
      herdr-core | core) RUNTIME_KIND=core; runtime_selected=1 ;;
    esac
  fi
  if [ "$runtime_selected" -eq 0 ]; then
    runtime_error="$(sed -n '1p' "${workdir}/runtime.err" 2>/dev/null)"
    if [ "$SKIP_RUNTIME_CHECK" -eq 1 ]; then
      echo "install.sh: the runtime was not resolved (${runtime_error:-no selection}); it will be detected when the service starts"
      RUNTIME_KIND=""
    else
      case "$runtime_error" in
        *"no terminal runtime found"*)
          echo "install.sh: ${runtime_error}"
          echo "install.sh: preparing Herdr, which setup installs when it is missing"
          RUNTIME_KIND=herdr
          ;;
        *)
          if [ -n "$runtime_json" ]; then
            echo "install.sh: pairfob runtime returned an unknown selection: ${runtime_json}" >&2
          else
            echo "install.sh: pairfob runtime failed: ${runtime_error:-no output}" >&2
          fi
          exit 1
          ;;
      esac
    fi
  fi
fi
if [ "$RUNTIME_KIND" = core ]; then
  if [ "$INSTALL_HERDR" -eq 1 ] || [ "$NO_INSTALL_HERDR" -eq 1 ]; then
    echo "install.sh: --install-herdr and --no-install-herdr apply only to the Herdr runtime; this install uses herdr-core" >&2
    exit 1
  fi
  hc_command="${PAIRFOB_HC:-}"
  if [ -z "$hc_command" ]; then
    hc_command=hc
  fi
  hc_path="$(command -v "$hc_command" 2>/dev/null || true)"
  if [ -z "$hc_path" ]; then
    echo "install.sh: --runtime core needs herdr-core (hc) on PATH; install hc, or use --runtime herdr" >&2
    exit 1
  fi
  case "$hc_path" in
    /*) ;;
    *) hc_path="$(cd "$(dirname "$hc_path")" && pwd)/$(basename "$hc_path")" ;;
  esac
  HC="$hc_path"
  export PAIRFOB_RUNTIME=core
  export PAIRFOB_HC="$HC"
elif [ "$RUNTIME_KIND" = herdr ]; then
  export PAIRFOB_RUNTIME=herdr
fi

# Check with the verified new CLI before replacing binaries or services.
if [ "$SKIP_RUNTIME_CHECK" -eq 0 ]; then
  set --
  if [ "$RUNTIME_KIND" = herdr ]; then
    if [ "$INSTALL_HERDR" -eq 1 ]; then set -- "$@" --install-herdr; fi
    if [ "$NO_INSTALL_HERDR" -eq 1 ]; then set -- "$@" --no-install-herdr; fi
    if [ "$NON_INTERACTIVE" -eq 1 ]; then set -- "$@" --non-interactive; fi
  fi
  "${workdir}/${name}" setup "$@" || {
    if [ "$RUNTIME_KIND" = core ]; then
      echo "Setup incomplete: herdr-core is not ready. Existing Pairfob installation was preserved." >&2
    else
      echo "Setup incomplete: Herdr is not ready. Existing Pairfob installation was preserved." >&2
    fi
    exit 1
  }
fi

mkdir -p "$PREFIX"
dest="${PREFIX}/pairfob"
legacy="${PREFIX}/pairfobd"

# One lock covers preflight, file replacement, enroll and service readiness.
"${workdir}/${name}" service with-install-lock sh -s -- "$workdir" "$name" "$dest" "$legacy" "$NO_SERVICE" "$NO_ENROLL" "$ORIGIN" "$SKIP_RUNTIME_CHECK" "$chat_src" "$chat_dest" <<'INSTALL_TRANSACTION'
set -eu
workdir="$1" name="$2" dest="$3" legacy="$4"
NO_SERVICE="$5" NO_ENROLL="$6" ORIGIN="$7" SKIP_RUNTIME_CHECK="$8"
chat_src="$9" chat_dest="${10}"

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

if [ -n "$chat_src" ]; then
  if mv "$chat_src" "$chat_dest" && chmod 0755 "$chat_dest"; then
    echo "installed ${chat_dest}"
  else
    echo "install.sh: pairfob-chat was not installed; continuing without chat" >&2
  fi
fi

if [ "$NO_ENROLL" -eq 0 ]; then
  set --
  if [ -n "$ORIGIN" ]; then
    set -- "$@" --origin "$ORIGIN"
  fi
  "$dest" enroll "$@"
fi

if [ "$NO_SERVICE" -eq 0 ]; then
  "$dest" service install
  if [ "$SKIP_RUNTIME_CHECK" -eq 0 ]; then
    "$dest" doctor || { echo "Setup incomplete: run pairfob doctor." >&2; exit 1; }
    echo "Pairfob is ready."
  else
    echo "Pairfob is running; runtime readiness was not checked."
  fi
else
  "$dest" service uninstall
fi
INSTALL_TRANSACTION

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}
pairfob_command=pairfob
case ":${PATH}:" in
  *":${PREFIX}:"*) ;;
  *)
    pairfob_command="$(shell_quote "$dest")"
    echo "For future terminals, add this directory to PATH: ${PREFIX}"
    ;;
esac

if [ "$SKIP_RUNTIME_CHECK" -eq 1 ] || [ "$NO_SERVICE" -eq 1 ]; then
  echo "Installation complete; runtime setup is not verified. Run ${pairfob_command} setup, start Pairfob, then run ${pairfob_command} doctor before pairing."
  exit 0
fi

echo "Next: ${pairfob_command} pair"
echo "On this computer, a phone or a tablet: https://pairfob.com/pair"
echo "Scan or type the code, then press Enter here."
if [ "$RUNTIME_KIND" = core ]; then
  hc_display=hc
  if [ -n "$HC" ]; then
    case ":${PATH}:" in
      *":$(dirname "$HC"):"*) ;;
      *) hc_display="$(shell_quote "$HC")" ;;
    esac
  fi
  echo "Local terminal: ${hc_display} run --bg claude"
  echo "Heads up: your phone sees terminals started with \`hc run\`. A \`claude\` you open in another terminal won't show up."
  exit 0
fi
if [ -n "${HERDR_BIN:-}" ]; then
  herdr_command="$(shell_quote "$HERDR_BIN")"
elif command -v herdr >/dev/null 2>&1; then
  herdr_command=herdr
else
  herdr_command="$(shell_quote "$HOME/.local/bin/herdr")"
fi
if [ -n "${HERDR_SOCKET_PATH:-}" ]; then
  herdr_command="HERDR_SOCKET_PATH=$(shell_quote "$HERDR_SOCKET_PATH") ${herdr_command}"
fi
echo "Local terminal: ${herdr_command}"
echo "Runtime updates: ${pairfob_command} setup --update-herdr"
echo "Heads up: your phone sees sessions started from the phone or inside \`herdr\`. A \`claude\` you open in another terminal won't show up."
