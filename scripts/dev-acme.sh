#!/usr/bin/env bash
# Obtain or renew a public certificate for Pairfob LAN development via DNS-01.
set -euo pipefail

LEGO_VERSION="v5.4.1"

usage() {
  echo "usage: PAIRFOB_ACME_DNS=<provider> PAIRFOB_ACME_EMAIL=<email> $0 <domain> <store>" >&2
  echo "providers: cloudflare, route53, alidns, tencentcloud, huaweicloud, digitalocean" >&2
}

valid_domain() {
  local domain="$1"
  local label
  local labels
  [[ ${#domain} -le 253 && "$domain" == *.* ]] || return 1
  IFS='.' read -r -a labels <<<"$domain"
  for label in "${labels[@]}"; do
    [[ ${#label} -ge 1 && ${#label} -le 63 ]] || return 1
    [[ "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
}

resolve_lego() {
  local configured="${PAIRFOB_ACME_LEGO:-}"
  local resolved
  if [[ -n "$configured" ]]; then
    resolved="$(command -v "$configured" 2>/dev/null || true)"
    if [[ -z "$resolved" ]]; then
      echo "PAIRFOB_ACME_LEGO is not executable: $configured" >&2
      return 1
    fi
    printf '%s\n' "$resolved"
    return 0
  fi

  resolved="$(command -v lego 2>/dev/null || true)"
  if [[ -n "$resolved" ]]; then
    printf '%s\n' "$resolved"
    return 0
  fi

  local tool_dir="$1"
  local installed="$tool_dir/lego"
  if [[ ! -x "$installed" ]]; then
    local os
    local arch
    local asset
    local expected_sha
    local archive
    local actual_sha
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    case "$(uname -m)" in
      x86_64|amd64) arch="amd64" ;;
      arm64|aarch64) arch="arm64" ;;
      *) echo "no pinned lego build for $(uname -s)/$(uname -m); set PAIRFOB_ACME_LEGO" >&2; return 1 ;;
    esac
    asset="lego_${LEGO_VERSION}_${os}_${arch}.tar.gz"
    case "${os}/${arch}" in
      darwin/amd64) expected_sha="c8bf56febdd5fb64c93d5d15fa152bb7e07bc9c56319c0c45578c5e97638ce1b" ;;
      darwin/arm64) expected_sha="afdce643d3defe95c637874efc7d993cc098f1e846d5f590667f6f51b05fa186" ;;
      linux/amd64) expected_sha="ebb33f1bead5a7c99dd46f1c5734b44cf1eab5b5c12faf397cd14d50a5916419" ;;
      linux/arm64) expected_sha="8494c06bde449ac4d65c726b7ea50d67ac61f422e698c9b78b47778445b098f2" ;;
      *) echo "no pinned lego build for ${os}/${arch}; set PAIRFOB_ACME_LEGO" >&2; return 1 ;;
    esac
    command -v curl >/dev/null 2>&1 || { echo "ACME LAN needs curl to install lego" >&2; return 1; }
    command -v tar >/dev/null 2>&1 || { echo "ACME LAN needs tar to install lego" >&2; return 1; }
    mkdir -p "$tool_dir"
    archive="$tool_dir/.${asset}.download"
    echo "downloading lego ${LEGO_VERSION} for ${os}/${arch} (first ACME run only)..." >&2
    curl -fsSL --retry 3 --retry-delay 1 \
      "https://github.com/go-acme/lego/releases/download/${LEGO_VERSION}/${asset}" \
      -o "$archive"
    actual_sha="$(openssl dgst -sha256 "$archive" | awk '{print $NF}')"
    if [[ "$actual_sha" != "$expected_sha" ]]; then
      rm -f "$archive"
      echo "lego archive checksum mismatch" >&2
      return 1
    fi
    tar -xzf "$archive" -C "$tool_dir" lego
    rm -f "$archive"
    chmod 755 "$installed"
  fi
  printf '%s\n' "$installed"
}

cert_matches_key() {
  local cert="$1"
  local key="$2"
  local cert_pub
  local key_pub
  cert_pub="$(openssl x509 -in "$cert" -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | openssl dgst -sha256 2>/dev/null)" || return 1
  key_pub="$(openssl pkey -in "$key" -pubout -outform DER 2>/dev/null \
    | openssl dgst -sha256 2>/dev/null)" || return 1
  [[ -n "$cert_pub" && "$cert_pub" == "$key_pub" ]]
}

main() {
if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

DOMAIN="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
STORE="$2"
PROVIDER="${PAIRFOB_ACME_DNS:-}"
EMAIL="${PAIRFOB_ACME_EMAIL:-}"
RENEW_DAYS="${PAIRFOB_ACME_RENEW_DAYS:-30}"

valid_domain "$DOMAIN" || {
  echo "PAIRFOB_ACME_DOMAIN must be a public DNS hostname, not an IP: $DOMAIN" >&2
  exit 2
}
case "$PROVIDER" in
  cloudflare|route53|alidns|tencentcloud|huaweicloud|digitalocean) ;;
  *) usage; echo "unsupported PAIRFOB_ACME_DNS: ${PROVIDER:-<empty>}" >&2; exit 2 ;;
esac
if [[ "$EMAIL" != *@* || "$EMAIL" == *[[:space:]]* ]]; then
  echo "PAIRFOB_ACME_EMAIL must be a valid ACME recovery email" >&2
  exit 2
fi
if [[ ! "$RENEW_DAYS" =~ ^[0-9]+$ || "$RENEW_DAYS" -lt 1 || "$RENEW_DAYS" -gt 89 ]]; then
  echo "PAIRFOB_ACME_RENEW_DAYS must be between 1 and 89" >&2
  exit 2
fi
command -v openssl >/dev/null 2>&1 || {
  echo "ACME LAN needs openssl to validate the certificate" >&2
  exit 1
}

mkdir -p "$STORE"
chmod 700 "$STORE"
umask 077
CERT="$STORE/certificates/${DOMAIN}.crt"
KEY="$STORE/certificates/${DOMAIN}.key"
META="$STORE/certificates/${DOMAIN}.json"
CHECK_SECONDS=$((RENEW_DAYS * 86400))

if [[ -s "$CERT" && -s "$KEY" ]] \
  && openssl x509 -in "$CERT" -noout -checkend "$CHECK_SECONDS" >/dev/null 2>&1 \
  && cert_matches_key "$CERT" "$KEY"; then
  echo "reusing ACME certificate for $DOMAIN (valid for more than ${RENEW_DAYS}d)"
  exit 0
fi

TOOL_DIR="$(dirname "$STORE")/tools"
LEGO="$(resolve_lego "$TOOL_DIR")"
LEGO_ARGS=(
  run
  --accept-tos
  --email "$EMAIL"
  --path "$STORE"
  --dns "$PROVIDER"
  --domains "$DOMAIN"
  --user-agent "pairfob-dev-acme"
)
if [[ -s "$CERT" && -s "$META" && -d "$STORE/accounts" ]]; then
  echo "renewing ACME certificate for $DOMAIN via $PROVIDER..."
else
  echo "requesting ACME certificate for $DOMAIN via $PROVIDER..."
fi
"$LEGO" "${LEGO_ARGS[@]}" --renew-days "$RENEW_DAYS" --ari-disable --no-random-sleep

if [[ ! -s "$CERT" || ! -s "$KEY" ]]; then
  echo "lego completed without the expected certificate files for $DOMAIN" >&2
  exit 1
fi
if ! openssl x509 -in "$CERT" -noout -checkend 0 >/dev/null 2>&1; then
  echo "ACME certificate is invalid or expired: $CERT" >&2
  exit 1
fi
if ! cert_matches_key "$CERT" "$KEY"; then
  echo "ACME certificate and private key do not match" >&2
  exit 1
fi
chmod 644 "$CERT"
chmod 600 "$KEY"
echo "ACME certificate ready for $DOMAIN"
}

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  main "$@"
fi
