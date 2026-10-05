# Agent trace times

`AgentTraceSummary` accepts an additive optional param `times: true`. A client
may send it only when `GetConfig.capabilities.trace_times` is true; older
daemons reject unknown params and absence means false. `AgentTrace` does not
take the param. `times`, `labels` (`proto/agent-trace-labels.md`) and `markers`
(`proto/agent-trace-markers.md`) are independent.

With `times: true` any summary item (`user`, `thinking`, `tool`, `assistant`,
and with markers `command`, `compaction`, `interrupt`) may carry `at`: an
integer, milliseconds since the Unix epoch, of the transcript record the item
came from. Without the param `at` never appears, so existing clients keep
validating. It is display data only; order still comes from the item list.

| item | record |
| --- | --- |
| text merged from streaming chunks | the first chunk |
| `tool` | the call, not its output |
| several items from one record | each gets that record's time |

The daemon reads the time the agent CLI wrote with each record:

| agent | source |
| --- | --- |
| Claude Code | top-level `timestamp` (RFC 3339) of each JSONL record |
| Codex | top-level `timestamp` (RFC 3339) of each rollout line |
| Grok | `params._meta.agentTimestampMs`, else the top-level `timestamp` (epoch seconds) of each `updates.jsonl` line |
| Pi | the session entry's `timestamp` (RFC 3339) |
| Hermes | the message row's `timestamp` (epoch seconds) in `state.db` |
| opencode | the part's `state.time.start` or `time.start`, else its message's `time.created` (epoch ms) |
| Cursor | none: its transcript carries no times, so `at` is omitted |

RFC 3339 strings may carry fractional seconds and any offset; a JSON number is
epoch milliseconds when at least 10^11, else epoch seconds. `at` is omitted
when the record has no timestamp, it does not parse, or it lies before
2000-01-01T00:00:00Z or more than one day after the daemon's clock. Clients must
not assume every item, or consecutive items, carry one.

Tool `detail_ref` values, `next_cursor` positions and page boundaries are
identical with and without times. If times would push a page past its byte
budget, the daemon first drops labels as `proto/agent-trace-labels.md`
describes, then the oldest `at` values on that page.

With `times: true` the result also carries `now`: this computer's clock in
milliseconds when it answered. A client measures a running turn as
`now + (phone time since the reply) - at`, so a clock difference between the
phone and the computer does not show up as elapsed time.

Release order: ship the PWA that knows `trace_labels` and `trace_times` before
the daemon that advertises them. A PWA built before them rejects the unknown
capability keys and treats the daemon's config as incompatible (fail closed).
