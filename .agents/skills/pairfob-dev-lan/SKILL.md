---
name: pairfob-dev-lan
description: Start Pairfob's local Worker origin plus pairfob for browser or phone pairing. Use when the user wants local pairing, LAN HTTPS, a phone scan against this checkout, installing the local CA, or wrangler dev; or says 本地调试, 本地配对, 局域网配对, 真机扫码, or 安装本地 CA. Prefer scripts/dev-up.sh over hand-built wrangler/TLS commands.
---

# Local origin (loopback or LAN)

Same Worker as production, via `wrangler.local.jsonc`. Drivers are `scripts/dev-up.sh` and `scripts/dev-down.sh`. Do not reconstruct TLS, D1 apply, or enroll; the script does that.

## Loopback (computer browser)

```
./scripts/dev-down.sh          # if .dev/origin.pid is already live
./scripts/dev-up.sh
```

Default bind is `127.0.0.1:18786` (HTTP). Script prints:

- PWA: `http://127.0.0.1:18786/pair`
- pair: `PAIRFOB_STATE_DIR=.dev/state .dev/pairfob pair`

Scan or type the code, then Enter on the computer when asked. `dev-up` enrolls this `pairfob` against the local origin with no install code.

Without a TTY: `PAIRFOB_STATE_DIR=.dev/state .dev/pairfob pair new`, then `pair status` for `pair_url` / `code` / `pair_ref`. Open that URL with `browse open '<pair_url>' --local`. Poll `pair status` until `"ready":true`, then `pair accept`. Do not attach Chrome DevTools MCP to the user's daily Chrome profile (stale `DevToolsActivePort`). `forget` a test device when done.

## LAN + camera (phone)

getUserMedia needs HTTPS, so LAN bind switches the origin to HTTPS and mints a 30-day local CA:

```
./scripts/dev-down.sh
PAIRFOB_LISTEN=0.0.0.0:18786 ./scripts/dev-up.sh
```

The script sets `PAIRFOB_ORIGIN=https://<en0/en1 IPv4>:18786` when you did not set `PAIRFOB_ORIGIN`. It also starts `scripts/dev-ca-http.py` on port `18787` (override `PAIRFOB_CAHTTP_PORT`).

Phone order:

1. Open the **HTTP** CA page printed as `Install CA` (`http://<lan-ip>:18787/`), not the HTTPS origin first.
2. iPhone: use **Install Pairfob local CA (iPhone profile)** (`/ca.mobileconfig`). Then Settings → Profile Downloaded → Install, then Settings → General → About → Certificate Trust Settings → enable *Pairfob local CA*.
3. Only then open `https://<lan-ip>:18786/pair`.

If iOS asks for a **private key**, the phone is installing a personal identity, not a root CA. Go back to the HTTP profile link. Never copy `.dev/tls/ca.key` or `server.key` off the machine. `.cer` is a fallback CA file, still not an identity.

Android: install the CA from the same HTTP page, then trust it for Wi‑Fi/VPN or user CAs as that OEM requires, then open the HTTPS `/pair` URL.

The phone must be on the same LAN. A `https://100.x` / VPN address that the phone cannot route will fail even with a valid CA.

## Runtime

- Default talks to the real local Herdr socket. `PAIRFOB_DEV_FAKE_RUNTIME=1` is demo data only.
- State lives in `.dev/state` unless `PAIRFOB_STATE_DIR` is set. Reuse the printed `PAIRFOB_STATE_DIR` for `pair` / `doctor`.
- Already-running origin: `dev-up` exits and tells you to `dev-down` first. Do that rather than starting a second wrangler.
- Logs: `.dev/origin.log`, `.dev/daemon.log`, `.dev/cahttp.log`. Health is `/v2/health` (HTTPS health goes through `127.0.0.1` with `--cacert .dev/tls/ca.crt`).

This loop is not a production deploy and does not publish `/dl/`.

`pwa` `vite` on `:5173` uses `location.host` as the mux origin. Do not proxy `/api` or `/v2` to pairfob.com; the hosted Worker rejects that client as `forbidden`. Live hosted `/pair` is a ship, not this loop.
