# pairfob.v2 mux extension (frozen)

This document freezes only the **hosted mux control plane**. The binary
envelope header, FWD AEAD, AAD, HKDF info, SPAKE2+ transcript, DeviceHello,
and inner RPC remain defined by `envelope.md`, `rpc.schema.json`, and
`pairfob-vectors.json`.

`pair_loc` **must not** enter the SPAKE `idProver` / `idVerifier` values or the
Argon2id salt. The salt remains `daemon_id` + `pair_ref_hex`.

## Subprotocol and paths

| Layer | Current value |
| --- | --- |
| WebSocket subprotocol | `pairfob.v2` |
| Upgrade path | `/v2/ws` |
| Envelope `version` byte | `0x01` |
| Control JSON `"v"` | `2` |
| Inner RPC / DeviceHello `"v"` | `1` |
| Origin | Worker at `https://pairfob.com`, or local `wrangler dev` |

The origin returns **426** for the disabled `/v1/ws` path.

## Binary envelope

The 24-byte header contains `version=0x01`, `typ`, `flags=0`, `length` as a
big-endian uint32 no greater than 262144, and a 16-byte `route_id`. The FWD
payload is nonce(12) || ciphertext || tag(16). AAD remains 21 bytes with
`ver=0x01 typ=0x05`.

`typ` ranges from 0x01 through 0x0F. mux v2 adds no envelope types. Rekeying
uses HTTP `POST /v2/rekey`.

## HTTP

No cookies. Enroll, pair-intent, rekey, and config responses use
`Cache-Control: no-store`.

| Method | Path | Origin requirement | Behavior |
| --- | --- | --- | --- |
| GET | `/` `/assets/*` `/sw.js` `/manifest.webmanifest` `/pair` | - | PWA with the complete security-header set |
| GET | `/api/config` | - | `{protocol:2, build,p2p}`; `p2p` is the direct-upgrade kill switch |
| GET | `/v2/health` | - | `{ok:true, protocol:2}` |
| POST | `/v2/enroll` | Absent or non-browser | Validate and echo the client-persisted `daemon_id` / `reconnect_token` |
| POST | `/v2/pair-intent` | **Same-origin required** | Metered locator lookup; 10 requests per 10 minutes per IP |
| POST | `/v2/rekey` | Absent or non-browser | Atomically replace the old reconnect token with the client-persisted new token and echo it |
| GET | `/v2/ws` | Phone must be same-origin; daemon may omit Origin | Upgrade with `pairfob.v2` |
| GET | `/v1/ws` | - | **426** |

Only `CF-Connecting-IP` is trusted as the client IP.

### pair-intent

Request:

```json
{"v":2,"pair_loc":"WJ3K9M"}
```

`pair_loc` is a six-character Crockford value using the alphabet
`0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Normalize it by removing whitespace,
uppercasing, and mapping `I/L->1`, `O->0`, and `U->V`. The shard prefix is the
first two characters after normalization.

An Index miss, expiration, unknown locator, or mismatch with the Room's current
slot and locator must return the same HTTP **404**, latency, and body:

```json
{"ok":false,"error":{"code":"unpaired"}}
```

Successful response:

```json
{"ok":true,"v":2,"daemon_id":"d_...","pair_ref":"<32 hex>","pair_ticket":"<32 hex>","expires_in":15}
```

`pair_ticket` is a 128-bit CSPRNG value encoded as lowercase hex with a
**15-second** lifetime. It is used only by manually entered PairingWS flows.

### enroll

The enroll body is `{v:2, daemon_id, reconnect_token}`. A leftover
`join_grant` field is ignored. The Worker mints an internal one-slot grant for
that enrollment, subject to a per-IP cap. The minted grant is not a user
credential and is never returned as `join_grant`.

Before enrollment, `pairfob` generates and persists `daemon_id` as `d_` plus
20 lowercase hex characters (10 random bytes) and `reconnect_token` as `rt_`
plus 32 lowercase hex characters. It then sends both values, and a successful
response must echo them exactly. If D1 and the Room already contain the same
credentials, enrollment recovers idempotently without consuming another
grant. If the D1 row exists but the Room registration is missing, the same
`daemon_id` and `reconnect_token` can complete the Room registration. The cloud
stores only the SHA-256 hash of the reconnect token.

A rekey request contains
`{v:2, daemon_id, reconnect_token, new_reconnect_token}`. The Room atomically
replaces the token when the current hash matches the old value. If the current
hash already matches the new value, the repeated request succeeds
idempotently. The response must echo the new token.

The grant update is an internal CAS on the minted one-slot row. A Room failure
must compensate the `used` increment. Per-IP open-enroll exhaustion uses
`rate_limited`.

Kick preserves the row, sets `kicked_at`, and decrements `used`.

`PAIRFOB_JOIN_TOKEN` and `PAIRFOB_JOIN_GRANT` are forbidden.

## WebSocket Upgrade query

| Role | Required | Forbidden |
| --- | --- | --- |
| New daemon registration | No query credential; HTTP enroll happens first and HELLO carries reconnect | - |
| Daemon reconnect | HELLO carries reconnect | - |
| Manual-entry PairingWS | `role=client&pair_ticket=<32 hex>` | `pair_loc` in the URL returns **404** without Upgrade |
| QR PairingWS | `role=client&daemon_id=&pair_ref=`; the client has already removed the code from the fragment | `pair_ticket` |
| SessionWS | `role=client&daemon_id=` | ticket / locator |

A manually entered ticket is atomically deleted during Upgrade, and only a
successful deletion returns 101. A second Upgrade with the same ticket is not
upgraded into the Room and returns `unpaired`. If the connection drops before
ATTACH, the PWA obtains a new pair-intent. The QR path has no ticket;
PAIR_ATTACH checks only the current slot's `pair_ref`.

The Worker must know the target Durable Object before creating a
`WebSocketPair` and calling `stub.fetch`. Only the Durable Object may call
`acceptWebSocket`; `server.accept()` is forbidden.

## Control JSON

HELLO_CLIENT is `{"v":2,"protocol":2}`.

A successful HELLO_DAEMON, including every reconnect, still echoes the
plaintext `reconnect_token`:

```json
{"v":2,"op":"RegisterDaemon","ok":true,"daemon_id":"d_...","reconnect_token":"rt_...","relay_time":0}
```

PAIR_OPEN omits `pair_loc` on the daemon request:

```json
{"v":2,"op":"CreatePairing","daemon_id":"d_...","pair_ref":"<32 hex>","ttl_s":180}
```

The Room mints the locator in the acknowledgement. `pairfob` prints it only
after receiving this acknowledgement:

```json
{"v":2,"op":"CreatePairing","ok":true,"pair_ref":"<32 hex>","pair_loc":"WJ3K9M","ttl_s":180}
```

Failure uses `index_unavailable` and leaves no slot behind. There is no
`pair_lookup` operation.

PAIR_ATTACH is `{"v":2,"pair_ref":"<32 hex>"}`. It must match the current
slot's reference and locator; a manually entered ticket has already selected
the Room. An expired locator returns `unpaired`.

PAIR_ATTACHED, SESSION_BOUND, SESSION_ESTABLISHED, DAEMON_REPLACED, and ERROR
retain their v1 fields with outer `"v":2`.

SESSION_* and FWD retain their v1 semantics. The relay and Durable Object do
not parse FWD and recognize only the daemon's `SESSION_ESTABLISHED`.
Established sessions are capped at 10. ResumeHello is capped at 2 with a
15-second soft gate; a Cloudflare alarm may be delayed by about one minute, so
the quota is enforced with LRU. PING does not extend lifetime. The Durable
Object does **not** pin `device_id`. The daemon sends ERROR with `kicked` for a
duplicate device.

After establishment, endpoints may negotiate the optional direct transport
defined in `direct-transport.md`. Its SDP stays inside opaque encrypted FWD RPC
payloads; the Worker and Durable Object do not parse it.

## Error codes

Common mux error codes are `unbound`, `unpaired`, `pair_busy`, `pair_timeout`,
`pairing_expired`, `pairing_replaced` (within the same Room only),
`too_many_devices`, `kicked`, `daemon_offline`, `rate_limited`, `wrong_ws`, and
`bad_token`.

v2 enrollment and index error codes are `locator_required`, `enroll_required`,
and `index_unavailable`.

## Heartbeat

Send envelope PING/PONG every **25 seconds**. The Durable Object must send an
application-level PONG. PING/PONG performs **no SQLite operations and does not
call setAlarm**. `RecvWithin(60s)` proves client liveness, not Room liveness.

## Security headers

The origin returns CSP including `wasm-unsafe-eval`, `X-Content-Type-Options`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and
`Permissions-Policy: camera=(self), microphone=(), geolocation=()`.
