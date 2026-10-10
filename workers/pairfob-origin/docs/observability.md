# Pairfob origin observability

Mux and product events live in two places:

1. **Workers Logs** — structured `console.log` JSON (`kind: "pairfob"`) for enroll, pair-intent, WebSocket open/close, bind, errors, late alarms, page class, and first-party beacons. Invocation logs stay on; they record `<Method> <URL>`. Do not put secrets on the path. `pair_ticket` is a query parameter, so do not log `req.url`. Production currently stores funnel events here (`observability.logs.persist`). `fwd` stays off the log stream because of volume.
2. **Workers Analytics Engine** dataset `pairfob` (binding `METRICS`) — durable SQL counters. Isolate `counters` on `GET /v2/admin/stats` are a per-isolate snapshot only. If `wrangler deploy` still returns `10089` after the account-level enable, attach `METRICS` with a settings PATCH that `inherit`s existing bindings and adds `{ type: "analytics_engine", name: "METRICS", dataset: "pairfob" }`.

`pairfob` does not phone home. `PAIRFOB_TRACE=1` stays on the user machine.

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

`enroll`, `pair_intent`, `ws_open`, `ws_close`, `bind`, `fwd`, `alarm_late`, `error`, `page`

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

### Compare cost and slow events separately

- Use `durableObjectsPeriodicGroups.sum.duration` (GB-s) for DO duration
  consumption. `activeTime` and `cpuTime` are microseconds. Scope the query to
  the intended namespace; account totals can include unrelated Workers.
- Compare complete windows using both GB-s/hour and GB-s per 1,000
  `hibernation` invocations. The latter controls for event volume, not changes
  in connection churn or message mix. Resource reductions are not the same as
  reductions in the total invoice.
- Reconcile recent-window minute sums with an independent total and a coarser
  grouping. Repeating an unchanged query is not proof that ingestion has
  settled: fixed-window queries have returned different totals with only a
  non-binding result limit changed, including an immediate A/B/A repeat.
  Retain conflicting responses and their capture times. A limit variant is a
  cross-check, not a guaranteed freshness mechanism or proof of caching.
- GraphQL invocation `wallTime` is in microseconds; Workers Logs
  `$workers.wallTimeMs` is in milliseconds. GraphQL sums already account for
  adaptive sampling: do not multiply them by `sampleInterval` again. A
  group's request count is not the count of requests equal to its maximum.
  Sampled maxima can miss unsampled long events; retain each group's sampling
  metadata when interpreting the tail.
- Keep message, close, alarm, and fetch outcomes separate. A canceled upgrade
  or closed WebSocket is not by itself an application exception. Entry Worker
  and DO errors can describe the same failed operation; do not add them as
  independent user failures.
  In particular, a fetch marked `canceled` can have successfully delivered its
  101 and exchanged messages before the WebSocket closed. That outcome alone
  does not prove the upgrade handoff failed. Correlate client handshake/frame
  evidence or explicit handoff instrumentation before attributing a slow burst
  to an unclaimed endpoint.
- Check both GraphQL and invocation logs before declaring slow events absent.
  Split log queries until `abr_level` is 1 and results do not hit the row
  limit; also check account ingestion sampling and quota status. An empty
  result from an unverified field or event-type filter is not evidence.
- Correlate by object, deployed version, and a surrounding time window before
  narrowing to seconds. The two sources can assign corresponding invocations
  to different seconds. Invocation log timestamps can be near completion;
  subtract `wallTimeMs` to estimate the start before matching a GraphQL bucket.
  If GraphQL wall time is long while logs are short, check the object's
  surrounding active time and a controlled client RTT. Do not treat either
  source alone as proof of user latency or billable time.

### Check the idle boundary before attributing a long tail

Cloudflare currently documents a [10-second idle wait before hibernation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).
An idle object eligible for hibernation does not incur duration charges during
that wait ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
This is a runtime policy, not a Pairfob timeout to tune.

For a long GraphQL event with a short invocation log, estimate its start from
the log, then add GraphQL wall time. Compare this endpoint with the last
activity before an idle gap, plus the documented hibernation delay. Include
intervening messages, fetches, alarms, and close events; a later activity can
extend the idle boundary. Keep sampling and unmatched events visible.

In the October 10 investigation, 19 of 20 consecutive long-tail buckets from
one room matched that boundary within 4 ms; the remaining residual was 65 ms.
A separate 60-second maximum matched a candidate invocation within 5 ms.
This strongly supports a lifecycle boundary in those metrics, but does not
prove the private metrics implementation or establish client latency. Check
subrequest response-body ownership as well as handler completion, and validate
any proposed cleanup with an isolated control before changing production.

The isolated PairingIndex response-body control reproduced this effect in two
runs: all eight pairing operations with unused bodies produced 19–20 second
GraphQL times, while consuming or canceling the bodies brought all sixteen
corresponding operations into agreement with invocation logs. All 114 WS
invocations were present with sampling interval 1 and no errors. This identifies
the unused body as the application trigger for this class of long tail; it
does not establish the internals of Cloudflare's private metrics observer.
The experiment did not show a comparable increase in billed active time.

`NamespaceIndexClient` cancels bodies it does not use, including unsuccessful
lookups. HTTP status remains authoritative: a cleanup error cannot turn an
already successful index mutation into a failure or trigger a retry. The
`index_response_cleanup_failed` warning exposes cleanup failures using only
the operation name and status. Successful lookups still consume their JSON.

### Validate canceled upgrade cleanup

`room_upgrade_cancelled` records completion of the local two-endpoint cleanup
routine. It is emitted after both close calls return, not after a completed
close handshake or confirmed hibernation. No marker does not prove that
cancellation was never attempted. Check exceptions too. An endpoint
already handed off in a response must not be reclaimed by the DO's abort
listener, since that can close a healthy connection.

For a cancellation regression, use an isolated namespace and test both sides
of the handoff: cancellation before the DO returns its 101, and cancellation
after the outer Worker receives that 101 but before it delivers it to the
client. Include normal connections and successful delayed delivery as controls.
Record PONG correctness/RTT, execution logs, and periodic duration together.
Remove the isolated Worker and namespace after collecting their metrics.

### Abandoned alarm queues

Compare SQL `alarms` row counts and oldest deadlines with actual alarm
invocations. A past timestamp returned by `getAlarm()` is not evidence that
the scheduler will still deliver it: platform retries are bounded. The store
only skips an unchanged alarm while its deadline is in the future; overdue
work is rearmed after the current time. `room_alarm_rearmed` records the old,
due and newly scheduled timestamps without row contents.

The queue has indexes on `at` and `(kind, ref)`. Each invocation drains at most
128 rows; socket-wide hello/resume sweeps run once per batch. Future rows and
established sockets survive historical backlog recovery. Do not delete the
queue directly: its pairing expiry and pending-session actions still matter.
Deletion matches the complete harvested row, since SQLite can reuse a row ID
while a TTL handler waits for a concurrent pairing refresh. An unchanged
deadline avoids SQL writes; a refreshed deadline updates the existing row
instead of deleting and rebuilding both indexes. Duplicate legacy references
still use the original replacement path to retain deduplication.

For remaining lifecycle failures, `room_close_failed.stage` distinguishes
attachment, cleanup and native close-reply failures while preserving the
original exception. `ROOM_DIAGNOSTICS_OBJECT_IDS` enables full metadata traces
and constructor boundaries for exact platform object IDs until the existing
diagnostic expiry. It never enables payload or credential logging.

### Operational actions

1. GB-s / connection jump: `rg "acceptWebSocket|server\\.accept\\(|setTimeout" workers/` and confirm `server.accept(` is absent from the bundle.
2. Emergency cost stop: kick daemons (`POST /v2/admin/daemons/:id/kick`).
3. Kick: `POST /v2/admin/daemons/:id/kick`.
4. Pair-intent `unpaired` vs `ok` is occupancy-safe: miss and slot mismatch share the same 404, and unpaired points must not leak `pair_loc`.
5. If invocation logs ever include a `pair_ticket` query, turn on query-string redaction in the dashboard (Workers Observability cannot redact path segments).
