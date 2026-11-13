# Connection preparation performance

The client now uses native WebCrypto X25519 and Ed25519 when available. Fresh
X25519 key generation overlaps the existing WebSocket open, and signature
verification and DH run concurrently after the PSK proof is checked. The
existing implementation remains the fallback for unsupported algorithms.

This improves local computation. It does **not** establish a tenfold improvement
in complete connection latency. The existing relay handshake already uses two
flights; network round trips dominate a healthy remote connection.

## Compatibility and cost

- The X25519/Ed25519 algorithms, DeviceHello transcript, proofs, HKDF, AEAD,
  envelope version and mux protocol are unchanged. Both relay and P2P use the
  same handshake implementation. Pairing is unchanged.
- Native verification returning false or failing with an operational error is
  final. Only `NotSupportedError` selects the existing implementation. Algorithm
  support is remembered per crypto provider, independently for X25519 and
  Ed25519; no browser-version sniffing is used.
- At most 16 imported public verification keys are cached. Ephemeral private
  keys are fresh for every attempt, never pooled and never exported by the
  native path. The legacy private key and derived shared secret are erased
  after use. Native private-key handles are released after use or cancellation.
- Cancellation ends protocol waits immediately even if a native operation has
  not returned. Late results cannot send DeviceHello3 or RPCs; late unused keys
  are retired. A negative signature never enables encrypted reads.
- Readiness still requires the validated SESSION_ESTABLISHED marker and a fresh
  encrypted Ping response. Standby ownership, first-read ordering, legacy-order
  fallbacks, the hello budget and mutation retry rules are unchanged.
- No Worker, Durable Object, daemon, infrastructure, polling or socket-pool
  configuration changes are required. There are no additional server requests,
  speculative sessions or protocol bytes per connection. This is a comparison
  of running connection work, not a claim about a production billing invoice
  or the one-time delivery size of an updated static application bundle.

The [Web Cryptography specification](https://w3c.github.io/webcrypto/) defines
native algorithm operations. Frozen protocol vectors and cross-implementation
DH tests check compatibility with the existing implementation.

## Measurements

Baseline: `339b55139b30b69f90028edcb35f9427bddd1a0d`. The benchmark replaces only
`relay-dial.ts` and `session-handshake.ts` with their baseline contents while
keeping the fixture, other modules, dependencies and bundler identical. It does
not modify the checkout or contact the production origin.

Measured on 2026-11-12 in Chrome 156 on macOS. Each attempt creates a fresh
in-memory WebSocket and performs real DeviceHello, AEAD, readiness Ping,
GetConfig and Snapshot. The peer uses the existing JavaScript test fixture;
its CPU time is included. Opening and link delays are simulated with timers,
not real DNS, TLS, carrier or Cloudflare measurements. JavaScript is warmed up
and baseline/current samples alternate. The public verification key is cached
on repeat attempts. Other repository verification ran on the same machine;
small differences under network delay are noise, not a claimed speedup.

| Full authentication and first reads | Samples per version | Baseline p50 / p95 | Current p50 / p95 |
| --- | ---: | ---: | ---: |
| No simulated open delay or RTT | 100 | 3.7 / 5.2 ms | 3.2 / 4.3 ms |
| 30 ms open + 20 ms RTT | 30 | 88.4 / 91.9 ms | 87.4 / 91.7 ms |
| 30 ms open + 100 ms RTT | 30 | 248.3 / 254.2 ms | 249.1 / 265.6 ms |

The isolated client-crypto benchmark includes fresh key generation, signature
verification, DH and session KDF, and checks the result against an independently
derived peer key outside timing. In two runs of 150 samples per implementation,
p50 was 0.7–0.9 ms for the existing implementation and 0.2 ms for native
operations (3.5–4.5×).
With Chrome's 4× CPU throttle and 100 samples each, p50 was 3.6 versus 0.9 ms
(4×). CPU throttling is not a physical phone measurement.

Every full-connection sample in both versions sent exactly:

| Work | Before | After |
| --- | ---: | ---: |
| WebSocket connections | 1 | 1 |
| DeviceHello1 attempts | 1 | 1 |
| Client frames, including existing heartbeat | 8 | 8 |
| Encoded client bytes | 834 | 834 |
| RPCs | Ping, GetConfig, Snapshot | Ping, GetConfig, Snapshot |

These results support lower client computation cost and unchanged per-connection
server work. They do not support tenfold complete connection latency, and the
100 ms RTT scenario shows no consistent latency benefit. The earlier
[congestion optimization](network-transport-performance.md) measures a different
quantity: control latency during bulk terminal output.

## Reproduction

```sh
cd pwa
bun scripts/connection-benchmark.ts 339b55139b30b69f90028edcb35f9427bddd1a0d
```

Open the printed loopback URL in the target browser, then use its console:

```js
const before = await import('/baseline.js');
const after = await import('/current.js');
await before.connectionSample({ openMs: 30, rttMs: 20 });
await after.connectionSample({ openMs: 30, rttMs: 20 });
await after.cryptoSample(false); // existing implementation
await after.cryptoSample(true);  // native with capability fallback
```

Warm both modules before collecting distributions. Alternate ordering; collect
at least 30 connection samples and report p50, p95 and message counts, including
any regressions. With browser automation, use bounded batches (for example ten
samples per version with 100 ms RTT) rather than one long page evaluation.
Change the baseline override list if future work modifies other production
modules; otherwise the comparison would no longer represent that commit.

## Regression coverage

Focused tests cover frozen signatures, DH and session-key equivalence, fresh
single-use ephemeral keys, zero-key rejection, unsupported algorithm fallback,
negative native verdicts, provider failures, the bounded public-key cache,
concurrent first-flight callers, cancellation during key generation and
verification, and erasure of a DH result after parallel verification fails.
Existing tests cover forged proofs/signatures, encrypted readiness, standby
ownership, relay ordering fallback, reconnect and P2P upgrades.

The two standby fixtures explicitly wait for the intended handshake phase;
they no longer rely on synchronous JavaScript crypto making Hello1 and
verification happen in the same event-loop turn. Their authentication and
ownership assertions are retained.

Final candidate verification completed on 2026-11-13: `./scripts/verify.sh`
passed, including 5,832 PWA tests across 669 files, Go race/vet/vulnerability
checks, frozen vectors, Worker unit/harness/integration checks, desktop checks,
PWA QA/type checks, browser/native production builds, startup budget and origin
packing. Test concurrency was limited to two PWA workers and two Go shards on
the shared machine. All checks selected by the repository gate ran; no
assertions or time limits were relaxed. Source hashes were unchanged throughout
the final run. Browser measurements used Chrome 156;
physical iOS/Android devices and real public-network latency remain unmeasured.
