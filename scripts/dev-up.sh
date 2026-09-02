#!/usr/bin/env bash
# Start a local pairfob.v2 origin (workerd) + pairfob for pairing tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="$ROOT/.dev"
ORIGIN_DIR="$ROOT/workers/pairfob-origin"
mkdir -p "$DEV"
cd "$ROOT"

if [[ -f "$DEV/origin.pid" ]] && kill -0 "$(cat "$DEV/origin.pid")" 2>/dev/null; then
  echo "already running (origin pid $(cat "$DEV/origin.pid")). scripts/dev-down.sh first."
  exit 1
fi

ACME_DOMAIN="$(printf '%s' "${PAIRFOB_ACME_DOMAIN:-}" | tr '[:upper:]' '[:lower:]')"
if [[ -n "$ACME_DOMAIN" && -z "${PAIRFOB_LISTEN:-}" ]]; then
  LISTEN="0.0.0.0:18786"
else
  LISTEN="${PAIRFOB_LISTEN:-127.0.0.1:18786}"
fi
HOST="${LISTEN%:*}"
PORT="${LISTEN##*:}"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
if [[ -n "$ACME_DOMAIN" && ( "$HOST" == "127.0.0.1" || "$HOST" == "localhost" ) ]]; then
  echo "PAIRFOB_ACME_DOMAIN needs a LAN listener; use PAIRFOB_LISTEN=0.0.0.0:${PORT}" >&2
  exit 1
fi
if [[ -n "$ACME_DOMAIN" && -z "${PAIRFOB_ORIGIN:-}" ]]; then
  PAIRFOB_ORIGIN="https://${ACME_DOMAIN}:${PORT}"
fi
if [[ "$HOST" == "0.0.0.0" || "$HOST" == "::" ]]; then
  if [[ -z "${PAIRFOB_ORIGIN:-}" ]]; then
    if [[ -z "$LAN_IP" ]]; then
      echo "PAIRFOB_LISTEN=$LISTEN needs PAIRFOB_ORIGIN (no LAN IPv4 found)" >&2
      exit 1
    fi
    PAIRFOB_ORIGIN="https://${LAN_IP}:${PORT}"
  fi
fi
ORIGIN_URL="${PAIRFOB_ORIGIN:-http://${LISTEN}}"
ORIGIN_URL="${ORIGIN_URL%/}"
PERSIST="$DEV/wrangler"
VARS="$ORIGIN_DIR/.dev.vars"
TLS_DIR="$DEV/tls"
ACME_STORE="$DEV/acme"
HTTPS_ARGS=(--local)
CURL_ARGS=(-sf)
TLS_MODE="http"

origin_scheme="${ORIGIN_URL%%://*}"
if [[ -n "$ACME_DOMAIN" && "$origin_scheme" != "https" ]]; then
  echo "PAIRFOB_ACME_DOMAIN requires an https PAIRFOB_ORIGIN" >&2
  exit 1
fi
if [[ "$origin_scheme" == "https" ]]; then
  origin_host="${ORIGIN_URL#https://}"
  origin_host="${origin_host%%[:/]*}"
  if [[ -n "$ACME_DOMAIN" ]]; then
    TLS_MODE="acme"
    normalized_origin_host="$(printf '%s' "$origin_host" | tr '[:upper:]' '[:lower:]')"
    if [[ "$normalized_origin_host" != "$ACME_DOMAIN" ]]; then
      echo "PAIRFOB_ORIGIN host must match PAIRFOB_ACME_DOMAIN ($ACME_DOMAIN)" >&2
      exit 1
    fi

    expected_ip="$HOST"
    if [[ "$HOST" == "0.0.0.0" || "$HOST" == "::" ]]; then
      if [[ -z "$LAN_IP" ]]; then
        echo "ACME LAN mode could not find a LAN IPv4 address on en0 or en1" >&2
        exit 1
      fi
      expected_ip="$LAN_IP"
    fi
    if [[ "${PAIRFOB_ACME_SKIP_DNS_CHECK:-0}" != "1" ]]; then
      resolved_ipv4=""
      dns_tool=""
      if command -v dscacheutil >/dev/null 2>&1; then
        dns_tool="dscacheutil"
        resolved_ipv4="$(dscacheutil -q host -a name "$ACME_DOMAIN" | awk '$1 == "ip_address:" {print $2}')"
      elif command -v getent >/dev/null 2>&1; then
        dns_tool="getent"
        resolved_ipv4="$(getent ahostsv4 "$ACME_DOMAIN" | awk '{print $1}' | sort -u)"
      elif command -v dig >/dev/null 2>&1; then
        dns_tool="dig"
        resolved_ipv4="$(dig +short A "$ACME_DOMAIN")"
      fi
      if [[ -n "$dns_tool" ]] && ! grep -Fxq "$expected_ip" <<<"$resolved_ipv4"; then
        echo "$ACME_DOMAIN must resolve to this LAN address: $expected_ip" >&2
        echo "current IPv4 answers: ${resolved_ipv4:-<none>}" >&2
        echo "use a DNS-only A record; set PAIRFOB_ACME_SKIP_DNS_CHECK=1 only for split DNS" >&2
        exit 1
      elif [[ -z "$dns_tool" ]]; then
        echo "warning: no DNS lookup tool; cannot verify $ACME_DOMAIN -> $expected_ip" >&2
      fi
    fi

    "$ROOT/scripts/dev-acme.sh" "$ACME_DOMAIN" "$ACME_STORE"
    case "${PAIRFOB_ACME_DNS}" in
      cloudflare)
        unset CF_API_EMAIL CF_API_KEY CF_DNS_API_TOKEN CF_ZONE_API_TOKEN \
          CF_API_EMAIL_FILE CF_API_KEY_FILE CF_DNS_API_TOKEN_FILE CF_ZONE_API_TOKEN_FILE \
          CLOUDFLARE_EMAIL CLOUDFLARE_API_KEY CLOUDFLARE_DNS_API_TOKEN CLOUDFLARE_ZONE_API_TOKEN \
          CLOUDFLARE_EMAIL_FILE CLOUDFLARE_API_KEY_FILE CLOUDFLARE_DNS_API_TOKEN_FILE CLOUDFLARE_ZONE_API_TOKEN_FILE || true
        ;;
      route53)
        unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_WEB_IDENTITY_TOKEN_FILE || true
        ;;
      alidns)
        unset ALICLOUD_ACCESS_KEY ALICLOUD_SECRET_KEY ALICLOUD_SECURITY_TOKEN \
          ALICLOUD_ACCESS_KEY_FILE ALICLOUD_SECRET_KEY_FILE ALICLOUD_SECURITY_TOKEN_FILE || true
        ;;
      tencentcloud)
        unset TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TENCENTCLOUD_SESSION_TOKEN \
          TENCENTCLOUD_SECRET_ID_FILE TENCENTCLOUD_SECRET_KEY_FILE TENCENTCLOUD_SESSION_TOKEN_FILE || true
        ;;
      huaweicloud)
        unset HUAWEICLOUD_ACCESS_KEY_ID HUAWEICLOUD_SECRET_ACCESS_KEY \
          HUAWEICLOUD_ACCESS_KEY_ID_FILE HUAWEICLOUD_SECRET_ACCESS_KEY_FILE || true
        ;;
      digitalocean)
        unset DO_AUTH_TOKEN DO_AUTH_TOKEN_FILE || true
        ;;
    esac
    acme_cert="$ACME_STORE/certificates/${ACME_DOMAIN}.crt"
    acme_key="$ACME_STORE/certificates/${ACME_DOMAIN}.key"
    HTTPS_ARGS+=(--local-protocol https --https-cert-path "$acme_cert" --https-key-path "$acme_key")
    unset PAIRFOB_TLS_CA || true
  else
    TLS_MODE="local-ca"
    mkdir -p "$TLS_DIR"
    umask 077
    san="IP:127.0.0.1,DNS:localhost"
    if [[ "$origin_host" =~ ^[0-9.]+$ ]]; then
      san="IP:${origin_host},${san}"
    elif [[ -n "$origin_host" ]]; then
      san="DNS:${origin_host},${san}"
    fi
    cat >"$TLS_DIR/ca.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = Pairfob local CA
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF
    cat >"$TLS_DIR/server.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = pairfob-local
[v3_server]
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${san}
EOF
    openssl req -x509 -newkey rsa:2048 -sha256 -days 30 -nodes \
      -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" \
      -config "$TLS_DIR/ca.cnf" >/dev/null 2>&1
    openssl req -newkey rsa:2048 -sha256 -nodes \
      -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.csr" \
      -config "$TLS_DIR/server.cnf" >/dev/null 2>&1
    openssl x509 -req -in "$TLS_DIR/server.csr" -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" \
      -CAcreateserial -out "$TLS_DIR/server.crt" -days 30 -sha256 \
      -extfile "$TLS_DIR/server.cnf" -extensions v3_server >/dev/null 2>&1
    cat "$TLS_DIR/server.crt" "$TLS_DIR/ca.crt" >"$TLS_DIR/server-chain.crt"
    chmod 644 "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt" "$TLS_DIR/server-chain.crt"
    HTTPS_ARGS+=(--local-protocol https --https-cert-path "$TLS_DIR/server-chain.crt" --https-key-path "$TLS_DIR/server.key")
    CURL_ARGS+=(--cacert "$TLS_DIR/ca.crt")
    export PAIRFOB_TLS_CA="$TLS_DIR/ca.crt"
  fi
fi

echo "building PWA + pairfob…"
(cd pwa && bun run build >/dev/null)
go build -o "$DEV/pairfob" ./cmd/pairfob

echo "packing origin assets (PWA at / and /pair)…"
DEST="$ORIGIN_DIR/public-dist"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$ROOT/pwa/dist/." "$DEST/"
cp "$ROOT/pwa/dist/index.html" "$DEST/pair-shell.asset"
if [[ "$TLS_MODE" == "local-ca" && -f "$TLS_DIR/ca.crt" ]]; then
  cp "$TLS_DIR/ca.crt" "$DEST/ca.crt"
fi

if [[ ! -f "$VARS" ]]; then
  cp "$ORIGIN_DIR/.dev.vars.example" "$VARS"
fi

echo "starting Worker origin on ${LISTEN}…"
(
  cd "$ORIGIN_DIR"
  bunx wrangler d1 migrations apply pairfob --local --persist-to "$PERSIST" --config wrangler.local.jsonc >/dev/null
  bunx wrangler dev --config wrangler.local.jsonc --persist-to "$PERSIST" --ip "$HOST" --port "$PORT" "${HTTPS_ARGS[@]}"
) >"$DEV/origin.log" 2>&1 &
echo $! >"$DEV/origin.pid"

HEALTH_URL="${ORIGIN_URL}/v2/health"
if [[ "$TLS_MODE" == "local-ca" ]]; then
  HEALTH_URL="https://127.0.0.1:${PORT}/v2/health"
fi
for i in $(seq 1 80); do
  if curl "${CURL_ARGS[@]}" "$HEALTH_URL" >/dev/null; then break; fi
  if [[ "$i" -eq 80 ]]; then
    echo "origin did not become healthy; last log:" >&2
    tail -n 40 "$DEV/origin.log" >&2
    exit 1
  fi
  sleep 0.15
done

export PAIRFOB_ORIGIN="$ORIGIN_URL"
export PAIRFOB_STATE_DIR="${PAIRFOB_STATE_DIR:-$DEV/state}"
if [[ -f "$PAIRFOB_STATE_DIR/relay.json" ]]; then
  proto="$(jq -r '.protocol // 0' "$PAIRFOB_STATE_DIR/relay.json" 2>/dev/null || echo 0)"
  stored_url="$(jq -r '.url // empty' "$PAIRFOB_STATE_DIR/relay.json" 2>/dev/null || true)"
  if [[ "$origin_scheme" == "https" ]]; then
    expected_ws="wss://${ORIGIN_URL#https://}/v2/ws"
  else
    expected_ws="ws://${ORIGIN_URL#http://}/v2/ws"
  fi
  if [[ "$proto" != "2" || "$stored_url" != "${expected_ws}"* ]]; then
    echo "replacing leftover relay.json in $PAIRFOB_STATE_DIR"
    rm -f "$PAIRFOB_STATE_DIR/relay.json"
  fi
fi
CAHTTP_URL=""
if [[ "$TLS_MODE" == "local-ca" ]]; then
  CAHTTP_PORT="${PAIRFOB_CAHTTP_PORT:-18787}"
  python3 "$ROOT/scripts/dev-ca-http.py" --listen "$HOST" --port "$CAHTTP_PORT" --ca "$TLS_DIR/ca.crt" --https-pair "$ORIGIN_URL" \
    >"$DEV/cahttp.log" 2>&1 &
  echo $! >"$DEV/cahttp.pid"
  ca_host="$origin_host"
  if [[ -z "$ca_host" || "$ca_host" == "127.0.0.1" ]]; then
    ca_host="${LAN_IP:-127.0.0.1}"
  fi
  CAHTTP_URL="http://${ca_host}:${CAHTTP_PORT}"
fi

export PAIRFOB_PAIR_CODE="${PAIRFOB_PAIR_CODE:-}"
unset PAIRFOB_JOIN_TOKEN PAIRFOB_JOIN_GRANT PAIRFOB_RELAY_WS PAIRFOB_PROTOCOL || true

"$DEV/pairfob" >"$DEV/daemon.log" 2>&1 &
echo $! >"$DEV/daemon.pid"
for i in $(seq 1 50); do
  if grep -q 'pairfob admin' "$DEV/daemon.log" 2>/dev/null; then break; fi
  if [[ "$i" -eq 50 ]]; then
    echo "pairfob did not start; last log:" >&2
    tail -n 40 "$DEV/daemon.log" >&2
    exit 1
  fi
  sleep 0.1
done

{
  echo "Pairfob local test (pairfob.v2 Worker origin)"
  echo "PWA            ${ORIGIN_URL}/pair"
  echo "Pair           PAIRFOB_STATE_DIR=${PAIRFOB_STATE_DIR} $DEV/pairfob pair"
  echo "                scan/input, then press Enter when prompted"
  if [[ "$TLS_MODE" == "local-ca" ]]; then
    echo "Install CA     ${CAHTTP_URL}/          (HTTP profile; iPhone: do not install a .crt identity)"
    echo "Then PWA       ${ORIGIN_URL}/pair"
    echo "TLS            iPhone: install profile, then Settings → General → About → Certificate Trust Settings"
  elif [[ "$TLS_MODE" == "acme" ]]; then
    echo "TLS            public ACME certificate via ${PAIRFOB_ACME_DNS} (no CA profile)"
    echo "LAN DNS        ${ACME_DOMAIN} -> ${expected_ip}"
  fi
  echo "Stop           ./scripts/dev-down.sh"
} 
