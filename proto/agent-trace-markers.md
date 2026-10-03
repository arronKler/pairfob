# Agent trace markers

`AgentTrace` and `AgentTraceSummary` accept an additive optional param
`markers: true`. A client may send it only when
`GetConfig.capabilities.trace_markers` is true; older daemons reject unknown
params and absence means false. Without the param the item vocabulary stays
`user`, `thinking`, `tool`, `assistant`, so existing clients keep validating.

With `markers: true` three more item types may appear:

| type | fields | meaning |
| --- | --- | --- |
| `command` | `text` | A slash or shell command in its typed form, such as `/clear`, `/model opus` or `! git status`. It opens a turn like `user`. |
| `compaction` | none | The agent compacted its context here. Earlier turns are no longer in its working memory. |
| `interrupt` | none | The user cancelled the turn; nothing after it belongs to that turn. |

Without markers a `command` is returned as `user` with the same text, and
`compaction` / `interrupt` are omitted. Tool `detail_ref` values are identical
in both views. A `next_cursor` belongs to the view that issued it: markers take
page slots, so reuse a cursor only with the same `markers` value.

Markers come only from records the agent CLI itself writes: Claude Code
`compact_boundary` and its interrupt notice, Codex `compacted` and
`turn_aborted` with `reason: interrupted`, Grok `turn_completed` with
`stop_reason: cancelled`, Pi `compaction` entries and assistant
`stopReason: aborted`. Injected context (instructions, reminders, local command
output, background notices) is never returned as any item type.
