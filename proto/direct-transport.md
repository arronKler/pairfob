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
   `TransportOffer` RPC with a fresh `p2p_` attempt ID and complete offer SDP.
2. The daemon creates a fresh 16-byte route, answers the SDP, and keeps the
   candidate separate from the active logical session.
3. Over the DataChannel, the endpoints perform the unchanged
   `DeviceHello1/2/3` exchange using the fresh route. This derives fresh AEAD
   directions; relay sequence numbers and keys are never reused on P2P.
4. The phone stops admitting new RPCs, drains relay RPCs, then sends one
   `TransportCommit` over relay. The daemon replies over relay before atomically
   moving the same logical session and live terminal controller to the direct
   route and key epoch.
5. The phone proves the committed direct route with an encrypted `Ping`, swaps
   locally, then closes its relay socket. If the commit reply is lost, that
   direct probe resolves the outcome without replaying `TransportCommit`.

Application mutations retain their existing `operation_id` rules and are never
replayed during a transport switch. A failed P2P session reconnects through a
fresh relay session.

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
