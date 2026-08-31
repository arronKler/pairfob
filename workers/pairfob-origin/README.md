# pairfob-origin

The only Pairfob relay: Cloudflare Worker + one Durable Object per `daemon_id` + sharded `PairingIndex` + D1 grants. Production is `https://pairfob.com`. Local pairing is `../../scripts/dev-up.sh` (`wrangler.local.jsonc`).

Envelope codec stays `version=0x01`; FWD bytes are opaque. Mux control JSON is `"v":2`.

## Interactive local origin

From the repo root, `../../scripts/dev-up.sh` packs the PWA, starts `wrangler dev` on loopback, mints a grant, and enrolls `pairfob`. That is the pairing/debug loop. Miniflare is still **not** a hibernation proof.

## Local tests (no Cloudflare account)

```
bun test src
bun test e2e
```

`src/` is the merge gate for unit logic (CAS enroll, ticket consume, PING zero-storage, caps, crockford, envelope).

`e2e/` (default `bun test e2e`) is the **S8.5 merge gate**: an in-process room harness (fake sockets + memory SQL + fake D1) covering pair-intent miss/hit/`issueTicket` mismatch (same 404), dual Upgrade on one ticket, QR without ticket, ResumeHello LRU, and the 11th Established.

`bun run e2e:wrangler` runs workerd tests (`e2e/wrangler/`): HTTP plus enroll → HELLO → PAIR_OPEN loc → ticket consume. Config is `wrangler.e2e.jsonc` (`compatibility_date` ≤ 2026-08-22 for workerd). Local/prod `wrangler.jsonc` uses the same date. Miniflare is **not** a hibernation proof — PING zero-storage is asserted with a storage spy in `src/room/ping.test.ts`.

`wrangler.jsonc` `assets.directory` is `./public-dist` (marketing site at `/`, PWA at `/pair`, installer at `/install.sh`). `run_worker_first` is true so `withSecurity` headers (CSP, frame-ancestors, `X-Pairfob-Build`) apply to those files, not only to `/v2` JSON. Pack after a PWA build: `../../scripts/pack-origin-assets.sh`. Desktop binaries from `../../scripts/release.sh` are included at `/dl/` only when packing with `PAIRFOB_PACK_DL=1`.

## Config

`.dev.vars`:

```
OPERATOR_TOKEN=dev-operator
IP_HASH_PEPPER=dev-pepper-not-for-prod
```

`wrangler.jsonc` `compatibility_date` is `2026-08-26`. Durable Object classes: `DaemonRoom`, `PairingIndex` (SQLite). Apply all ordered D1 migrations in `migrations/`; `0005_grant_enroll_rate.sql` makes the per-grant enroll window authoritative in D1, and `0006_self_serve_grants.sql` adds the per-IP signup ledger.

Mint a grant (prints `join_grant` once):

```
bun run src/mint.ts --label lab
# or POST /v2/admin/grants with Authorization: Bearer $OPERATOR_TOKEN
```

## Self-serve signup

`/v2/grants` lets a visitor mint their own grant from the landing page, so the
site is not invite-only. `GET` reports whether signup is open; a same-origin
browser `POST` mints a `max_daemons=2` grant labelled `self-serve`. Signup is
open by default, and `SIGNUP_OPEN=0` is the emergency shutoff.

The authoritative abuse cap is `SELF_GRANT_PER_IP` grants per hashed IP per
`SELF_GRANT_WINDOW_MS`, enforced inside the D1 `INSERT` so concurrent requests
cannot both pass. `limits.ts` is only a per-isolate first pass and is not a
global limit. Without a human challenge, clients that rotate source addresses
can bypass the per-IP cap; use the WAF rules below as an additional cost guard.

Marketing and `/doc` get `CSP_SITE` (no Wasm, no inline). `/pair` keeps `CSP`
with `'wasm-unsafe-eval'`. `src/csp.test.ts` guards that split. Docs HTML is
rewritten at VitePress build time so executable inline scripts become hashed
files under `/doc/assets/`.

`pairfob` client-mints and journals the v2 `daemon_id` and reconnect token before `POST /v2/enroll`; the Worker validates and echoes them. Retrying the identical credential after an uncertain HTTP outcome is idempotent and does not consume another grant slot. Rekey likewise sends a pre-journaled `new_reconnect_token`.

## Static PWA

`public/` is a placeholder. Production packs `site/` onto `/` and `pwa/dist` onto `/pair` (same host as `/v2/ws`). `/api/config` returns `{protocol:2,build}`.

## Observability

Workers Logs plus Analytics Engine dataset `pairfob` (binding `METRICS`). First-party beacons are `POST /v2/events`. See `docs/observability.md`. `pairfob` does not send telemetry.

## WAF

See `docs/waf.md`. `ENROLL_OPEN=0` stops new rooms; live duration continues until disconnect/kick.
