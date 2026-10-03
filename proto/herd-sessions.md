# Named Herdr sessions

`ListSessions` is an additive, read-only inner RPC on an Established Pairfob
session. It uses the existing encrypted FWD transport. The relay does not
inspect the names or choose a Herdr socket.

## Discovery

Request: `{"v":1,"id":"…","op":"ListSessions","params":{}}`.
Params are an empty object. The result follows `$defs.listSessionsResult` in
[rpc.schema.json](rpc.schema.json):

```json
{
  "sessions": [
    { "name": null, "running": true },
    { "name": "work", "running": false }
  ]
}
```

The default session is always first and has `name: null`. Named sessions follow
in name order, once each. Names are 1–128 ASCII letters, digits, `.`, `_` or `-`,
excluding `.` and `..`. Session directories can outlive their servers;
`running` reports whether the socket accepted a connection during the probe.
It does not describe the panes or promise that a later RPC will succeed.

An older daemon returns `unknown_op`. A runtime without session listing, or
Herdr with multi-session off, returns `unsupported`. The latter
does not expose session names. Invalid params and runtime failures retain the
existing RPC error handling.

## Capability and target

`GetConfig.capabilities.list_sessions` is optional; absence means false.
The PWA sends discovery only when it is true. For Herdr it follows the
multi-session setting without I/O and independently of `Describe`: the default
server may be offline while a named server is running. Other runtimes without
an enabled session lister advertise false.

Session-scoped RPCs that declare `session` in the schema accept an optional
name, including `GetConfig`. Omission or `null` targets the default socket.
`GetConfig` describes the selected session's capabilities and agent kinds;
the discovery capability still follows the daemon's setting.

The connection captures its selected name when issuing a scoped RPC. Already
issued calls retain their target. Selecting default preserves the existing
outgoing request bytes: `GetConfig` still sends `{}`, and `Snapshot` still sends
`{"session":null}`. Daemon-wide RPCs and handle-based media or terminal commands
keep their existing params. Envelope version, cryptography and mux framing
are unchanged.

## Rollout and notifications

Ship the PWA that recognizes `list_sessions` before a daemon that advertises
the key, even when its value is false. Older PWAs reject unknown capability
keys and fail closed. A new PWA talking to an older daemon treats the absent
key as false and sends no discovery probe.

Push notifications remain default-session-only. Their deep links carry
`daemonId` and `paneId`, so a phone currently viewing a named session switches
to default before resolving the pane against a fresh snapshot. The intent
stays pending across that transition; a newer notification or a replacement
connection owns the eventual resolution.

Multi-session is on by default when `PAIRFOB_MULTI_SESSION` is unset or empty
and `HERDR_SOCKET_PATH` is unset or empty. `PAIRFOB_MULTI_SESSION=1` turns it on
even with a pinned socket; `=0` turns it off. With a pinned `HERDR_SOCKET_PATH`,
unset or empty `PAIRFOB_MULTI_SESSION` keeps it off. Other non-empty values
also keep it off. Autostart starts only the default server at the configured
socket, never a named server.
