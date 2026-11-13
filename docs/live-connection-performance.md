# Real connection profiling: Snapshot latency

On 2026-11-13, native browser connections through the public `pairfob.com`
relay exposed a daemon-side Snapshot bottleneck. The change reduces the median
of six real P2P Snapshot reads from **2,253 ms to 147 ms (15.3×)** on this
machine. A second six-read candidate run had a median of 116 ms.

**Complete new connections did not improve tenfold.** Two matched new-relay
connection samples went from 6.15–6.29 seconds to 4.14–4.53 seconds through
first config and Snapshot availability. Their median ratio is 1.44×; this
small sample is diagnostic evidence, not a general latency guarantee.

## Measurement and diagnosis

The browser used the repository's real protocol implementation, native
WebSocket and WebRTC, authenticated pairing, the production relay and a real
local Herdr 0.9.3 runtime with 20 panes. No mocked sockets, artificial delays,
fake runtime, terminal input or resize was used. This measures transport and
first data availability, not complete PWA asset loading or screen rendering.

Initial measurements against the installed v1.4.15 daemon:

| Stage | First sample | Second sample |
| --- | ---: | ---: |
| WebSocket open | 1,141 ms | 2,177 ms |
| Open to encrypted session ready | 1,118 ms | 1,130 ms |
| Session ready to Snapshot available | 1,473 ms | 3,264 ms |
| Total through first data | 3,732 ms | 6,571 ms |

In a separate established-session measurement, relay Ping was 315 ms and P2P
Ping was 1–6 ms. **P2P was already implemented; this path difference is not a
speedup delivered by this change.** Snapshot still took 2.15–2.60 seconds over
P2P, whereas direct read-only Herdr `session.snapshot` took 9–27 ms.

Read-only daemon-stage profiling isolated 2.58 seconds in title decoration.
A CPU profile of the initial live run attributed 85.8% of samples to
`encoding/json.Unmarshal`. Each Claude title refresh decoded up to 8 MiB of
head/tail records, including tool output that cannot supply a title. With
13 Claude panes, serial scans could outlast the existing two-second title
cache window and make repeated polling expensive again.

## Change and compatibility

- Before JSON decoding, discard records that cannot contain a title or a needed
  first user request. Unicode escape sequences always fall through, because
  they can encode the relevant type values. A substring match never accepts a
  record: the original complete JSON decoder, hidden-record flags, session
  identity checks, prompt filtering and title precedence still decide it.
- Beyond the existing two-second refresh window, reopen and verify the bound
  transcript and compare file identity, size and modification time. Reuse the
  small derived title only when those match. Appends, truncation, replacement
  and modification trigger a rescan. The cache is bounded by the journal's
  existing entry limit; no transcript contents are retained by it.
- The protocol, authentication, RPC fields, mutations, P2P negotiation, relay
  routing, polling frequency and server configuration are unchanged. No new
  sockets, keepalives, relay requests or cloud resources are required in normal
  operation. This reduces local daemon work; it does not add hosted cost.

The standalone title parsing benchmark also improved, but by approximately
6×, not 15×. The larger live benefit includes avoiding unchanged-file scans
and preventing title refreshes from continuously overrunning their cache.
A fresh reader with empty journal caches still took about 802 ms for its
first full local decorated snapshot, then 34–36 ms on later reads spaced
past the title refresh window. This is distinct from a running daemon's
cache state when a phone connects.

## Controlled live comparison

One isolated daemon identity and paired browser credential were reused while
switching candidate → baseline → candidate. The original daemon remained
running. Both binaries used the same checkout; the baseline overlaid only
`internal/journal/title_claude.go` and `internal/journal/journal.go` from
commit `339b55139b30b69f90028edcb35f9427bddd1a0d`. The runtime, browser, protocol
client and test credential were the same. The production relay was unchanged.

Reads were spaced 2,200 ms apart **after completion**, crossing the existing
title TTL. Every sample included an encrypted Ping followed by Snapshot over
an established, verified P2P connection.

| Measurement | Baseline | Candidate | Candidate repeat |
| --- | ---: | ---: | ---: |
| Samples | 6 | 6 | 6 |
| Snapshot median | 2,253 ms | 147 ms | 116 ms |
| Snapshot range | 2,044–3,702 ms | 112–280 ms | 26–344 ms |
| Ping range | 1.6–3.7 ms | 1.6–5.1 ms | 2.1–126.2 ms |

All 20 pane titles matched between the baseline and candidate, including
13 nonempty titles. This checks the live display result; focused tests cover
additional encodings, hidden records and file changes. The machine and its
agents remained active, so the raw samples include scheduling and network
jitter. These sample counts do not establish population p95 or mobile results.

The two matched new-relay connection samples each sent **one WebSocket and
eight client frames through first data**, in both versions. In the candidate,
WebSocket opening alone still cost 1.39–1.89 seconds, and authentication after
open cost another 2.01–2.31 seconds. Those waits are not fixed by title parsing;
a tenfold overall connection claim would be false.

[Sanitized timing samples and source hashes](connection-profile-samples.json)
contain no credentials, addresses, transcript contents or pane identities.
Both temporary test devices were revoked, isolated daemon state and credential
files removed, and the profiling browser closed. The original daemon retained
its six existing devices and was not restarted or upgraded.

## Reproduction

For local read-only stage profiling against live Herdr and trusted journals:

```sh
PAIRFOB_PROFILE_LIVE=1 go test ./internal/daemon \
  -run '^TestConnectionProfileLive$' -v -count=1 \
  -cpuprofile=/tmp/pairfob-connection.prof

go tool pprof -top /tmp/pairfob-connection.prof
```

The test reports durations and pane counts only. It does not print titles,
paths, IDs, messages or keys. Use `-count=1` to avoid Go's test-result cache.

For native browser transport profiling, build the manual browser entry:

```sh
bun build pwa/scripts/live-connection-profile.ts --target=browser --format=iife \
  '--define=import.meta.env={}' \
  '--define=import.meta.url="https://pairfob.com/live-profile.js"' \
  --outfile=/tmp/pairfob-live-profile.js
```

Load that bundle through browser DevTools/automation on
`https://pairfob.com/v2/health`. Use a dedicated temporary pairing, approved on
the daemon, and keep its `PairResult` in browser memory. The bundle exposes
`pairfobLiveProfile.profileConnection(pair)` and
`pairfobLiveProfile.profileReads(session)`. It also exports the existing
`pairOverWS`/`sessionOverWS` functions for that pairing/session setup. Do not
profile with an active user's credential: a new same-device route replaces
the old route. Run connection attempts serially and respect the existing
DeviceHello rate limit; this tool does not retry failed attempts.

Run `profileReads` only after the session reports P2P when comparing the
P2P rows above. Close the session and revoke only the temporary device when
finished. Never export the pairing object or save it in the timing report.
The module rejects a different browser origin instead of changing the relay's
origin policy. HTTP navigation DNS/TLS timing is not claimed as a breakdown
of the WebSocket handshake.

## Validation

Focused journal and daemon race tests passed. Real transcript acceptance read
190 Claude transcripts (1,213 prompts/commands) and 32 Codex transcripts
(185 prompts/commands); the scan found no injected-context leakage. The
Pi-title live case was skipped because this run was not inside a Pi session.
The manual browser profiler bundled and passed strict TypeScript checking.

The final `./scripts/verify.sh` run exited 0: Go vet/race/vulnerability checks,
protocol vectors, script checks, Worker unit/integration tests, desktop checks,
PWA types/QA, 5,832 PWA tests across 669 files (zero failures), browser/native
builds, startup budgets and origin packing all passed. The run completed in
1,190 seconds; source hashes stayed unchanged throughout. Its local log is
`/tmp/pairfob-live-final-verify.log`. Only this validation paragraph was updated
afterward.

There is no production deployment in this change, and no physical-phone or
cross-network acceptance claim.
