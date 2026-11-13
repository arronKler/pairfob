# Pairfob direct transport

Pairfob may upgrade an established phone session from relay WebSocket frames to
an ordered, reliable WebRTC DataChannel. The relay remains the mandatory
signaling, authentication, and fallback path. `GET /api/config` advertises the
global kill switch as `p2p`; a false value disables attempts.

The browser gathers ICE candidates with `stun.cloudflare.com:3478`. Pairfob
does not operate TURN and does not send TURN credentials. When NAT or firewall
policy prevents a direct candidate pair, the established relay session keeps
working without a user-visible disconnect.

ICE candidates are visible only to the authenticated paired endpoint because
the SDP is carried inside Pairfob AEAD; as with any STUN use, the Cloudflare
STUN service observes the request's public source address. The Pairfob Worker
continues to see only encrypted FWD bytes.

## Authenticated upgrade

1. Over the established encrypted relay session, the phone sends one
   `TransportOffer` RPC with a fresh `p2p_` attempt ID and an offer SDP that
   carries the candidates gathered so far (see below).
2. The daemon creates a fresh 16-byte route, answers the SDP, and keeps the
   candidate separate from the active logical session.
3. Over the DataChannel, the endpoints perform the unchanged
   `DeviceHello1/2/3` exchange using the fresh route. This derives fresh AEAD
   directions; relay sequence numbers and keys are never reused on P2P.
4. The phone holds new RPCs back, then sends one `TransportCommit` over relay.
   The daemon replies over relay before atomically moving the same logical
   session and live terminal controller to the direct route and key epoch.
   Every reply it sent before that arrives on relay ahead of the commit reply;
   it sends the rest on the direct route. The phone therefore carries the RPCs
   still out to the direct transport when the commit reply arrives, each with
   its own deadline, and does not wait for them before committing.
5. The phone proves the committed direct route with an encrypted `Ping`, swaps
   locally, then closes its relay socket. If the commit reply is lost, that
   direct probe resolves the outcome without replaying `TransportCommit`.

When P2P is enabled, a visible client begins one local ICE preparation beside
its actual relay dial. Signaling still waits for the established encrypted
relay session: the prepared offer is taken once by step 1. An unused preparation
is cancelled on authentication failure, page hiding, offline state, relay-only
selection, or an observed network-path change. A failed preparation uses the
existing upgrade backoff; it does not start a second immediate offer. Before
signaling, the client reads the current local SDP so later candidates are
included and the SDP size limit is checked again.

The offer does not wait for ICE gathering to complete: that only happens once
every interface has heard from STUN or given up on it, which on some phones is
the whole 8-second budget. The phone sends the offer 300 ms after its first
server-reflexive candidate, or with host candidates alone once 3 seconds have
passed, and in any case after 8 seconds with whatever it has. The daemon's
answer does the same on its side: 300 ms after its first server-reflexive
candidate, with host candidates alone after 2 seconds, or once gathering
completes, instead of waiting out a STUN reply that was lost. Candidates are
not trickled afterwards; each end learns any other working address from the
connectivity checks themselves.

If the relay drops while the candidate is still proving itself in step 5, the
candidate keeps its 3-second Ping and a relay standby (the first flight of
`envelope-v2.md`, as in foreground recovery below) starts beside it. A Ping
answer carries the session on the direct route and closes the standby. A
standby that verifies `DeviceHello2` first closes the candidate, then sends
`DeviceHello3`. Without handshake budget a plain relay socket is prepared and
the Ping decides alone. A relay loss that ends the session (`kicked`, a revoked
or unpaired device) starts neither.

Application mutations retain their existing `operation_id` rules and are never
replayed during a transport switch. A failed P2P session reconnects through a
fresh relay session.

## Client selection and retry policy

The phone establishes Relay first and attempts P2P immediately when the origin
advertises support and the browser provides WebRTC. The daemon may still reject
the offer when its local P2P switch is off. A failed attempt leaves the
authenticated Relay session active. While that Relay stays healthy, the phone
retries after approximately 30 seconds, 2 minutes, 5 minutes, and then at a
jittered interval capped at 10 minutes. Returning online, a network-path change,
or returning to the foreground probes immediately and resets that backoff.
An established P2P path that loses ICE drops back to a fresh Relay session
without ending the logical session, then retries the upgrade. Pairfob does not
operate TURN.

## Foreground recovery and diagnostics

Foreground recovery probes the existing authenticated transport. A healthy Ping
reuses it immediately. After 500 ms an unanswered probe prepares one relay
WebSocket without authenticating or replacing the live route. The Ping deadline
remains 3 seconds; old-path recovery has a 4-second budget, separate from the
subsequent relay authentication budget.

A page that was hidden for 10 seconds or longer may return to a path that died
without a close. The probe of that return (not of a later network hint, whose
old path gets its repair first) then runs beside a standby: a second relay socket
that sends the first flight of `envelope-v2.md` at once and stops after
verifying `DeviceHello2`. Whichever answers first decides. A Ping answer keeps
the old transport and closes the standby, which the daemon never established.
A standby that verifies while the Ping is still unanswered retires the old
transport, then sends `DeviceHello3`; the page reconnects in one handshake
instead of waiting out the Ping deadline. A refused standby is dropped silently,
a plain prepared socket takes its place, and the probe decides alone.

The daemon admits ten `DeviceHello1` per device a minute. A session counts its
own (dials, standbys and direct upgrades) and starts a standby only while fewer
than four fall in the last minute, so a guess never spends the handshakes a
reconnect must have.

The reads a screen issues once it is connected (`GetConfig`, `Snapshot`, and the
open pane's `PaneRead`) leave with the probe's Ping on a live transport and with
`DeviceHello3` on a new one. The app still asks in its order and applies each
answer where it always did. An answer is handed out once, to the identical
read, on the transport it arrived on, within 2 seconds of arriving, and never
after a mutation, a `Poke` or a new probe; otherwise the read goes out
normally.

During a foreground probe, definitive ICE/peer `failed` or `closed` states
retire the old transport even while page grace is active. `disconnected` and
`checking` keep their grace. An explicit ICE restart owns a separate pause.
Hidden or superseded probes cannot affect a later connection; fallback never
replays mutations.

The daemon admits authenticated `Ping` requests to a separate health lane:
one worker and four queued requests per logical session. Other RPC ordering
is unchanged. Replies share the existing authenticated send/sequence lock;
queue saturation returns `backpressure`. No envelope or RPC fields change.

Browser diagnostics correlate recovery with `recovery_id` and monotonic
`recovery_elapsed_ms`. `recovery_ready` measures connection readiness separately
from terminal open and the first applied frame of each reopened bridge. A dial
that spans hidden/visible cycles keeps its `connect_id`, but its later stages
belong to the current foreground recovery. Daemon `health_ping` audit records
sample route/request identifiers and queue/reply milliseconds asynchronously:
at most one healthy sample per 30 seconds or one slow sample per second, with
one queued log record. Server timings remain in the daemon audit log, not the
phone export or Ping response. No payloads, credentials, or SDP are logged.

## ICE restart

An established P2P session may send `TransportRestart` on the live DataChannel
with a fresh `p2p_` attempt ID and an `iceRestart` offer SDP. The daemon answers
on the same PeerConnection. Route ID, AEAD epoch, and DeviceHello are unchanged.
The RPC is valid only on an established P2P session. A daemon that does not
implement it returns `unknown_op` or `unsupported`; the phone keeps the current
path when ICE is still connected, otherwise it falls back to Relay. Attempts are
at least 15 seconds apart. Foreground/visibility probes do not restart ICE.

The settings screen offers Auto, P2P, and Relay. Auto is the default: the phone
establishes Relay first and attempts P2P as described above. P2P runs one
authenticated prepare-and-commit attempt immediately and keeps the same retry
schedule if that attempt fails. Relay reconnects through Relay when the active
path is P2P, and pauses automatic P2P retries until Auto or P2P is selected.
The choice persists on this browser.

SDP is accepted only inside authenticated AEAD RPCs, is capped at 64 KiB, and
must describe an application media section. Attempts expire after 20 seconds.
The DataChannel label is `pairfob`, protocol is `pairfob.v1`, and delivery is
ordered and reliable. WebRTC DTLS protects the channel; Pairfob AEAD remains
mandatory inside it.

## DataChannel frame chunks

The envelope encoded by `envelope.md` is unchanged. To stay below browser
DataChannel message limits, its encoded bytes are split into ordered messages
of at most 16 KiB. Every message begins with this 12-byte header:

| Offset | Bytes | Value |
| --- | ---: | --- |
| 0 | 4 | ASCII `PFP2` |
| 4 | 4 | total encoded-envelope length, big endian |
| 8 | 4 | chunk offset, big endian |

Chunks may not interleave. The first offset is zero, every next offset equals
the accumulated length, and the total is between 24 and 262168 bytes. Any
invalid, oversized, interleaved, or out-of-order chunk closes the direct link.
