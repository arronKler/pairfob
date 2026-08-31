# Pairfob encrypted envelope v1

Binary envelope format `version=0x01`, carried by the current WebSocket
subprotocol `pairfob.v2`. Header 24 bytes:

| offset | size | field |
| 0 | 1 | version = 0x01 |
| 1 | 1 | typ |
| 2 | 2 | flags uint16 BE (v1 = 0) |
| 4 | 4 | length uint32 BE (payload only, max 262144) |
| 8 | 16 | route_id (zeros until bind) |

typ: 0x01 HELLO_DAEMON … 0x0F SESSION_ESTABLISHED. Names live in `internal/envelope` and `pwa/src/lib/protocol/envelope.ts`.

FWD payload = nonce(12) || ct||tag. Inner plaintext ≤ 262116.

Established-session plaintext messages are frozen by
[`rpc.schema.json`](./rpc.schema.json). Implementations must reject messages
that exceed the schema limits before invoking the runtime. In particular,
`SendText.text` is at most 32 KiB, `SendKeys.keys` contains at most 32 entries,
and `intent=dialog|submit` requires a non-empty `expected_prompt`.

Existing RPC names and fields remain frozen. The complete-terminal mode is an
additive established-session surface: `TerminalOpen`, `TerminalInput`,
`TerminalResize`, `TerminalScroll`, and `TerminalClose`, plus daemon events
`TerminalFrame` and `TerminalClosed`. They remain ordinary JSON plaintext inside
the same FWD AEAD; there is no new envelope type and the mux stays opaque.
Terminal frames are bounded to 4 MiB and split into ordered 96 KiB plaintext
parts. Terminal writes carry a fresh `operation_id` and a controller-local
monotonic sequence; uncertain writes are never automatically replayed.

Canonical bytes, the 8-character pairing-code work example `7K3M9H2P`, Argon2id, SPAKE2+, and DeviceHello are frozen in `pairfob-vectors.json` and the Go/TS implementations that emit it.

Golden vectors in `pairfob-vectors.json` are produced by `go run ./cmd/genvectors` from shipped Go crypto (not a second oracle). Tests in Go (`internal/crypto/spake2plus`, `internal/crypto/hkdfk`, `internal/crypto/aead`, `internal/crypto/sessionkeys`, `internal/crypto/canon`) and TS (`pwa/src/lib/protocol/vectors.test.ts`) must call those shipped functions and compare bit-identical output. Fields cover `pair_ref_hex`, 8-character `normalized_s`, Argon2id `w0`/`w1`/`L`, RFC 9383 SPAKE shares + `k_shared`, HKDF info `pairfob-v1/sas|pair-*|sess-*`, FWD AEAD (`aead_ping`, `max_plain=262116`), and DeviceHello transcripts/proofs/Ed25519.
