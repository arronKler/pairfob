# Agent titles and execution activity

The new-session catalog is supplied by Herdr. Being launchable does **not**
mean that a native transcript is readable. Pairfob needs both a trusted
pane-to-session binding and a reader for that agent's persisted format.

All catalog entries use the same PWA title and activity rendering. A manually
set pane/workspace label retains precedence. The daemon supplies `tokens.task`
from a native name or the first visible request. `activity` comes from the same
bound session. Native IDs and store paths never enter the phone snapshot.

## Implemented readers

| Agent | Title source | Execution source |
| --- | --- | --- |
| Claude Code | `custom-title`, `ai-title`, first visible request | Bound project JSONL |
| Codex | SQLite `threads.name`, cleaned OSC title, first request | Bound rollout JSONL |
| Pi | `session_info`, first request on active branch | Active session tree |
| Grok | `summary.json.generated_title`, first request | `updates.jsonl` |
| Cursor | First visible request | Bound agent transcript |
| Hermes | SQLite session title, first visible request | SQLite active messages |
| Command Code (`cmd`) | V3 `session_info`, sidecar title, first visible request | Selected V3 branch plus live tool status from a local mod |
| OpenCode | Session title, first visible request | Legacy JSON files; SQLite `session`/`message`/`part`; V2 `session_v2`/`session_message` |
| Kilo | Session title, first visible request | Legacy OpenCode files; SQLite `session`, V1 parts or V2 typed messages |
| Copilot | First displayed user request | `session-state/<id>/events.jsonl` |
| Kimi | Native state title, first displayed request | Python wire log; Kimi Code state v2 and main-agent wire protocol 1.5 |
| Gemini | Session summary, first displayed request | Legacy JSON or JSONL metadata/messages/patches/rewinds |
| Qwen | `custom_title`, first displayed request | Active `parentUuid` branch of project chat JSONL |
| Cline | First visible request | SDK version-1 `<id>.messages.json` with matching `sessionId` |
| Amp | Thread title, first request | Exact `threads/T-<id>.json`, linked tool runs |
| Droid | Session-start title, first request | `sessions/<project>/<id>.jsonl` |
| Maki | Latest `meta.title`, first displayed request | Session JSONL v2/v3; excludes host observations and subagents |
| Muse | Session-index title, first explicit user intent | Durable session stream v1; only user-linked main runs |
| Antigravity (`agy`) | First explicit user request | Exact brain transcript; latest display step per index |
| Letta | First displayed request | Conversation reflection transcript; supports `default:<agent-id>` |
| Qoder CLI | First visible request | Exact project transcript with session-ID validation |
| Kiro | Session title, first visible request | V3 `session.json` / `messages.jsonl` format 1 |
| Devin | SQLite session title, first real request | Only ancestry ending at `sessions.main_chain_id` |


The table records implemented readers, including Command Code. It is
**reader coverage**, not a claim that every entry supplied by a newer Herdr
catalog has been accepted with its native CLI. Herdr's published matrix lists Gemini, Cline,
Amp and Maki as state-only. Pairfob supplies local hook/plugin bindings for
these four on macOS and Linux, described below. Never infer a binding from cwd,
recent modification time, a terminal's printed ID, or a client-supplied path.

### Local session bindings

When Pairfob starts Gemini, Cline, Amp or Maki, it prepares an additive local
integration before launching the agent. Existing settings, hooks and plugins
are preserved. An invalid configuration or a conflicting user-owned file
produces a launch error rather than silently overwriting it. For a CLI started
outside Pairfob, install the same integration with
`pairfob agent-observation gemini` (or `cline`, `amp`, `maki`) and restart that
CLI. Agents using Herdr's native integration continue to use it.

- Gemini: `SessionStart`, `BeforeAgent` and `SessionEnd` hooks in
  `~/.gemini/settings.json`. Explicitly disabled hooks are respected.
- Cline: additive SDK hook scripts under `$CLINE_DIR/hooks` (default
  `~/.cline/hooks`). Child-agent and old extension-format events are excluded.
- Amp: a system plugin under `$XDG_CONFIG_HOME/amp/plugins` (default
  `~/.config/amp/plugins`). It follows `activeThread`, ignores background runs,
  and activates only for a local executor inside Herdr.
- Maki: a Lua module loaded from the global `init.lua`, with only `run` and
  `env` permissions. It follows focused sessions and ignores child turns.
  An existing legacy `~/.maki` configuration takes precedence over XDG.

Hooks call the local Pairfob binary; they do not send conversation content or
transcript paths. The runtime verifies the reporter's process ancestry against
Herdr's `pane.process_info`, then records the exact terminal ID, native session
ID and foreground process generation in a private local file. The record is
scoped to the Herdr socket and terminal, and revalidated on every snapshot.
Native Herdr bindings take precedence. IDs and process details remain daemon
local and never enter phone snapshots or display metadata.

Sequence numbers reject out-of-order reports. An old session's exit cannot
clear its replacement. A daemon restart can reuse a record only while the same
foreground process is still alive; a process exit, replacement, or new terminal
invalidates it. A restarted agent must report again. This adds observation,
not new Herdr automatic session-resume commands. Unsupported platforms and
unavailable foreground process information remain unavailable.

The four native CLIs are not installed on the development machine used for
this change. Event harnesses and real Herdr PTY/process tests are distinct from
native CLI acceptance; do not describe them as four completed live CLI runs.

### OpenCode and Command Code startup

Pairfob prepares the current Herdr OpenCode integration before starting a new
OpenCode pane. Full TUI observation requires OpenCode 1.18.29 or later (including
V2); an older executable gets an explicit upgrade error before any integration
is changed. Legacy JSON history remains readable. The pane-local TUI plugin
provides selection and state for shared servers; Mini/headless clients do not
provide the same TUI lifecycle contract.

Command Code is advertised as `cmd` when `command-code` or `commandcode` is on
the daemon's PATH. Pairfob installs an additive user mod at
`~/.commandcode/mods/pairfob-session.ts` and launches the resolved executable
once in the new pane. Herdr has no native `agent.start` manifest for this
custom agent. The launch receipt confirms command queue admission; Command
Code binds its harness lazily on the first submitted turn. No native agent
identity is invented before that event.

For a manually launched Command Code, run `pairfob agent-observation cmd` and
restart it. The mod reports only the native session ID, selected leaf and a
bounded tool name/state/time. It never sends prompts, tool inputs, outputs or
transcript paths. Child processes inheriting another Command Code owner's pane
are excluded. The runtime verifies process ancestry and lifetime as for the
other local integrations. Native IDs and branch pointers stay daemon-local.

The Command Code reader follows the exact live branch of its V3 JSONL store,
including a rewind that has not appended any bytes. It excludes automated,
meta, summary, mod-injected and IDE context, and keeps tool-result messages
separate from requests. Unknown formats, missing branches, ambiguous IDs and
unsafe paths stay unavailable. The current CLI migrates older sessions when
resuming them; the reader does not rewrite or migrate native files. Messages
appear once the native CLI persists them; live tool status is reported before
that commit through the mod.

Opt-in native acceptance uses isolated HOME directories, actual Herdr/CLIs and
loopback model response fixtures, with no paid model calls:
`PAIRFOB_COMMAND_CODE_CLI` selects the official Command Code Node entrypoint,
`PAIRFOB_TEST_HOOK_BINARY` selects a built Pairfob, and `PAIRFOB_OPENCODE_CLI`
selects the official OpenCode executable. See the native tests in
`internal/runtime/command_code_live_test.go` and `opencode_live_test.go`.

### Format boundaries

- Copilot marks `session.title_changed` as ephemeral. It is not a reliable
  persisted title source. Read `user.message.content`, never model-transformed
  content; omit skill injection, autopilot continuation and child-agent events.
- Kimi has two distinct implementations. Python Kimi uses `~/.kimi`; current
  Kimi Code uses `KIMI_CODE_HOME` / `~/.kimi-code`, state v2, and protocol 1.5
  under `agents/main`. Read displayed turn/loop events, not duplicate context
  messages, profile/system prompts, or child-agent logs.
- Gemini filenames contain only the first eight ID characters. Verify the
  complete metadata ID, reject ambiguous matches, and exclude subagent paths.
  Replay `$set`, `$patch` and `$rewindTo` before deriving the visible timeline.
- Qwen rewinds re-root the parent chain. Its newer `managed_session_*`
  transaction format is deliberately unavailable until transaction/commit
  projection is implemented; it must not be interpreted as legacy JSONL.
- Cline's old `api_conversation_history.json` format is not covered by the new
  SDK reader. System prompts, synthetic user records and attached file content
  are excluded from the request title.
- SQLite readers open databases read-only, include WAL changes in cache stamps,
  and constrain every message/part query to the bound session. Unsupported
  revert shapes are unavailable rather than showing discarded history.
- Kiro's old SQLite and flat `sessions/cli` formats are not covered by the V3
  reader. Synthetic user messages are hidden; summarization becomes a
  compaction marker, while unknown tombstone semantics fail closed.
- Muse retained-frame replay is not covered. Main chat runs must have a matching
  explicit user intent. Background memory runs are excluded.
- Antigravity's display export identifies called tools but does not reliably
  link result records; this reader does not invent tool completion or output.
- Letta reflection records arrive after captured turns, so their availability
  can lag the live terminal. Never choose a persistent agent's newest conversation.
- Maki legacy `.json` snapshots are not covered by the JSONL reader.
- Mutable file stores are bounded at 32 MiB. Oversized or inconsistent snapshots
  remain unavailable. Unknown formats never fall back to another agent parser.

## Public references used

Sources were inspected on 2026-10-28. Agent formats can change independently of
Pairfob; fixture coverage and a native CLI acceptance run are separate evidence.

- [Herdr supported agents](https://herdr.dev/docs/agents/) and
  [integration/session binding documentation](https://herdr.dev/docs/integrations/).
- [Copilot persisted event types](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts)
  and [local session data](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/session-data).
- [Kimi wire persistence](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/file.py),
  [wire messages](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/types.py),
  [session titles](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/session.py).
- [Gemini recording types](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts)
  and [recording/replay implementation](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts).
- [Qwen recording implementation](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts).
- [Command Code sessions](https://commandcode.ai/docs/sessions),
  [mod API](https://commandcode.ai/docs/mods), and the official
  [Command Code 1.88.1 distribution](https://www.npmjs.com/package/command-code/v/1.88.1).
- [Gemini hook events](https://geminicli.com/docs/hooks/reference/),
  [Cline SDK hook payloads](https://github.com/cline/cline/blob/main/sdk/packages/core/src/hooks/subprocess.ts),
  [Amp active-thread API](https://ampcode.com/docs/plugin-api),
  [Maki session events and jobs](https://maki.sh/docs/lua-api/), and
  [Herdr foreground-process API](https://herdr.dev/docs/socket-api/).
- [Kilo SQLite schema](https://github.com/Kilo-Org/kilocode/blob/main/packages/core/src/session/sql.ts)
  and [typed messages](https://github.com/Kilo-Org/kilocode/blob/main/packages/schema/src/session-message.ts).
- [OpenCode SQLite schema](https://github.com/anomalyco/opencode/blob/main/packages/core/src/session/sql.ts)
  and [typed messages](https://github.com/anomalyco/opencode/blob/main/packages/schema/src/session-message.ts).
- [Cline persisted session payload](https://github.com/cline/cline/blob/main/sdk/packages/core/src/services/session-data.ts),
  [message types](https://github.com/cline/cline/blob/main/sdk/packages/shared/src/llms/messages.ts),
  [user-run filtering](https://github.com/cline/cline/blob/main/sdk/packages/core/src/session/user-run-messages.ts).

## Additional source evidence

Official source defines the open formats. For closed CLIs, the independent
projects below provide original readers and/or sanitized captures from actual
native sessions; they are empirical evidence, not vendor compatibility promises.

- [Amp thread reader](https://github.com/marcus/sidecar/tree/main/internal/adapter/amp)
  and [official thread commands](https://ampcode.com/docs/threads).
- [Droid reader and format fixtures](https://github.com/getagentseal/codeburn/blob/main/src/providers/droid.ts)
  and [official hooks](https://docs.factory.com/harness/hooks).
- [Maki persistence](https://github.com/tontinton/maki/blob/main/maki-storage/src/sessions.rs)
  and [message provenance/types](https://github.com/tontinton/maki/blob/main/maki-providers/src/types.rs).
- [Kimi Code / Muse native capture contracts](https://github.com/xhluca/session-migrate/blob/main/docs/muse-qwen-kimi-formats.md)
  and [sanitized native corpus](https://github.com/xhluca/session-migrate/tree/main/tests/native_corpus/v1/sources).
- [Antigravity CLI display transcript fixture](https://github.com/getagentseal/codeburn/blob/main/tests/fixtures/antigravity-cli-current/brain/fixture-current-cli/.system_generated/logs/transcript.jsonl).
- [Letta reflection projection](https://github.com/letta-ai/letta-code/blob/main/src/cli/helpers/reflection-transcript.ts).
- [Qoder's official session analyzer](https://github.com/QoderAI/better-harness/blob/main/scripts/session-analysis/platforms/qoder.mjs).
- [Kiro V3 reader and native fixtures](https://github.com/apache/skywalking-ai-sessionizer/tree/main/internal/adapters/kiro).
- [Devin native schema and active-chain contract](https://github.com/xhluca/session-migrate/blob/main/docs/devin-format.md).

## Verification

Focused tests cover exact session identity, ambiguous paths, symlink escape,
hidden context, title refresh, failed tools, history rollback and SQLite V1/V2.
The browser fixtures cover all catalog names on phone, tablet and desktop; they
verify rendering, not native session discovery. Run the opt-in local transcript
scan after CLI upgrades, and record zero-session providers as untested rather
than accepted.

`TestPublicNativeCorpus` optionally checks the reviewed upstream Kimi Code
0.38.0, Muse 0.2.1 and Kiro V3 captures. Set `PAIRFOB_PUBLIC_AGENT_CORPUS` to an
explicit directory containing `kimi-current.jsonl`, `kimi-current-state.json`,
`muse-corpus.jsonl`, `kiro-current.jsonl` and `kiro-current-meta.json` downloaded
from the references above. The ordinary test suite stays offline and uses
small behavior fixtures. Local scans and public captures do not replace a
fresh CLI launch with actual Herdr binding and phone transport.
