# Pairfob origin observability

Mux and product events live in two places:

1. **Workers Logs** — structured `console.log` JSON (`kind: "pairfob"`) for enroll, pair-intent, WebSocket open/close, bind, errors, late alarms, page class, and first-party beacons. Invocation logs stay on; they record `<Method> <URL>`. Do not put secrets on the path. `pair_ticket` is a query parameter, so do not log `req.url`. Production currently stores funnel events here (`observability.logs.persist`). `fwd` stays off the log stream because of volume.
2. **Workers Analytics Engine** dataset `pairfob` (binding `METRICS`) — durable SQL counters. Isolate `counters` on `GET /v2/admin/stats` are a per-isolate snapshot only. If `wrangler deploy` still returns `10089` after the account-level enable, attach `METRICS` with a settings PATCH that `inherit`s existing bindings and adds `{ type: "analytics_engine", name: "METRICS", dataset: "pairfob" }`.

`pairfobd` does not phone home. `PAIRFOB_TRACE=1` stays on the user machine.

## Schema (`pairfob`)

| Field | Meaning |
| --- | --- |
| `index1` | `daemon_id` when the Worker already knows it; empty for anonymous pageviews and PWA beacons |
| `blob1` | event name |
| `blob2` | result (`ok`, `unpaired`, `rate_limited`, error code) |
| `blob3` | dimension (`daemon` / `client`, bind kind, page class, `qr` / `manual`) |
| `blob4` | extra token (`pwa_boot` phase, copy kind) |
| `blob5` | Worker `BUILD` |
| `double1` | count |
| `double2` | FWD payload bytes (length only) |
| `double3` | `alarm_late_ms` |

Labels are fail-closed: only `[A-Za-z0-9._:-]{1,64}`. `jg_` / `rt_` / `it_` / `pair_ticket` / `join_grant` / `reconnect_token` become `redacted`. Raw paths, pairing `s`, and FWD payload never go in blobs.

### Server events

`enroll`, `pair_intent`, `signup`, `ws_open`, `ws_close`, `bind`, `fwd`, `alarm_late`, `error`, `page`

`page` dimensions: `home`, `home_zh`, `pair`, `docs`, `install`, `download`. Asset files are not counted.

`fwd` is flushed every 64 KiB or on close/alarm, never per frame.

### First-party beacons (`POST /v2/events`)

Same-origin browser POST, 60 / minute / IP. Body `{ v: 2, events: [{ name, result?, extra? }] }`, at most 8 events. Allowed names only:

`pwa_boot`, `pwa_pairing_start`, `pwa_pairing_result`, `pwa_resume`, `pwa_live`, `pwa_disconnect`, `pwa_terminal`, `pwa_settings`, `pwa_add_computer`, `site_copy`

Clients cannot emit `enroll` / `ws_open` / `error`.

## Query

Analytics Engine SQL API (`POST /accounts/{account_id}/analytics_engine/sql`). Always filter on time. Use `SUM(_sample_interval)` rather than `COUNT(*)`.

```sql
SELECT
  blob1 AS event,
  blob2 AS result,
  SUM(_sample_interval * double1) AS n
FROM pairfob
WHERE timestamp >= NOW() - INTERVAL '1' DAY
GROUP BY blob1, blob2
ORDER BY n DESC
```

Pairing funnel:

```sql
SELECT blob3 AS method, blob2 AS result, SUM(_sample_interval * double1) AS n
FROM pairfob
WHERE timestamp >= NOW() - INTERVAL '7' DAY
  AND blob1 IN ('pwa_pairing_start', 'pwa_pairing_result', 'pwa_live')
GROUP BY blob3, blob2
```

Late alarms:

```sql
SELECT quantile(0.5)(double3) AS p50_ms, quantile(0.99)(double3) AS p99_ms
FROM pairfob
WHERE timestamp >= NOW() - INTERVAL '1' DAY
  AND blob1 = 'alarm_late'
  AND double3 > 0
```

Live sockets are **not** AE gauges. Sample them with `GET /v2/admin/stats` (up to 32 rooms) or by Durable Object `getWebSockets().length`.

## Runbook

1. GB-s / connection jump: `rg "acceptWebSocket|server\\.accept\\(|setTimeout" workers/` and confirm `server.accept(` is absent from the bundle.
2. `ENROLL_OPEN=0` stops new rooms; live duration continues until disconnect. Emergency cost stop: kick daemons.
3. Kick: `POST /v2/admin/daemons/:id/kick`.
4. Pair-intent `unpaired` vs `ok` is occupancy-safe: miss and slot mismatch share the same 404, and unpaired points must not leak `pair_loc`.
5. If invocation logs ever include a `pair_ticket` query, turn on query-string redaction in the dashboard (Workers Observability cannot redact path segments).
