// CPU benchmark of the production codecs and encrypted receive path. Network
// latency and xterm rendering are deliberately outside these measurements.
import { base64Decode, base64Encode } from "../src/lib/protocol/bytes";
import { Direction, DIR_S } from "../src/lib/protocol/aead";
import { validateSessionMessage } from "../src/lib/protocol/session-message";
import { TerminalFrameAssembler } from "../src/lib/protocol/terminal";

let sink = 0;

function measure(run: () => number): number {
  const warmup = performance.now();
  do { sink ^= run(); } while (performance.now() - warmup < 150);
  const samples: number[] = [];
  for (let sample = 0; sample < 3; sample++) {
    let count = 0;
    const start = performance.now();
    do {
      sink ^= run();
      count++;
    } while (performance.now() - start < 100);
    samples.push((performance.now() - start) / count);
  }
  return samples.sort((a, b) => a - b)[1];
}

export function run(size: number) {
  const data = Uint8Array.from({ length: size }, (_, index) => index & 255);
  const chunk = 96 * 1024;
  const codecData = data.subarray(0, chunk);
  const encoded = base64Encode(codecData);
  const key = new Uint8Array(32);
  const route = new Uint8Array(16);
  const sender = new Direction(key, DIR_S);
  const receiver = new Direction(key, DIR_S);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const assembler = new TerminalFrameAssembler();
  const count = Math.max(1, Math.ceil(size / chunk));
  const payloads = Array.from({ length: count }, (_, index) => sender.seal(route, new TextEncoder().encode(JSON.stringify({
    v: 1, op: "TerminalFrame", params: {
      terminal_id: "term_0123456789abcdef0123456789abcdef", seq: "1", width: 120, height: 40,
      full: true, index, count, data: base64Encode(data.subarray(index * chunk, (index + 1) * chunk)),
    },
  }))));
  const receive = () => {
    // Replay the fixture as a new receive epoch, still checking every nonce
    // and Poly1305 tag with the unchanged production Direction implementation.
    receiver.seq = 0n;
    let output: Uint8Array | undefined;
    for (const payload of payloads) {
      const message = validateSessionMessage(JSON.parse(decoder.decode(receiver.open(route, payload))));
      if (message.kind !== "terminal_frame") throw new Error("unexpected message");
      const frame = assembler.push(message.frame);
      if (frame) output = frame.data;
    }
    if (!output || output.length !== size) throw new Error("frame reassembly failed");
    return output;
  };
  const output = receive();
  if (output.some((value, index) => value !== data[index])) throw new Error("terminal bytes changed");
  return {
    bytes: size,
    codecBytes: codecData.length,
    encodeMs: measure(() => base64Encode(codecData).length),
    decodeMs: measure(() => base64Decode(encoded).length),
    receiveMs: measure(() => receive().length),
    sink,
  };
}
