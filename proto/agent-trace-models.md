# Agent trace model records

`GetConfig.capabilities.trace_models: true` advertises the new read-only
`AgentTraceModelSummary` operation. Absence means false. Its request accepts
the same parameters as `AgentTraceSummary`; its response has the same summary
fields, plus optional `models` on assistant, thinking and tool items. Existing
operations, their accepted parameters, and their response fields are unchanged.
The established-session and pane/transcript authorization checks are identical.

Each observation has `model`, optional `effort`, and `source`. Model and effort
are opaque identifiers matching `[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}`. Invalid
model identifiers are omitted; invalid or missing effort is unknown, never a
default. Sources:

| source | evidence | meaning |
| --- | --- | --- |
| `codex_context` | rollout `turn_context.payload.model` / `.effort` | requested configuration recorded for this turn, not proof of provider routing |
| `claude_message` | accepted assistant record's `message.model` | message model; no effort field is supplied |
| `pi_message` | accepted assistant record's `message.model` / `message.thinkingLevel` | message model and recorded thinking level; Prime Agent writes the same Pi-format record and reports through this source |

Codex context belongs to one forward scan. Task start/end/abort and invalid or
oversized records clear it; conflicting task IDs reject it. In older logs
without task boundaries another visible user or a user after a response clears it. A
context immediately before the first user can describe that user's response.
Tail windows with no context stay unknown. Claude and Pi-format (Pi, Prime Agent) observations belong
only to the message supplying them. Sidechain and synthetic records remain
filtered by the normal transcript parser. Cursor, Grok, Hermes and opencode
currently supply no observations.

No model is copied from pane tokens, session defaults, a model name in prose,
or a later turn. Tool output does not overwrite the call's observations.
Merged streaming items retain distinct observations in source order. One item
can have at most 32 observations; if it exceeds that bound, its observations
are omitted rather than reporting a truncated set as complete. Model extras
are dropped oldest-first before other extras to fit the existing summary byte
budget. Cursors, pagination and tool detail references match the legacy view.

The client groups observations only from items in the displayed turn, keeps
distinct configurations, and shows them next to elapsed time in the existing
execution card. Expanding keeps the original steps and exposes full model IDs,
effort (or “not recorded”) and evidence source. A partial history page describes
only records loaded so far. An old daemon keeps the original card; an extension
response with no observations says “model not recorded.” No selector or setter
is advertised by this read capability.

Ship the updated PWA before the daemon: older PWA builds reject unknown
capability keys. This extension does not change envelope versions, crypto,
the relay, or Herdr methods.
