# Directory index

`DirIndex` is an additive read RPC on an Established Pairfob session. It returns
the directory names this computer allows, once, so the phone can filter them
locally while the reader types a new workspace path. It takes no query and
belongs to no pane: the create sheet opens it before any pane exists.

The block stays frame-level. The relay carries the reply in the same encrypted
FWD envelope as every other RPC and never sees a path.

## Request

`{"v":1,"id":"…","op":"DirIndex","params":{"session":"…","version":"7f3a1c8d9e0b2a4f"}}`

Both params are optional. `session` is the same field as other workspace reads.
`version` is the index the phone already has; the empty string means none.

## Reply

```json
{"version":"9f2c4b1a8e6d0f37",
 "roots":[{"path":"/Users/arron","repo":false,
           "dirs":[{"p":"Project"},{"p":"Project/github/pairfob","r":true}]}],
 "truncated":false}
```

`p` is relative to its root, with `/` separators. `r` marks a directory that
contains `.git` and is left out when it is false, because most rows are not
repositories and the reply is one encrypted frame. The root's own `repo` says
whether the root is a repository.
Roots and rows are sorted. `version` is the FNV-1a 64-bit hash of the roots and
rows as 16 lowercase hex characters, so the same tree always has the same
version and a change gives a new one.

When `version` matches the index this daemon holds, the reply is exactly
`{"unchanged":true}`. The phone keeps its copy and transfers nothing.

`truncated` says the quantity, time or reply-size bound stopped the index. A
client shows that results may be incomplete instead of treating a missing
directory as nonexistent.

## Bounds

| Bound | Value |
| --- | --- |
| Depth per root | 6 |
| Directories across all roots | 10 000 |
| Build wall clock | 3 s |
| One directory listing | 2 s, then the path is remembered as poisoned |
| Index lifetime | 15 min |
| Concurrent listings | min(8, GOMAXPROCS) |
| Encrypted reply | 256 000 bytes; the deepest rows are dropped first, and among one depth the longest path first, so every directory up to depth 5 survives and the size bound costs the least rows |

A call within the lifetime returns the held index. Past it, the call returns the
stale index at once and one background build replaces it, so a reader never
waits on the filesystem. A matching `version` answers `unchanged`; a stale one
also starts that background build. Only the first call, with no index yet,
blocks on the build.

Roots are `PAIRFOB_ALLOWED_ROOTS` plus the live Herdr workspace and pane
directories. A root inside another root is dropped, so no directory is listed
twice. Listing works while Herdr is offline; only the live roots are missing.

The walk is breadth first and skips names that are large, generated, owned by
the OS, or known to block. On macOS, `os.ReadDir` on `~/Desktop`, `~/Documents`,
`~/Downloads` and `~/Music/Music` does not return within 4 s because FileProvider
owns them (measured); `os.Lstat` on the same paths returns in microseconds. The
skip list keeps those out of the build, and the 2 s per-directory timeout is the
backstop for any other such directory. A timed-out listing cannot be cancelled
because the block is in the kernel; its goroutine finishes on its own and the
path is not entered again.

Symlinks are not followed, and only directory names are read: no file contents,
sizes or modification times.

## Why filtering is on the phone

A round trip from this Mac to `pairfob.com` is 250 to 290 ms (measured). Asking
the daemon per keystroke would pause typing for at least that long, twice over.
A local scan of 6 256 names takes 0.89 ms (measured), so the phone keeps the
index and filters it on every keystroke. The whole index is one encrypted RPC
reply, whose plaintext cannot exceed 262 116 bytes, so the index is trimmed to
256 000. This Mac's home measured 4 642 rows and 255 978 bytes after trimming,
with every directory to depth 5 and the rest of depth 6 left out.
The version check keeps later calls to a few dozen bytes.

The index is only a list of candidates. Creating a workspace still runs the
daemon's `pathAllowed` check, exactly as a typed path does, so a stale index
never turns into a guessed success.

## Capability and errors

`GetConfig.capabilities.search_dirs` advertises the RPC. An older daemon does
not carry the key, which means false; the phone then keeps "Enter another path"
and the plain form.

| Code | When |
| --- | --- |
| `invalid_argument` | Bad JSON, unknown fields, a bad session name, or `version` over 64 characters |
| `unknown_op` | Daemon built before this RPC (update pairfob) |
