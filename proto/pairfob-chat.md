# pairfob-chat.v1

A local attach protocol between one `pairfob-chat` process and its views
(desktop now, daemon-proxied phone later). It is not part of `pairfob.v1`,
does not touch the relay, and never carries agent credentials.

```
agent <--ACP/stdio--> pairfob-chat --pairfob-chat.v1/unix socket--> desktop
                         |
                         +-- Herdr pane token: pairfob-chat=<id>
```

The process owns the transcript. Views are observers: they send commands and
apply snapshots and changes. The TUI is an in-process view; the desktop is a
socket view.

## Transport

- Unix domain socket at `$XDG_STATE_HOME/pairfob/chat/<id>.sock`, defaulting to
  `~/.local/state/pairfob/chat/<id>.sock`; Windows uses the named pipe
  `\\.\pipe\pairfob-chat-<id>`.
- `<id>` is 16 lowercase hex characters, generated once per process.
- One JSON object per line, UTF-8, no other framing. A line must not exceed
  4 MiB; a larger line is a protocol error and closes the connection.
- The directory is mode 0700; the socket is mode 0600. On Unix the process
  refuses a peer whose uid differs from its own. The desktop refuses a socket
  whose owner or mode fails the same check before connecting.
- At most 8 concurrent views. A ninth connection is closed after an error
  frame.

## Handshake

Client to server:

```json
{"v":1,"type":"hello","client":"pairfob-desktop","cursor":null}
{"v":1,"type":"hello","client":"pairfob-desktop","cursor":{"epoch":"9f2c","seq":41}}
```

`client` is advisory. `cursor` is either null or the last change applied.

Server to client:

```json
{"v":1,"type":"welcome","epoch":"9f2c","seq":42}
```

Then exactly one of:

```json
{"v":1,"type":"snapshot","epoch":"9f2c","seq":42,"state":{...}}
{"v":1,"type":"changes","epoch":"9f2c","changes":[{"seq":42,"ops":[...]}]}
```

The server replays `changes` when the cursor epoch matches and the server still
holds every change after the cursor. Otherwise it sends `snapshot`. The client
applies only `seq == last_seq + 1`; a gap or an epoch change means reconnect
without a cursor.

## State

```json
{
  "id": "0123456789abcdef",
  "title": "claude · pairfob",
  "agent": "claude",
  "status": "starting|idle|working|blocked|exited",
  "entries": [{"id":"...","kind":"user|agent|thought|tool|notice",
               "text":"...","streaming":false,
               "level":"info|warning|error",
               "tool":{"title":"...","kind":"...","status":"...",
                       "content":[{"type":"text","text":"..."},
                                  {"type":"diff","path":"...","old":"...","new":"..."}],
                       "locations":["..."]},
               "at": 1761740000000}],
  "permission": {"id":"0","title":"...","tool_call_id":"...",
                 "options":[{"id":"allow","name":"Allow","kind":"allow_once"}]},
  "plan": [{"content":"...","priority":"high|medium|low","status":"pending|in_progress|completed"}],
  "modes": [{"id":"default","name":"Default","description":"..."}],
  "mode": "default",
  "options": [{"id":"model","name":"Model","category":"model",
               "current_value":"sonnet",
               "choices":[{"value":"sonnet","name":"Sonnet","description":"..."}]}],
  "queue": [{"id":"q1","text":"..."}],
  "auto_accept": false,
  "usage": {"used":31994,"size":1000000,"cost_usd":0.16},
  "error": ""
}
```

`entries` is ordered oldest first. `id` is stable for the life of one entry:
user turns use `user-<n>`, agent and thought chunks use the ACP `messageId`,
tools use `toolCallId`, notices use `notice-<n>`.

## Changes

Each change is a list of ops applied atomically:

| op | fields | effect |
| --- | --- | --- |
| `append_entry` | `entry` | append; duplicate id is an error |
| `set_entry` | `entry` | replace by id; missing id is an error |
| `append_text` | `id`, `text` | append to the entry's text |
| `set_streaming` | `id`, `streaming` | toggle the streaming cursor |
| `remove_entry` | `id` | remove |
| `set_status` | `status` | agent lifecycle |
| `set_permission` | `permission` (null clears) | pending permission |
| `set_plan` | `plan` | ACP plan |
| `set_modes` | `modes`, `mode` | available and current mode |
| `set_options` | `options` | model, effort, and other select options |
| `set_queue` | `queue` | prompts waiting behind the active turn |
| `set_auto_accept` | `enabled` | automatic permission policy |
| `set_title` | `title` | title shown by a view |
| `set_usage` | `usage` | context and cost |
| `set_error` | `error` | fatal adapter error |

## Commands

Client to server:

```json
{"v":1,"type":"command","id":"c1","command":{"kind":"prompt","text":"fix the test"}}
```

| kind | fields | meaning |
| --- | --- | --- |
| `prompt` | `text`, optional `attachments` | send a turn; queues if one is running |
| `cancel` | | cancel the active turn |
| `answer` | `request_id`, `option_id` | answer the pending permission |
| `set_mode` | `mode_id` | ACP mode |
| `set_option` | `option_id`, `value` | ACP config option (model, effort, ...) |
| `unqueue` | `queue_id` | remove a queued prompt |
| `set_auto_accept` | `enabled` | automatic permission policy |

An attachment is `{"name":"...","mime":"image/png","data":"<base64>"}`; only
image attachments are forwarded to ACP. The server rejects an attachment whose
decoded size exceeds 8 MiB.

Server to client:

```json
{"v":1,"type":"result","id":"c1","ok":true}
{"v":1,"type":"result","id":"c1","ok":false,"error":{"code":"unsupported","message":"..."}}
```

Command ids are scoped to one connection and are deduplicated for 5 minutes;
a repeated id returns the first result and never runs the command twice. A
dropped connection does not replay a command.

Error codes: `invalid`, `unsupported`, `busy`, `not_found`, `agent_error`,
`permission_gone`.

`ping` and `pong` are optional liveness frames in either direction.

## ACP mapping

`pairfob-chat` is the ACP client and the pairfob-chat.v1 server.

| ACP | pairfob-chat.v1 |
| --- | --- |
| `initialize` | none |
| `session/new` / `session/load` | initial `modes` and `options` |
| `session/prompt` | `prompt`, `queue` while a turn runs |
| `agent_message_chunk` | `agent` entry, `append_text` |
| `agent_thought_chunk` | `thought` entry, `append_text` |
| `tool_call`, `tool_call_update` | `tool` entry, `set_entry` |
| `plan` | `set_plan` |
| `current_mode_update`, `config_option_update` | `set_modes`, `set_options` |
| `usage_update` | `set_usage` |
| `session/request_permission` | `set_permission`, then `answer` |
| `session/cancel` | `cancel` |
| `session/set_mode` | `set_mode` |
| `session/set_config_option` | `set_option` |

The prompt response (`stopReason`, `usage`) closes the turn and clears the
streaming flags. The server keeps one active prompt; every other prompt waits
in `queue`.

## Herdr registration

After the endpoint listens, `pairfob-chat` publishes the id on the pane:

```sh
herdr pane report-metadata "$HERDR_PANE_ID" \
  --source pairfob-chat --agent pairfob-chat \
  --token "pairfob-chat=$id" --ttl-ms 60000
```

The same call repeats every 20 seconds, so a crashed process loses its token
within one TTL. On a clean exit the token is cleared. The desktop only offers
the Chat view for a pane whose agent metadata contains `pairfob-chat`, and it
only reads its own token.