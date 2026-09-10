# Workspace media preview

`WorkspaceMediaOpen`, `WorkspaceMediaRead`, and `WorkspaceMediaClose` are
additive, read-only inner RPCs on an Established Pairfob session. They use the
existing encrypted FWD transport. The origin never sees plaintext bytes. No
Worker HTTP path and no R2 object is added.

`WorkspaceRead` is unchanged: it still returns at most 128 KiB of text and a
**prefix** SHA-256. That prefix revision is not a whole-file media digest and
must not be reused as one.

These operations are not mutations. They do not take `operation_id` and they
do not write files. They are absent from the eleven `GetConfig.capabilities`
keys. An older daemon returns `unknown_op` on an authenticated Established
connection; the phone treats **only** that code as “update the daemon”. Other
errors (`forbidden`, `too_large`, `conflict`, `rate_limited`, …) stay
themselves.

## Limits

| Limit | Value |
| --- | --- |
| Image file | 10 MiB |
| Video, audio, download | 32 MiB |
| Decoded image pixels | 16 777 216 (and 8192 on either edge) |
| Raw chunk | 65 536 bytes |
| In-flight chunks per handle | 1 |
| Handles per Established session | 4 |
| Handles per daemon | 16 |
| Concurrent media RPCs (Open/Read) | 2, separate from the 4 workspace-text slots |
| Session disk hash/read rate | 8 MiB/s, 256 KiB burst |
| Global disk hash/read rate | 32 MiB/s, 1 MiB burst |
| Session network payload rate | 2 MiB/s, 256 KiB burst |
| Global network payload rate | 8 MiB/s, 1 MiB burst |
| WorkspaceMediaOpen deadline | 20 s (phone and daemon; other reads stay 8 s) |
| Idle handle lifetime | 120 seconds after Open or last Read |
| Absolute handle lifetime | 10 minutes after Open |

File-size eligibility (stat vs 32 MiB, then kind cap after a 64 KiB sniff) is
not a token-bucket request. Disk admission happens **before** every bounded
hash/read chunk, including the sniff. Network admission is independent and
happens on each Read. Burst is never enlarged to the file cap; a 256 KiB + 1
file is admitted as 64 KiB pieces.

Disk quotas charge filesystem bytes. Network quotas charge canonical
standard-base64 **payload** bytes (the JSON `bytes` field length via
`EncodedLen`), not AEAD/envelope wire size. Repeated range reads are charged
again. Quota waits use the session Open/Read context and do not hold `sendMu`.
Tokens already taken are not refunded on cancel. Disconnect cancels in-flight
Open work and drops the session buckets so a later admit cannot recreate them.

Open hashes at most 32 MiB through a 64 KiB buffer and keeps the `*os.File`,
not a second copy of the bytes. Context cancel is observed between chunks; a
single regular-file `ReadFull` is not interrupted. Close, expiry, and session
teardown close the file. JSON results stay under the 210 KiB workspace JSON
budget; 64 KiB of canonical standard-base64 is ~87 KiB.

## Open

Request: `{"v":1,"id":"…","op":"WorkspaceMediaOpen","params":{"pane_id":"…","path":"src/cat.png"}}`.
Optional `session` is the same field as other workspace reads.

The pane must exist. The live pane cwd (else workspace cwd) is the canonical
root. `path` is a relative workspace path: UTF-8, no NUL/controls, no `..`,
not `.git`. The leaf must be a regular file. Opening is rooted at the live directory
(`os.Root`) and uses `O_NOFOLLOW|O_NONBLOCK` on Unix so leaf symlinks and FIFO
replacement cannot escape or block a media slot. Authorization stays bound to
that opened object; later reads `fstat` the fd and `Lstat` the same
root-relative name. Image files without parseable dimensions fail `too_large`
before decode. The session must still be Established when the handle is
installed; a disconnect during Open closes the file and does not publish a
handle.

The daemon sniffs magic, not the client’s claimed type:

- PNG / JPEG / GIF / WebP → `kind: "image"` with `image/png`, `image/jpeg`,
  `image/gif`, or `image/webp`
- SVG (`<svg` / `<?xml`…`<svg`) → `kind: "download"`, `image/svg+xml`. SVG is
  never an image and must never be executed as HTML
- Typical audio/video containers → `audio/*` or `video/*`. The phone plays
  them only with the browser’s native element; the protocol does **not** claim
  every MP4/MOV will play
- Anything else under 32 MiB → `kind: "download"`

Oversize files fail with `too_large` **before** the full-file hash. Image
headers that decode to more than 16 777 216 pixels or an edge above 8192 also
fail with `too_large`.

Result fields (`workspaceMediaOpenResult`): opaque `handle` (`media_` + 32
lowercase hex), relative `path`, `kind`, sniffed `mime`, `size`,
`modified_ms`, whole-file `sha256` (64 lowercase hex), `expires_ms`,
`chunk_bytes` (65536), `max_bytes` (the cap that applied), `max_pixels`,
`width`, `height` (0 when unknown).

## Read

Request params: `handle`, `offset` (≥ 0), `length` (1…65536). The handle must
belong to this Established session. Each Read revalidates:

- session still Established and owns the handle
- pane still exists
- canonical live root still equals the root captured at Open (cwd change is
  `conflict`)
- directory entry is still the same regular file (`os.SameFile`, size, mtime)
- the open fd still matches

A changed, replaced, or deleted file is `conflict` or `workspace_not_found`.
Do not return mixed prefixes from two versions.

Result: the requested `handle` and `offset`, actual `length`, canonical
standard-base64 `bytes` (alphabet `+/`, padding `=`, no whitespace; encoding
the decoded bytes must reproduce the string), and `eof`.

`offset == size` returns empty `bytes`, `length` 0, `eof` true. `offset > size`
is `invalid_argument`.

## Close

Params: `handle`. Missing, expired, or already-closed handles still return
`{"handle":"…","closed":true}`. Close does not take a media RPC slot so a
saturated daemon can still release files.

## Errors

| Code | When |
| --- | --- |
| `invalid_argument` | Bad JSON, unknown fields, bad path/handle/offset/length |
| `forbidden` | Traversal, `.git`, leaf symlink, non-regular file |
| `workspace_not_found` | Missing pane, missing file, unknown/expired handle |
| `too_large` | Over the kind cap or pixel cap |
| `conflict` | File or cwd changed under the handle |
| `rate_limited` | Handle quota or media RPC slots or a second in-flight Read |
| `unknown_op` | Daemon built before this RPC (update pairfob) |
| `internal` | Unexpected I/O after the file was authorized |

`unsupported` is not used for “old daemon”.

## Phone behaviour

Images auto-load when selected. Video and audio show size and an explicit Load
control; they do not autoplay. The player is a blob URL created only after
every chunk is read and the SHA-256 matches Open. Seeking uses that complete
blob. Downloads use the same cap and blob path. Failures release the handle
and revoke the blob URL. There is no resume across sessions, no Cache Storage,
no IndexedDB, and no workspace text-cache entry for media bytes.
