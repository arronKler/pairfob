# Create and split response time

Creating a conversation, tab or split waits on two things the reader cannot see:
the computer making the pane, and the phone folding the dashboard snapshot in
before it shows the new pane. The catalog read sat in front of the result on the
client and was worth removing. The daemon's own shell-readiness wait was
investigated and stays; see below for why.

## What changed

- **The client opens the pane from the mutation's answer.**
  `selectCreatedPane` used to `await refreshFromSession()` — a full Snapshot and
  a pane read — before it could even select the new pane. It now opens
  immediately and folds the Snapshot in alongside
  (`pwa/src/features/operations/created-pane.ts`). The create's own `agent_kind`
  is passed as a hint to the open path, so a remembered or default agent-chat
  mode still sees the agent on a pane the dashboard has not learned about yet
  (`pwa/src/features/connection/controller.ts`, `open-pane.ts`).
- **The created pane is held until a fold confirms it.** A Snapshot that was
  already in flight when the mutation answered predates the pane. While the
  create's grace is live, that fold does not treat the pane as gone, the desk's
  session column stays mounted, and its `paneActivated` recency is kept
  (`session-store.ts`, `snapshot.ts`, `layout-input.ts`).
- **The catalog fold after a create is quiet.** It runs alongside the open; a
  failed read must not paint an error over the success the reader was just
  shown. The ordinary poll still reports later failures
  (`refreshCatalogQuietly` in `connection/controller.ts`).
- A create aimed at the board, and a split aimed at an explicit board target,
  still wait for their catalog read before they focus or mark the new tile: the
  board reveals by catalog identity, so there is nothing to focus until the
  fold produces it.
- The create sheet's submit button now carries the pending state itself: a
  spinner and the operation's own label while the sheet waits on the computer
  (`pwa/src/features/operations/create-sheet.tsx`).

No envelope, RPC, operation-id or retry rule changed. `unknown_outcome` still
only refreshes.

## Why the daemon's shell wait stays

`startAgentOnPane` calls `waitCreatedShell` before `agent.start`: poll
`pane.process_info` every 100 ms until a foreground shell has no foreground
child and stays that way for 300 ms, up to 5 s. The socket API's
`agent.start.timeout_ms` is a startup timeout, not a blocking readiness wait:
on the installed Herdr 0.9.3, `agent.start` requests in
`~/.config/herdr/herdr-server.log` complete in 2–40 ms, while the launcher
(codex, node) takes far longer to become interactive; readiness is reported
asynchronously as `interactive_ready` / `launch_pending` in the snapshot
(`internal/runtime/herdr_observe.go`). The `herdr agent start` CLI's documented
"wait for interactive readiness" is a client-side wait, not the socket call the
daemon makes.

An independent review reproduced the failure on Herdr 0.9.3: with a two-second
shell initialization command already running, native `agent.start` rejected
the pane as `agent_pane_busy` in 3.39 ms and 2.20 ms despite `timeout_ms=30000`.
After initialization, the same calls succeeded. Pairfob compensates a rejected
start by closing the newly created resource, so removing this gate can turn a
valid create into a failure.

The pre-check remains restored. Its roughly 321 ms cost on a fresh shell includes
a deliberate 300 ms stability window; the native timeout does not make that
window redundant. Readiness polls are read-only and bounded to five seconds;
`agent.start` is still sent once, without automatic mutation retries. Command
Code retains the same guard before its launcher is typed into the shell.

Regression coverage now exercises busy startup through conversation, tab and
split creation. All three pass with the guard and fail when a temporary Go
overlay removes it. The existing isolated `TestRealHerdrBootstrapWhenRequested`
also passed with its three-second slow-shell fixture and a temporary `codex`
stub on PATH: it exercised Pairfob's real create path without starting a model
or touching existing Herdr sessions. The temporary server and stub were removed.

The fix was checked with `go test -race ./internal/runtime` and
`go vet ./internal/runtime`, both passing. This follow-up adds regression
coverage and documents the already-restored runtime guard; it does not rerun
the full repository gate or certify concurrent frontend edits. Nothing was
deployed.

## Measurements

### Browser, held Snapshot

The QA fixture (`pwa/qa`) mounts the production App with a local session stub.
`qa.hold("snapshot")` holds its Snapshot until released — two seconds in the
before sample, standing in for the installed daemon's catalog read (2,253 ms
median, measured in [`live-connection-performance.md`](live-connection-performance.md)).
The reader taps the real create control; a `MutationObserver` records when the
submit spinner starts, when the pane screen is visible and when the sheet closes.

| Surface | Before: sheet closes | After: pane / sheet, from the submit spinner |
| --- | ---: | ---: |
| Phone 390×844, touch — create tab | 2,006 ms | 23 / 31 ms |
| Phone 390×844, touch — split | — | — / 10.1 ms (earlier build, same open path) |
| Tablet 1024×768, touch — create tab | — | 24 / 34 ms |
| Desktop 1440×900, mouse — create tab | — | 25 / 40 ms |

The before row is the old client code in the same fixture: it closed the sheet
only when the held Snapshot was released. 2,006 ms to about 31 ms is roughly
65× on the client step for that deterministic two-second read; the new pane is
on screen at about 23 ms.

End-to-end wall time on a live computer also includes the shell reaching its
prompt inside Herdr and the first `paneRead`. Those are not removed here; the
change removes the catalog read in front of them. This is a create/split-path
result, not a claim about the full connection.
