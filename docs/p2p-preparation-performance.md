# P2P preparation alongside relay authentication

The client now gathers ICE candidates alongside the actual relay dial, then
uses that one preparation after the encrypted relay session is ready. It
removes a serial wait without changing authentication, signaling RPCs, wire
formats, retry policy or hosted relay configuration.

This is a further latency improvement, **not a tenfold end-to-end claim**.
On the measured public path, the dominant waits remain WebSocket establishment
and the authenticated Offer/Commit relay round trips.

## Real-browser comparison

On 2026-11-13, the same native browser and temporary paired device connected
through `pairfob.com` to the installed v1.4.15 daemon and real Herdr. The order
was baseline ×2, candidate ×2, baseline ×2, candidate ×2. No network latency
was injected and neither the relay nor daemon was changed. The four baseline
client modules were saved before editing; the source hashes and sanitized
[raw samples](p2p-preparation-samples.json) identify both versions.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Successful samples | 4/4 | 4/4 |
| P2P ready, median from new dial | 4,183 ms | 3,386 ms |
| P2P ready, range | 3,882–7,738 ms | 3,291–3,614 ms |
| ICE gathering begins | after relay authentication | within 1–3 ms of starting the dial |
| ICE wait remaining when relay API resolves | 192–198 ms | none in all four samples |
| WebSockets per attempt | 1 | 1 |
| PeerConnections per attempt | 1 | 1 |
| Client relay WebSocket sends per attempt | 10 | 10 |

The observed median is 19% lower. That whole difference cannot be attributed
to this change: relay opening and Offer/Commit RTT also varied between runs.
The directly demonstrated removal is approximately 195 ms of serial ICE
waiting. In the candidate, ICE finished before authentication in every sample,
including one that took about 965 ms to finish gathering. These small samples
are not population p95 or physical-phone measurements.

`relay_ready` is when the public session promise resolves. The internal
established-session callback can send TransportOffer a fraction of a
millisecond before that consumer callback runs. This is not pre-auth signaling;
the lifecycle regression test holds DeviceHello2 and verifies no upgrade starts
until the encrypted session is established.

The prior [Snapshot optimization](live-connection-performance.md) measured a
different bottleneck. Its 15.3× result must not be multiplied by this result or
presented as a new complete-connection speedup. No deployment was performed.

## Ownership, compatibility and cost

- There is one preparation per active relay dial. It is transferred once to
  the normal upgrade. Relay-only, disabled-P2P and unsupported-browser paths do
  not prepare ICE. An old daemon refusing TransportOffer retains the normal
  relay fallback.
- Authentication failure, disposal, offline state, page hiding and selecting
  relay-only cancel an unused preparation. An observed network change discards
  its old candidates without launching another preparation immediately.
- Cancellation closes native resources even while `createOffer()` is pending.
  Taking an unfinished preparation follows the upgrade's cancellation signal;
  DataChannel acceptance uses the new owner's signal after transfer.
- Reading the SDP at signaling time includes candidates that arrived while
  authentication was pending and checks its existing maximum size again.
- Preparation failures are consumed by the existing upgrade/backoff path.
  They do not add an immediate negotiation retry or another DeviceHello.
- Normal successful attempts keep one Offer, one Commit and the existing
  encrypted probe. There is no additional hosted relay request, persistent
  warm socket, TURN service or server resource configuration.
- STUN now starts earlier, so it may run even when relay authentication later
  fails. STUN still reveals only the request's source address to the configured
  STUN service; no SDP is sent to the paired endpoint until relay authentication
  succeeds. No paired secret is passed to STUN.

The temporary device was revoked afterward, leaving the original six devices.
Its local credential files and browser task space were removed. The installed
daemon was not restarted or replaced.

## Reproduction and validation

The [live connection profiler](../pwa/scripts/live-connection-profile.ts) now
exports `pairfobLiveProfile.profileUpgrade(pair)`. Build and load it using the
[existing own-origin procedure](live-connection-performance.md#reproduction),
on an otherwise idle health page with a dedicated temporary pairing. Native
WebSocket and RTCPeerConnection methods are observed, not simulated. Returned
records contain phase names, times and counts only; never export the credential.
Run samples serially and respect the DeviceHello limit. A separate live smoke
run of the checked-in profiler succeeded with one socket, one peer and ten
relay sends; it is recorded separately from the A/B comparison.

The affected-consumer run passed 1,193 tests across 128 files. Focused new tests
cover single ownership, failed and cancelled preparation, late peer cleanup,
network invalidation, late SDP candidates and bounds, transfer of cancellation,
old-daemon refusal, and authentication/signaling ordering. Type checks passed.
The final `./scripts/verify.sh` passed: Go (including race and vulnerability
checks), scripts, desktop, Worker integration, types, QA, both PWA builds and
origin asset packing. The PWA suite passed 5,850 tests across 673 files with
zero failures; the web gate finished in 469 seconds. Worker concurrency was
limited on the shared machine without skipping tests. All 26 frozen changed
source inputs remained byte-identical throughout verification, and the five
candidate module hashes still match the real-browser sample record. The local
gate log is `/tmp/pairfob-ice-final-verify.log`. Physical-phone acceptance and
production deployment were not performed.
