# Network transport performance and recovery

This change addresses congestion and failure isolation across the daemon,
relay transport, P2P DataChannel and browser reconnect loop. It builds on the
[codec optimization](terminal-transport-performance.md).

## Changes

- Receive-side AEAD state has its own lock. Terminal output cannot hold up
  authenticated request admission on another relay session. Session retirement
  and relay-to-P2P key migration synchronize both directions before wiping keys.
- Terminal output yields between its existing 96 KiB fragments. Interactive
  replies have priority; after eight consecutive interactive admissions, bulk
  traffic may proceed. Interactive intent remains registered while waiting for
  transport capacity, preventing the same session's terminal stream from
  continually refilling the space needed by a larger reply. Waiting uses a
  condition variable instead of busy spinning.
- Relay pipe admission accounts for bytes, with a soft budget of one maximum
  envelope plus 4 KiB control headroom (266,264 bytes), rather than admitting 128 large terminal fragments
  ahead of an interactive reply. The existing channel capacity remains the hard
  bound for other control traffic. Concurrent sessions can briefly over-admit
  against the soft budget; the original bounded channel still applies.
- P2P admission waits before encryption at a 1 MiB soft budget, retaining the
  existing 2 MiB hard cap. Low-water notifications and a 10 ms polling fallback
  cover drain, cancellation and connection closure. Every final readiness check
  is serialized with sealing and sending. Waits have a 10 s deadline and are
  cancelled when the owning session closes. Failure on an old transport cannot
  retire a session that has migrated to a new one.
- Transcript reads have their own bounded four-entry lane, independent of the
  eight-entry display-read lane. Reads waiting for at least the browser's default
  eight-second read budget return `backpressure` before executing. Running reads
  keep their existing operation-specific deadlines. Mutation ordering is unchanged.
- The browser retains the first immediate recovery. Later connections that live
  less than ten seconds keep their exponential backoff; stable connections earn
  a fresh immediate recovery. This prevents successful but rapidly failing
  handshakes from continually resetting the retry delay.
- Analytics Engine write exceptions increment a local failure counter without
  interrupting opaque frame forwarding or cleanup. Existing 64 KiB aggregation
  and payload confidentiality are preserved.

## Compatibility boundaries

No protocol fields, cryptographic primitives, key derivation, envelope bytes,
terminal data, frame size limits, capability names or mutation retry policy
change. Each directional AEAD sequence remains ordered. Waiting happens before
sealing; a post-seal transport failure still fails the epoch. No encrypted frame
is dropped or replayed to recover capacity. Relay-to-P2P migration keeps the
logical terminal and transfers only the fresh directional keys.

## Measurement

`BenchmarkTerminalContention` models the production 128-frame relay pipe draining
one envelope every 4 ms. Each iteration transfers the same 4 MiB terminal frame
and one authenticated Ping through daemon ingress, RPC dispatch, outgoing pipe,
AEAD and the receiving decoder. The baseline retains the previous whole-frame
send lock and receive/send lock coupling, with the same optimized encoder as the
new implementation. Thus it isolates scheduling from the earlier codec speedup.

The primary metric is authenticated control round-trip latency while bulk output
is active. Total iteration throughput is reported as a guardrail. This is a
repeatable local congestion model, not a measurement of the hosted origin,
carrier networks or physical phones. A tenfold reduction in congestion latency
must not be described as tenfold raw bandwidth or universal end-to-end throughput.

```sh
go test ./internal/daemon -run '^$' \
  -bench '^BenchmarkTerminalContention$' -benchtime=20x -count=3
```

Measured on Apple M1, Go 1.26.11, with 20 iterations per sample and three
samples per variant. Values below are the median of the three sample means.

| Metric | Previous scheduling | Optimized | Ratio |
| --- | ---: | ---: | ---: |
| Authenticated control latency during terminal output | 210.4 ms | 14.92 ms | 14.10× lower |
| Complete iteration throughput, including terminal and Ping | 19.60 MB/s | 19.30 MB/s | 0.985× (about 1.5% lower) |
| Allocated bytes per iteration | 22,215,086 | 22,239,604 | +0.11% |

On the final source, the three control-latency sample means were 214.8, 209.2
and 210.4 ms before, and 14.62, 14.92 and 15.36 ms after. Throughput ranges
were 19.19–19.76 MB/s before and 19.18–19.38 MB/s after. These ranges overlap;
the measurement does not establish a bulk-throughput improvement. Shared-machine scheduling affects absolute
times; these results establish the congestion-latency improvement, not a general
claim of increased physical link bandwidth. Earlier exploratory runs varied
more under concurrent tests and are not substituted for this fixed workload.

## Verification

Focused tests cover:

- Another relay session's request is admitted while terminal Send is blocked.
- An interactive reply arrives between terminal fragments; all 43 fragments
  remain present and every encrypted envelope decrypts in sequence.
- Writable waits consume no nonce, allow a small interactive reply, retain
  interactive priority during drain, cancel on teardown, and cannot fail a newly
  migrated transport because an old wait failed. The retained-priority test also
  fails against the pre-fix implementation through a temporary Go overlay.
- Pipe admission accounts for queued bytes, preserves control headroom, resumes
  on drain, and handles cancellation and closed-pipe buffered reads.
- A real local Pion DataChannel delivers 48 ordered 130,000-byte payloads
  (6,240,000 payload bytes) without closing; the original hard-cap failure test
  still requires epoch closure after an unadmitted send exceeds the hard limit.
- Transcript/display read admission is separate and bounded; expired queued
  reads do not execute Runtime work.
- The first immediate reconnect remains compatible; repeated short-lived
  connections back off, stable connections reset the delay, and backward clock
  changes cannot earn another immediate retry.
- A throwing metrics sink cannot interrupt FWD in either direction.

The complete `./scripts/verify.sh` run passed (exit 0): Go race/vet/vulnerability
checks, protocol vectors, scripts, desktop checks, PWA tests/QA/types, Worker
unit/harness/integration checks, browser/native builds, startup budget and origin
asset packing. The PWA suite finished with 5,788 passes and zero failures across
664 files. One unchanged workspace gesture test failed its first attempt, then
passed the gate's configured retry and an independent 12-test run; no assertion
or UI code was changed for it.

The retained-priority fix changed only daemon Go code and its regression test
after the first run's Go checks completed. Both its focused race checks and the
complete `scripts/verify-go.sh` rerun passed on the final source (exit 0). All
other passed checks retain identical inputs. A final SHA-256 source snapshot
check confirmed that all 39 changed/new source files match the verified inputs.
Verification used Bun 1.4.3 with two test workers, one Worker integration worker,
and two Go shards to limit contention on the shared machine; no tests were
removed. The full Xcode toolchain and loopback proxy exclusions were supplied
through process environment only.

Real mobile carriers, long-duration network soak tests and physical-device
acceptance are separate from these local tests and have not been performed in
this change.
