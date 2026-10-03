# Agent trace labels

`AgentTraceSummary` accepts an additive optional param `labels: true`. A client
may send it only when `GetConfig.capabilities.trace_labels` is true; older
daemons reject unknown params and absence means false. `AgentTrace` does not
take the param: it already returns the tool input. `labels` and `markers`
(`proto/agent-trace-markers.md`) are independent.

With `labels: true` a summary `tool` item may carry `label`: one line of 1–160
Unicode characters that hints at what the call did. Without the param `label`
never appears, so existing clients keep validating. The label is a display
hint only; the tool body still comes from `AgentTraceDetail`.

The daemon derives it from the tool input, first match wins:

| source | label |
| --- | --- |
| Claude `TodoWrite` `todos[]`, Codex `update_plan` `plan[]` | `<completed>/<total>` steps, such as `3/7` |
| Claude `AskUserQuestion` `questions[0].question`, Codex `request_user_input_async` `questions[0].title` | the first question |
| Claude `Skill` `skill` | the skill name |
| search tools (`Grep`, `Glob`, `grep`, `glob`, `search`, `find`, `rg`): `pattern`, `query`, `regex`, `q`, `search` | the query; the path only scopes a search |
| `command`, `cmd`, `script` | first non-empty line; for an argv array, of its last element |
| `file_path`, `path`, `file`, `target_file`, `filename`, `notebook_path`, `target_directory` | the path as written; the client shortens it |
| apply_patch text (`*** Update/Add/Delete File: X`) | the first file, plus ` +N` for further files |
| Codex code mode (`exec`): `tools.<name>({cmd:...})` calls | the first call's command, or `<tool> · <target>`, plus ` +N` for further calls |
| `pattern`, `query`, `regex`, `q`, `search` | the value |
| `url`, `uri` | the value |
| `description` | the value (subagent tasks) |

Control characters are removed and line breaks become spaces; a longer value is
cut to 159 characters plus `…`. When nothing applies, `label` is omitted. Tool
`detail_ref` values and `next_cursor` positions are identical with and without
labels. If labels would push a page past its byte budget, the oldest labels on
that page are dropped first.

Tool `state` is independent of labels: `error` comes from the agent's own
record (Claude `tool_result.is_error`, Pi `isError`, Grok `status: failed` whatever text came with it) or, for
Codex, from the exit status it prints with the output (`Process exited with
code N`, `Exit code: N`, a JSON `exit_code`) and its `Script failed` /
`apply_patch verification failed` notices. A nonzero exit is `error`.

Release order: ship the PWA that knows `trace_labels` and `trace_times` before
the daemon that advertises them. A PWA built before them rejects the unknown
capability keys and treats the daemon's config as incompatible (fail closed).
