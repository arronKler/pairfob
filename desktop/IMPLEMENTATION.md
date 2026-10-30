# Desktop landing: independent Herdr client, splits, and Pairfob chat

This is the execution trail for the design in `design/desktop-sidebar/index.html`
(local only). It records the predicate, the units, and the verification for each
unit.

## Definition of done

The landing is done when all of these are true on the final working tree:

1. `bash scripts/verify-desktop.sh` exits 0.
2. `go test ./internal/chat/...` exits 0.
3. `./scripts/verify.sh` exits 0 on the final candidate.
4. `cargo tree -p pairfob-desktop` contains no `herdr-client`,
   `herdr-protocol`, or other crate from another Herdr client.
5. `PF_DESKTOP_LIVE=1 cargo test --test live -- --ignored` passes against the
   `pffixture` session.
6. A real `pairfob-chat claude` session in a Herdr pane registers
   `pairfob-chat`, accepts a prompt, answers a permission, and the desktop's
   Chat view sees the same transcript as the TUI.
7. Splits can be created, focused, zoomed, closed, and dragged; the pane grid
   is the only thing that resizes.
8. The window renders at 1440, 1080, and 900 wide in dark and light, follows
   the system appearance, and has no horizontal overflow.
9. Chat performance: first visible token differs from TUI by at most 16ms,
   every streamed change is applied, and a 2,000-entry transcript scrolls
   without dropped frames on the recorded machine.
10. Every handwritten file is at most 800 lines.

## Units

Units run riskiest-unknown first. Each unit ends with its own check; a unit is
kept only when the check is green, otherwise the change is reverted.

### 00 Baseline and harness

Capture real endpoint frames from `pffixture` before replacing the external
client, so the independent decoder is checked against bytes Herdr produced.
Fix the pre-existing flaky deadline test in `tests/process.rs`.

Check: `cargo test --test process`, `cargo test --test capture_endpoint`.

### 01 Pairfob-chat contract

`proto/pairfob-chat.md` defines `pairfob-chat.v1`: hello/welcome, snapshot and
change ops, commands, cursor/epoch, command-id dedupe, socket permissions.
`internal/chat/protocol` is the Go implementation and the only transcript
reducer.

Check: `go test ./internal/chat/protocol`.

### 02 ACP client

`internal/chat/acp` speaks the public Agent Client Protocol over the adapter's
stdio: initialize, session/new, session/prompt, session/update,
session/request_permission, cancel, set mode, set config option, load. It uses
a fake adapter in tests and the installed adapters for the live check.

Check: `go test ./internal/chat/acp`, then a real one-turn Claude probe.

### 03 Pairfob-chat endpoint and token

The Unix socket endpoint, hello/welcome, snapshot/change replay, command
dedupe, and owner-only permissions live in `internal/chat/endpoint`. The
process registers `pairfob-chat` through `herdr pane report-metadata` with a
TTL heartbeat.

Check: `go test ./internal/chat/endpoint`, socket mode/owner test.

### 04 Pairfob-chat TUI and command

`internal/chat/tui` renders the transcript through bubbletea, including the
permission prompt, mode/model controls, queue, cancel, and scroll. `cmd/pairfob-chat`
wires the ACP adapter, transcript hub, endpoint, TUI, and token heartbeat.

Check: `go test ./internal/chat/tui`, `go build ./cmd/pairfob-chat`, live
`pairfob-chat claude` turn.

### 05 Independent Herdr endpoint

`desktop/src/herdr/wire` implements endpoint generation 1 from the public
contract (Apache-2.0), split by duty into `messages`, `snapshot`, and `surface`:
bincode framing, hello/welcome, snapshot (JSON control), surface and surface
patch, semantic input, and the server message set. `connect.rs` owns socket
discovery, hello/welcome, request/response correlation against the snapshot's
boot id, one endpoint command in flight at a time, frame subscription, and
timeouts. `engine.rs` and `map.rs` switched to it, and `Cargo.toml` dropped
the external crates.

Check: decode captured fixtures, live self-check, live events test.

Result 2026-10-29: `cargo tree` has no Herdr crates. The independent live test
`tests/connect_live.rs` connects to `pffixture`, reads the welcome, JSON
snapshot, bincode surface, and a `pane.focus` response:
`test connects_and_reads_a_snapshot_surface_and_focus_response ... ok`.
The server sends the snapshot as `EndpointControl{kind:"shell.snapshot.v1"}`
JSON, while surfaces stay bincode `ServerMessage::PaneSurface`; the first
version of `connect.rs` only decoded the bincode snapshot variant and hung,
which the live test caught. `tests/capture_endpoint.rs` was deleted after
capturing the fixtures.

### 06 Splits and focus

Engine commands for `pane.split`, `layout.set_split_ratio`, `pane.zoom`,
`pane.close`, `pane.focus`, `tab.focus`, `workspace.focus`; `ServerInfo.methods`
gates the UI; splitter hit areas, drag, double-click equalize, keyboard zoom.

Check: request JSON unit tests, live split/zoom round trip, screenshots.

### 07 Two-level navigation

Workspace groups and pane rows, single-pane collapse, tab segments in the
toolbar, row tab chips, status aggregation and selected color, filter with a
real text input, row menus, footer, sidebar resize and collapse, shortcuts,
and each pane's agent mark (a monogram when the kind has none) with the status
as a corner dot.

Check: model/row tests, 1440/1080/900 screenshots, keyboard/filter checks.

### 08 Appearance

Light chrome, light terminal palette, system appearance observation, manual
override, and synchronized terminal palette.

Check: dark/light screenshots, palette contrast tests, system switch test.

### 09 Desktop chat view

Chat attach client, transcript model, virtualized view, composer, permission
cards, plan, mode/model menus, queue, and per-pane TUI/Chat switch that never
resizes the PTY.

Check: attach replay test, chat reducer tests, a real `pairfob-chat` process
with a fake ACP adapter driven over its socket, and chat screenshots at 1440,
720 with the widest sidebar, 620 and 500 wide (full, compact toolbar, compact,
pane-too-narrow).

### 10 Packaging and performance

`scripts/release.sh` builds `pairfob-chat-{os}-{arch}` and `SHA256SUMS`;
`scripts/install.sh` installs it beside `pairfob`. The development HUD shows
live frame timing. On 2026-10-29 a release-mode probe on this machine measured
the paint pass of a captured 120x40 frame at 515 us per frame, and one streamed
`append_text` against a 10,000-entry transcript at 7.4 us. Both cover list and
op generation only; glyph rasterization happens later in the canvas.

Check: release artifact listing, full `./scripts/verify.sh`.

### 11 Desktop update channel

`/desktop/release.json` lists a version, source commit and one SHA-256 per
published platform. The desktop checks it at launch and every six hours, marks
an available update on the toolbar, and installs only after the user asks:
download with `curl`, verify size and SHA-256, replace the executable at
`current_exe`, run the new binary's `--version`, and relaunch. A failed check
restores the previous executable. `scripts/release-desktop.sh` builds the
artifacts; `scripts/publish-desktop.sh` hydrates the daemon and Android channels
before deploying the download Worker, then verifies every live desktop byte.

Check: `cargo test --test update`, `bun test src` in
`workers/pairfob-downloads`, `python3 scripts/download-channel.test.py`, and the
Diagnostics screenshot.

## Decision log

- 2026-10-29: independent endpoint client and Pairfob-owned chat host are the
  base. No other client's crates, programs, or private protocols.
- 2026-10-29: chat transport is newline-delimited JSON over a user-only Unix
  socket; the transcript reducer is the only writer of state.
- 2026-10-29: terminal and chat share a pane, never a layout. Switching views
  sends no engine command and does not resize the PTY.
- 2026-10-29: the TUI and the desktop are both attach clients of pairfob-chat;
  TCP/relay is not involved in this phase.
- 2026-10-29: the transcript list is top-aligned and follows the tail only
  while it is already at the end, so a short chat starts at the top and a
  reader who scrolled up is not pulled back down.
- 2026-10-29: the virtualized list needs `.w_full().h_full()`; a flex parent
  otherwise hands it a zero-height measure and paints no rows.
- 2026-10-29: a window screenshot draws one frame before `render_to_image`,
  because macOS does not commit a scene while the window is occluded.
- 2026-10-29: the toolbar compacts on content width, not window width. Below
  440 the Pair label shortens to "Pair" and the gaps tighten; below 470 the
  footer drops its shortcut hints. Without this, the 720px minimum window with
  the widest sidebar pushed the ⋯ button off the right edge.
- 2026-10-29: agent marks are copied from the PWA's asset table
  (`pwa/src/shared/ui/primitives/agent-icons.ts`) and drawn monochrome at 15px,
  tinted by the theme. Kinds whose mark is multi-color or finely detailed
  (Hermes, Kimi, Kiro, Qoder, Trae, Muse, Maki, OpenHands, Droid, Devin) draw a
  two-letter monogram instead, because a single tint flattens them.
- 2026-10-30: Herdr sends one full surface on attach and row-level
  `PaneSurfacePatch` frames as the focused pane repaints, even though the hello
  does not ask for deltas. The reader forwards patches and the engine applies
  them to the surface it holds. Treating a patch as a protocol error tore the
  connection down on the next repaint, which reconnected every 250ms while an
  agent was working; that was the reconnect storm. A patch whose base revision
  no longer matches triggers one clean reconnect rather than a stale screen.
- 2026-10-30: the appearance shortcut toggles instead of cycling. Under auto,
  cycling landed on the scheme already showing, so the first press looked like
  nothing happened. `Auto`, `Light`, and `Dark` are now picked in the
  diagnostics drawer (⋯), and any pick is saved immediately.
- 2026-10-30: the reconnect counter resets only after a connection has lived
  three seconds. A server that accepts and immediately drops now backs off to
  four seconds instead of reconnecting in a tight loop.
- 2026-10-30: the Devices drawer reads `pairfob devices --json` rather than
  opening the admin socket from Rust, so the desktop keeps one CLI seam and the
  device identity rules stay in the daemon. It replaces the toolbar Pair button
  (compact "▣") so the compact toolbar keeps the same control count at the
  720px minimum width; pairing moves into the drawer footer.
- 2026-10-30: the context menu is built from a plain `MenuState` and
  capability-gated sections, so a pane row appears only when the welcome
  advertises the method. Pane actions return focus to the canvas and the chat
  switch never resizes the PTY.
- 2026-10-30: desktop updates use the daemon's trust model (HTTPS manifest plus
  SHA-256, no separate signature) and are user-confirmed. The updater replaces
  only the desktop executable, never the daemon or `pairfob-chat`.
- 2026-10-30: a release built on one OS may add its platform at an existing
  version; a new version must include every platform the live channel already
  carries, so publishing a partial build cannot strand another platform.
- 2026-10-30: the session list stuttered while scrolling because every repaint
  draws the whole window, and the terminal canvas re-emitted a primitive per
  glyph into the scene's bounds tree. A frame of the captured chat pane cost
  12.2ms p50 that way. The canvas now paints inside one `paint_layer`, which is
  how GPUI paints a text line, so the layer takes one z-order instead of one
  per glyph; the cursor, split preview and scrollbars stay outside it so they
  still draw above text. The ops are also cached against the frame, theme and
  selection they were built from, so a frame that only moved a scroll offset
  skips the cell walk. The same pane now paints in 4.9ms p50 (8.8ms with the
  layer off, 12.2ms before both).
- 2026-10-30: scrollback search is a `pane.copy_search` round trip, not a scan
  of what the window holds. The window only has the visible cells, and the
  daemon is the owner of the retained scrollback. The bar floats over the
  terminal so opening it never changes the PTY's size, and a `stale_content`
  answer is retried twice against the newer revision before it is shown.
- 2026-10-30: `Cmd+F` is find in scrollback and the session filter moved to
  `Cmd+Shift+F`, matching every editor on the platform. The filter bar and the
  footer both say the new chord.
- 2026-10-30: text size is a saved geometry field. Changing it re-measures the
  cell, clears the glyph cache and lets the normal resize path tell the program
  about the new cell count, so no separate font-size plumbing exists.
- 2026-10-30: a URL opens on `Cmd`-click only. A plain click still starts a
  selection, which is what a click on text must keep doing, and only `http` and
  `https` cross the process boundary.
- 2026-10-30: switching Herdr sessions shuts the engine down and builds a new
  one in the same window instead of relaunching the app. The window's view
  state (selection, menus, find, rename, chat) resets because every pane id it
  held belongs to the session that just left.
- 2026-10-30: the session drawer lists sockets, not processes. A dot means a
  connect succeeded within 200ms, which is enough to tell a live session from a
  leftover directory.
- 2026-10-30: the desktop keeps its own log file and a Copy diagnostics block
  (build, socket, log tail, doctor). The log deliberately never carries a
  pairing code, offer URL, QR payload, key material or clipboard contents.
- 2026-10-30: chat attachments are capped at 8 MiB and their mime is sniffed
  from the bytes. A pasted image is named by the window, never by the
  clipboard, so no path or title from another program reaches the agent.