# Workspace file download (P2P only)

`WorkspaceDownloadOpen`, `WorkspaceDownloadOpenAtRoot`, `WorkspaceDownloadRead`
and `WorkspaceDownloadClose` are additive inner RPCs on an Established Pairfob
session. They stream one live workspace file from the daemon to the phone in
64 KiB chunks so the phone can write it to disk without holding the whole file
in memory.

These operations are **P2P-only**. The client refuses to send them on relay and
the daemon refuses `WorkspaceDownloadOpen` unless the authenticated session's
current transport is `p2p`. The relay/DO never sees a file byte: the bytes use
the same encrypted FWD envelope over the WebRTC DataChannel that already
carries terminal and workspace RPCs. The existing `WorkspaceMedia*` preview
path stays available on relay for its smaller, buffered files.

The operations are not mutations: they take no `operation_id`, never write a
file, and are absent from the mutation capability vocabulary. The additive
`GetConfig.capabilities.download_file` key advertises them; absence on an older
daemon means false. An older daemon returns `unknown_op`; the phone treats only
that code as “update the daemon”.

## Limits

| Limit | Value |
| --- | --- |
| File size | 1 GiB (`1073741824` bytes) |
| Chunk | 65 536 bytes |
| Open timeout | 20 s |
| Handles per session | 2 |
| Handles per daemon | 8 |
| Idle handle lifetime | 120 s after Open or last Read |
| Absolute handle lifetime | 30 min after Open |
| Concurrent Open/Read RPCs | 2, separate from media previews |
| Session disk and network rate | 8 MiB/s, 256 KiB burst |
| Global disk and network rate | 32 MiB/s, 1 MiB burst |

Disk quota is charged for the sniff at Open and again for every Read. Network
quota is charged for canonical standard-base64 payload bytes. Tokens already
taken are not refunded. A second Read on the same handle is `rate_limited`; the
client reads sequentially.

## Open

Request: `{"v":1,"id":"…","op":"WorkspaceDownloadOpen","params":{"pane_id":"…","path":"dist/app.zip"}}`.
Optional `session` is the same field as other workspace reads. The root-bound
variant `WorkspaceDownloadOpenAtRoot` additionally requires the exact `root`
the client was shown; a changed root is `conflict`.

The pane must exist. The live pane cwd (else workspace cwd) is the canonical
root. `path` is a relative workspace path: UTF-8, no NUL/controls, no `..`,
not `.git`. The leaf must be a regular file; a leaf symlink or non-regular file
is rejected. Opening is rooted at the live directory (`os.Root`) and uses
`O_NOFOLLOW|O_NONBLOCK` on Unix. The same size, mtime and regular-file identity
are rechecked before the handle is published.

Open reads only the sniffed head (64 KiB or the file size if smaller), not the
whole file. It rejects a file above the size cap before that read. There is no
whole-file SHA-256 at Open: a 1 GiB file must not require a 1 GiB hash before
the first byte.

Result fields:

- opaque `handle` (`dl_` + 32 lowercase hex)
- relative `path`
- sniffed `kind` (`image`, `video`, `audio` or `download`) and `mime`
- `size`, `modified_ms`
- `revision`: SHA-256 of the sniffed head, the decimal size (64-bit big
  endian) and the mtime (nanoseconds, 64-bit big endian), as 64 lowercase hex.
  This is a **resume identity**, not a whole-file digest. A client compares it
  (with `size` and `modified_ms`) before resuming an offset.
- `expires_ms`, `chunk_bytes` (65536), `max_bytes` (the 1 GiB cap)

## Read

Request params: `handle`, `offset` (0…1 GiB), `length` (1…65536). Each Read
revalidates:

- the handle belongs to this exact Established session and is a download handle
- the pane still exists and the canonical live root still equals the root
  captured at Open (cwd change is `conflict`)
- the directory entry is still the same regular file (`os.SameFile`, size,
  mtime)
- the open descriptor still matches

Result: `handle`, `offset`, actual `length`, canonical standard-base64 `bytes`
(alphabet `+/`, padding `=`, no whitespace), and `eof`. `offset == size` returns
empty `bytes`, `length` 0, `eof` true. `offset > size` is `invalid_argument`.

There is no server-side resume state and no mixed-version prefix. A client that
lost the transport opens again, compares `size`/`modified_ms`/`revision` with its
partial file, and continues at its last durably written offset. If the file
changed, it starts over or reports the conflict; the daemon never replays a
chunk automatically.

## Close

Params: `handle`. Missing, expired, or already-closed handles still return
`{"handle":"…","closed":true}`. Close releases the descriptor and does not take
a read slot. Session teardown, expiry, a P2P→relay fallback, or a revoked device
also close every handle.

## Errors

| Code | When |
| --- | --- |
| `forbidden` | Path traversal, `.git`, leaf symlink/non-regular file, or the session is not P2P |
| `workspace_not_found` | Missing pane/file, unknown/expired handle |
| `too_large` | File exceeds 1 GiB |
| `conflict` | File, cwd or root changed under the handle |
| `rate_limited` | Handle quota, RPC slots, a second in-flight Read, or a quota wait |
| `invalid_argument` | Bad JSON, unknown fields, bad path/handle/offset/length |
| `unknown_op` | Daemon built before these RPCs (update pairfob) |
| `internal` | Unexpected I/O after the file was authorized |

## Phone behaviour

The phone never requests a download on relay. Two writers are available:

- **File System Access API** (`showSaveFilePicker` + `createWritable`): the
  save picker is opened synchronously from the user's tap, then each RPC chunk
  is written to the chosen file. This is the path on Chromium desktop and
  Android Chrome.
- **Service worker pump**: browsers without the picker (notably Safari) open a
  same-origin `<scope>/__pairfob_download__/<id>` iframe, where `<scope>` is the
  page's service-worker scope (`/`, or `/pair/` for a phone that paired from
  `/pair`). The service worker responds
  with a `Content-Disposition: attachment` stream and pulls one chunk at a time
  from the page over a `BroadcastChannel`; the page reads the RPC and posts the
  chunk back. One outstanding request is the backpressure, so the page never
  buffers the file.

If neither writer exists, the phone reports that this browser cannot save the
file instead of falling back to the relay or buffering the whole file. The
Capacitor shell needs its own native file-write/share bridge; Chrome's download
behaviour inside a WebView is not assumed.

A saved file of at most 32 MiB is then kept in memory and offered to the system
share sheet (`navigator.share` with the `File`), which is how a phone opens it:
no web API starts a saved path in its default app. Larger downloads stay on the
device with nothing held in the page.

The phone caps its own request at the daemon's advertised `max_bytes`, shows
bytes saved, and can cancel. Cancelling closes the handle, aborts the writable,
or cancels the service-worker stream. There is no automatic retry of the
download RPC; a transient failure can be retried by opening a fresh handle.
