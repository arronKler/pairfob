# Terminal transport performance

This report records the initial codec optimization. The subsequent queueing,
backpressure and recovery work is documented in [Network transport performance](network-transport-performance.md).

The optimization preserves `pairfob.v1` envelope and RPC bytes, the `pairfob.v2`
relay, authentication, encryption, frame order, size limits, and terminal command
acknowledgements. It does not drop ANSI output, coalesce screen frames, retry
mutations, or change rendering, input, scrolling, resizing, or reconnect behavior.

## Changes

- The daemon appends the existing TerminalFrame JSON directly into one buffer per
  frame and reuses that buffer for its parts. Base64 goes straight into that
  buffer, avoiding intermediate strings and dynamic maps. Encryption continues to
  allocate independent ciphertext for each part.
- The Herdr bridge checks canonical Base64 with strict decoding and an explicit
  CR/LF rejection. It checks encoded size before allocating and decoded size
  afterwards; it no longer re-encodes the full frame just to validate padding.
- The PWA uses native byte-to-Base64 codecs where available, with the existing
  browser fallback. Alphabet, padding and discarded-bit validation remains
  strict on both paths, without encoding decoded bytes a second time.
- Single-part frames reuse their decoded buffer. Multipart frames still assemble
  in order with matching metadata and the same 4 MiB memory bound.

## Measured results

Measured on an Apple M1, Go 1.26.11, Bun 1.4.3 and Chromium 156, against the
baseline commit below. Values are milliseconds per operation. Go results use
the median of three 500 ms benchmark runs; JavaScript results use the median of
three timed samples after warmup. Chromium was sampled before the repository
checks; production sources did not change afterwards. Go and Bun were measured
again after the verification builds finished.

| Measurement | Before | After | Speedup |
| --- | ---: | ---: | ---: |
| Go: encode a 64 B frame | 0.01104 | 0.001222 | 9.03× |
| Go: encode a 96 KiB frame | 0.9188 | 0.2996 | 3.07× |
| Go: encode all parts of a 4 MiB frame | 40.27 | 10.10 | 3.99× |
| Go: encode + encrypt all parts of a 4 MiB frame | 60.53 | 29.68 | 2.04× |
| Chromium: Base64 encode 96 KiB | 1.818 | 0.00628 | 290× |
| Chromium: canonical Base64 decode 96 KiB | 2.433 | 0.2614 | 9.31× |
| Chromium: encrypted receive, 4 KiB | 0.1437 | 0.04724 | 3.04× |
| Chromium: encrypted receive, 96 KiB | 3.300 | 0.9882 | 3.34× |
| Bun: Base64 encode 96 KiB | 4.839 | 0.03235 | 150× |
| Bun: canonical Base64 decode 96 KiB | 5.267 | 0.3224 | 16.3× |
| Bun: encrypted receive, 96 KiB | 8.693 | 3.714 | 2.34× |
| Bun: encrypted receive, 4 MiB | 373.9 | 156.6 | 2.39× |

Go allocation volume for encoding a 4 MiB frame fell from 17,462,336 to 139,264
bytes per operation (99.2% less; 1,525 allocations to one). Including encryption,
allocation volume fell from 29,803,362 to 12,020,802 bytes (59.7% less). These are
total allocations per operation, not peak process memory.

The **whole-chain 10× target is not achieved**. Some codec operations exceed it;
the measured encrypted sender/receiver paths improve about 2–3.3× on these large
frames. Real-network throughput and keystroke latency have not been measured.

## Reproduce

Use the repository's pinned Bun version. Run timings when other test/build jobs
are idle; concurrent compilation makes CPU comparisons unreliable.

```sh
go test ./internal/daemon -run '^TestTerminalFrame' \
  -bench '^BenchmarkTerminalFrame' -benchmem -benchtime=500ms -count=3
cd pwa
bun scripts/terminal-transport-benchmark.ts
bun scripts/terminal-transport-benchmark.ts --serve
```

The Go baseline is the previous map-based JSON encoder, retained in the test as
both a performance reference and a byte-for-byte oracle. `Encode` measures
serialization; `Seal` adds the unchanged ChaCha20-Poly1305 encryption. Each
iteration is a whole frame, including all parts and its initial allocation.

The PWA script builds two browser bundles against the same workload, loading
the original `bytes.ts` and `terminal.ts` from commit
`4a380369adf3b3500106ed95f9e6dcd831a2b3f7` for the baseline. That commit must be
available locally. It measures encoding, decoding, and the production receive
path (AEAD authentication/decryption, UTF-8, JSON parsing, message validation and
frame assembly). Codec measurements are bounded to the real 96 KiB part size;
4 MiB receive measurements cover all 43 encrypted parts. Output bytes are
checked before timing. Timings are medians of three samples after warmup.

For browser measurements, open the printed localhost URL and call
`window.terminalBenchmark(98304)` in the browser console. Supported frame sizes
include 64, 4096, 98304 and 4194304 bytes. The same bundle runs in Bun and the
browser; the page reports its user agent and both measurements.

These are CPU benchmarks, not network or keystroke-to-display latency results.
They do not include the Herdr process, relay, WebSocket scheduling, link RTT,
bandwidth or xterm rendering. A tenfold codec improvement must not be reported
as a tenfold end-to-end improvement. Wire byte counts are unchanged.

## Regression coverage

- Exact old/new JSON equality for empty frames, every byte value, padding and
  chunk boundaries, maximum sequence, full/delta metadata and 4 MiB frames.
- Delayed decryption of all 43 parts after buffer reuse verifies nonce order,
  ciphertext ownership and exact wire contents.
- Native and fallback codecs test binary views, every padding-bit combination,
  invalid alphabets/whitespace/padding and large buffers.
- Herdr canonical decoding tests both encoded and decoded size boundaries.
- Existing terminal lifecycle, input/resize/scroll, sequence-gap and partial-send
  failure tests exercise the unchanged command and session behavior.

Physical phones/tablets and production relay latency need separate live
acceptance; fixture and CPU benchmarks cannot establish those results.

## Verification record

The initial `./scripts/verify.sh` run was **not green**: the selected macOS
Command Line Tools lacked Metal, proxy settings routed localhost test traffic
to a 502 response, the vulnerability database connection ended early, and the
heavily loaded parallel run hit several existing timing assertions. The PWA
portion of that failed run was stopped to reduce contention. No assertion or
test deadline was relaxed.

With the same source snapshot, the failed checks were recovered individually:

- PWA: 5,787 tests across 664 files passed with `--parallel=2`, the existing
  120 s test timeout and one retry. QA, type checking, browser/native production
  builds, asset packing and startup budgets passed.
- Go: the repository race coverage ran; failed CLI tests were rerun with
  localhost excluded from the proxy. The remaining directory-index, journal
  clipping and WebRTC queue timing failures passed targeted race rechecks.
  `go vet`, protocol vectors and the retried vulnerability scan passed.
- Worker: unit/harness/type checks passed; all 14 integration tests across six
  files passed with one worker and localhost excluded from the proxy.
- Desktop: format and all three lint configurations passed with
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`. After applying the
  same localhost proxy exclusion, normal tests passed (285) and headless tests
  passed (201). Each retained its six existing ignored live tests.
- Script tests, source-size checks and `git diff --check` passed. No source file
  changed during this verification and its recovery runs.

This records recovered component checks, not a claim that the initial full-gate
invocation passed. Nothing was committed, pushed or deployed by this task.
