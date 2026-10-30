# Pairfob for the desktop

A native window over the Herdr session already running on this computer.
Herdr keeps the panes and the programs; this app attaches to the same endpoint
protocol the Herdr app uses, paints the cell frames, and sends keys back. It
does not own a PTY, does not embed libghostty, and does not talk to the relay
except through `pairfob`.

macOS and Linux. Windows is not targeted yet.

`gpui_platform` must be built with its `font-kit` feature (the manifest turns it
on). That feature is what wires CoreText into the macOS platform; without it
GPUI installs a no-op text system, the window still draws every color and box,
and no glyph appears anywhere.

## Build and run

The crate pins Rust 1.98.0 in `rust-toolchain.toml`. `herdr-protocol` needs
1.96 or newer, and `gpui-pre-macos 0.3.10` calls `Option::map_or_default`,
which only became stable in 1.98.0.

```sh
cargo build            # window build (GPUI)
cargo run              # attach to the current Herdr session
cargo run --profile fast   # the same, with optimized dependencies
cargo run -- --self-check
```

An unoptimized debug build paints a full terminal grid slowly enough that
typing feels delayed, so `--profile fast` (optimized dependencies, unoptimized
crate) is what a development session should run. The verification gate stays on
the `dev` profile so its lints do not rebuild the dependency tree.

`--self-check` connects, waits for one snapshot and one surface frame, prints
their counts, and exits. It never opens a window, so it works over SSH and in
CI. `--session NAME` and `--socket PATH` pick a non-default session.

### Performance HUD

A development-only overlay shows FPS, frame cost, dropped frames, and CPU,
GPU and memory while the window runs. It stays behind a non-default feature,
so release builds never carry it:

```sh
cargo run --profile fast --features perf-hud
```

The HUD sits in the top-right corner; F12 hides or shows it. Its figures come
from GPUI's own frame trace and its clock does not drive the frame loop.

## Layout

| Path | Duty |
| --- | --- |
| `src/model.rs` | Sessions, frames, cells, colors. No wire or UI types |
| `src/app/` | State built from events; `input.rs` is the focus-before-send gate |
| `src/herdr/` | The only module that knows `herdr-client` / `herdr-protocol` |
| `src/terminal/` | Frame to draw ops: colors, widths, themes, painting |
| `src/devices/` | Paired devices from `pairfob devices --json` |
| `src/pairing/` | `pairfob pair offer` as a child process, offer stream, QR |
| `src/chat/` | `pairfob-chat` transport, transcript reducer, attachments |
| `src/process/` | Finding Pairfob and Herdr, health, service, session start, session list |
| `src/log.rs` | The log file, its rotation, and the panic record |
| `src/ui/` | GPUI window, session list, terminal surface, overlays, setup screens |
| `testdata/` | Captured frames the paint tests pin themselves to |

## Using the terminal

The wheel scrolls the pane's scrollback; a pane that reports the mouse or is on
the alternate screen gets one wheel step per line instead. Drag to select text
and a plain click clears it. Right-click opens Copy, Select All, Paste, Split
Right, Split Down, Zoom or Unzoom Pane, Close Pane, Rename Pane, Switch to Chat
or TUI, Scroll to Bottom, and the text-size rows. The pane rows appear only when
the daemon advertises the method, and the clipboard rows keep the usual Cmd+C,
Cmd+A and Cmd+V shortcuts. A pane scrolled away from the bottom shows a slim
scrollbar on its right edge.

The title band drags the window, a double-click zooms or minimises it following
the system's double-click setting, and the window resizes from its border.

| Keys | Action |
| --- | --- |
| `Cmd+F` | find in the focused pane's scrollback |
| `Enter` / `Shift+Enter` | next / previous match |
| `Cmd+R` | rename the focused pane |
| `Cmd++` / `Cmd+-` / `Cmd+0` | larger / smaller / default text |
| `Cmd+Opt+arrow` | move focus to the pane in that direction |
| `Cmd+Ctrl+arrow` | swap the focused pane with its neighbour |
| `Cmd+Opt+Shift+arrow` | resize the focused pane toward that edge |
| `Cmd+Shift+F` | filter the session list |
| `Cmd+D` / `Cmd+Shift+D` | split right / down |

### Find

`Cmd+F` floats a search bar over the top-right of the terminal; it never
changes the terminal's box, so the program is not resized while it is open.
Text goes to the daemon's `pane.copy_search` after a 150 ms pause in typing, and
the pane scrolls to the current match. A pane that is still printing answers
"stale"; the window asks again twice, then says so and waits for Enter. `Esc`
closes the bar and clears the highlights. Older daemons that do not advertise
`pane.copy_search` get a notice instead of a bar.

### Links

A `Cmd`-click on a URL opens it in the browser. An OSC 8 hyperlink on the cell
wins over text that merely looks like a URL. Only `http` and `https` are opened;
the URL is one argument to `open` or `xdg-open` and never passes through a
shell.

### Text size

`Cmd++` and `Cmd+-` change the cell size by one point, `Cmd+0` returns to the
default. The size is saved with the window geometry and the terminal is resized
to the new cell count, so the program sees the change the way it would see a
window resize.

## Sessions

The toolbar shows **Sessions** when this computer has more than one Herdr
session. The drawer lists the default session and every named session under
`~/.config/herdr/sessions`, each with its socket and a dot that means the socket
accepts a connection right now. **Switch** reconnects the engine in place: the
pane list, terminal and chat view reset to the new session, and the old
session's panes keep running for whoever else is attached.

## Chat

`Cmd+Shift+M` or the toolbar's TUI/Chat switch shows the pane's `pairfob-chat`
transcript in place of the terminal. The switch sends no engine command and
does not resize the PTY, so the agent keeps the same box while you read it.

Images go with the next prompt three ways: the composer's 📎 button opens the
file picker, a drop on the chat column attaches the dropped files, and a paste
of an image from the clipboard attaches it when the composer is open. Each
attachment is capped at 8 MiB and its mime is sniffed from the bytes, never
from the file name or extension; a file that is not an image is refused with
its name and the limit in the message.

## Troubleshooting

The window writes `pairfob-desktop.log` under `~/Library/Logs/Pairfob` on macOS
and `$XDG_STATE_HOME/pairfob-desktop` (usually `~/.local/state/...`) on Linux.
The file rotates at 2 MiB, and a panic is recorded there before the process
exits. Nothing logs a pairing code, an offer URL, a QR payload, a key, or
clipboard contents.

The ⋯ button's Diagnostics drawer shows the build, the connection state, the
last 40 log lines and the output of `pairfob doctor`. **Copy diagnostics**
puts all of that on the clipboard as one block to paste into a bug report.

## Devices

The toolbar's **Devices** button opens a drawer listing the devices paired to
this computer. Each row shows a green dot while that device holds a session,
the last-seen or connected phrase, and when it was paired. **Unpair** asks for
confirmation and revokes the credential through `pairfob devices revoke`;
**Pair a device** at the bottom opens the pairing sheet. The drawer refreshes
every three seconds while it is open and does no polling once it closes.

## Updates

Pairfob Desktop checks `https://dl.pairfob.com/desktop/release.json` when the
window opens and every six hours. An available update puts a small accent dot
on the toolbar's ⋯ button; the Diagnostics drawer carries the version, the
status and the actions. **Update** downloads the build for this platform,
checks its SHA-256 against the manifest, replaces the executable, runs
`--version` on the new binary, and relaunches. The previous build stays as
`.<name>.update-backup` beside the executable until the next update.

Nothing is installed until the user asks for it, and the update only replaces
the desktop executable: the daemon and `pairfob-chat` keep their own updater.
The install location must be writable by the user; if it is not, the drawer
reports the failure and leaves the current build in place.

Development overrides:

| Variable | Effect |
| --- | --- |
| `PAIRFOB_DESKTOP_UPDATE=off` | do not start the checker |
| `PAIRFOB_DESKTOP_UPDATE_BASE=URL` | use another channel; HTTPS, or HTTP on loopback |

The desktop release channel is independent of the daemon and Android channels.
Build it with `VERSION=vX.Y.Z ./scripts/release-desktop.sh` (the default target
is the host; `PAIRFOB_DESKTOP_TARGETS` takes a space-separated list of Rust
triples), then publish with
`./scripts/publish-desktop.sh --source dist/desktop --deploy`. Run the build
with the same `VERSION` and `OUT` on each OS to add a platform to that version;
the script keeps the other platform binaries and rewrites the shared checksum
inventory. Use a fresh `OUT` when the version changes. A release built on one
OS may add its platform to a version already on the channel, but a new version
must include every platform the live channel carries.

## Verification

```sh
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo test --no-default-features
PF_DESKTOP_LIVE=1 cargo test --test live -- --ignored --nocapture
```

`./scripts/verify.sh` runs the first four through `scripts/verify-desktop.sh`.
The live tests attach to an existing session named `pffixture` (override with
`PF_DESKTOP_LIVE_SESSION`), never send input, and never start or stop a server.
`tests/search_live.rs` picks a word off the live screen and asks the daemon's
`pane.copy_search` for it, so find is checked against the scrollback owner and
not only against the cells the window happens to hold;
create one with `herdr --session pffixture server` before running them. They
are skipped without `PF_DESKTOP_LIVE=1`.

The window itself can be checked without the screen recorder, which is useful
when macOS Screen Recording permission is missing:

```sh
PF_DESKTOP_SHOT=/tmp/window.png cargo run --features shot -- --session pffixture
```

It renders the live window through GPUI's own Metal renderer to an RGBA PNG and
quits. The `shot` feature is never part of the default build. Two more
variables make the overlays and the narrow layout reachable without moving the
real window:

```sh
PF_DESKTOP_SHOT=/tmp/pairing.png PF_DESKTOP_SHOT_OPEN=pairing \
  cargo run --features shot -- --session pffixture
PF_DESKTOP_SHOT=/tmp/narrow.png PF_DESKTOP_SHOT_SIZE=820x900 \
  cargo run --features shot -- --session pffixture
```

`PF_DESKTOP_SHOT_OPEN` takes `pairing`, `diagnostics`, `devices`,
`devices-confirm`, `menu`, `chat`, `find`, `rename` or `sessions`. The pairing sheet then uses an invented code and
never starts a real offer, so no live code can reach an image; the devices
drawer uses three invented rows and never runs the CLI, and `devices-confirm`
opens the first row's unpair question; the menu shot selects the focused pane's
first two rows, opens the menu over that selection, and never reads or writes
the clipboard. `PF_DESKTOP_SHOT_UPDATE=available` (or `up-to-date`, `failed`)
paints that update state in the Diagnostics drawer; pair it with
`PAIRFOB_DESKTOP_UPDATE=off` so the real checker does not replace it. The
`find` shot carries an invented `3 of 17` and draws no highlights, the `rename`
shot prefills a label, and the `sessions` shot lists three invented sessions;
none of them reads or writes a real one.

## What the window does not do yet

macOS signing, notarization and Linux packaging are not built, so the update
channel ships unsigned executables.
