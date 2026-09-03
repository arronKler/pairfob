# Pairfob origin WAF checklist (S9)

Hosted mux is `https://pairfob.com`. These rules sit **in front of** the Worker. Application code still fail-closes; WAF is the flood control for unauthenticated HTTP.

Identity: **`CF-Connecting-IP` only**. Do not enable “trust `X-Forwarded-For`”. Do not port `PAIRFOB_TRUST_PROXY_HEADERS`.

## Bot Fight

- Enable **Bot Fight Mode** (or Super Bot Fight on the zone).
- Challenge anonymous automated clients on `/v2/pair-intent` and `/v2/enroll`.
- Skip Bot Fight for `pairfob` enroll/rekey if those requests are IP-allowlisted; they send **no browser Origin**. A global JS challenge on `/v2/enroll` will break daemons.

## Rate Limit rules (zone)

Create two custom Rate Limiting rules (or equivalent WAF rate-limit). Counting uses `CF-Connecting-IP`.

| Rule | Expression | Limit | Action |
| --- | --- | --- | --- |
| pair-intent | `http.request.uri.path eq "/v2/pair-intent"` and `http.request.method eq "POST"` | **10 / 10 minutes / IP** | Block (429). Must run **before** any Index Durable Object RPC. |
| enroll | `http.request.uri.path eq "/v2/enroll"` and `http.request.method eq "POST"` | **5 / hour / IP** | Block (429). Worker also caps open enroll per hashed IP. |
| session Upgrade | `http.request.uri.path eq "/v2/ws"` and `http.request.uri.query contains "role=client"` and `not http.request.uri.query contains "pair_ticket="` | **60 / minute / IP** | Block (429). QR + SessionWS. |
| events beacon | `http.request.uri.path eq "/v2/events"` and `http.request.method eq "POST"` | **60 / minute / IP** | Block (429). First-party PWA/site beacons only. |

Hand-entry is already capped by pair-intent; do **not** put `pair_loc` on `/v2/ws` (Worker returns 404 unpaired without Index lookup).

## Abuse caps

Open enroll is always on. Cost control is the per-IP D1 cap (`SELF_GRANT_PER_IP` per `SELF_GRANT_WINDOW_MS`), the isolate `allowEnrollIP` first pass, and the WAF enroll rule above. For an emergency cost stop: kick daemons (`POST /v2/admin/daemons/:id/kick`).

## Headers the WAF must not strip

- `CF-Connecting-IP` (required)
- `Origin` (pair-intent requires same-host; enroll/rekey **reject** browser Origin)
- `Authorization` on `/v2/admin/*`
- `Sec-WebSocket-Protocol` (`pairfob.v2`; `/v1/ws` is 426)

## Logging

Log `daemon_id`, `grant_id`, `pair_ref`, `pair_loc`, `route_id`, envelope typ/length, `error.code`. Never log `jg_` / `rt_` plaintext, `pair_ticket` plaintext, `s`, FWD payload, or raw IPs (use the HMAC pepper hash already stored as `enroll_ip_hash`). Application metrics labels follow the same whitelist; see `docs/observability.md`.
