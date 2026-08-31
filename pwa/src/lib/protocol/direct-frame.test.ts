import { describe, expect, test } from "bun:test";
import { DirectFrameAssembler, splitDirectFrame } from "./direct-frame.ts";

describe("P2P frame chunks", () => {
  test("round trips a maximum-size envelope with bounded DataChannel messages", () => {
    const frame = new Uint8Array(24 + 262_144);
    crypto.getRandomValues(frame.subarray(0, 65_536));
    frame[0] = 1;
    frame[frame.length - 1] = 77;
    const chunks = splitDirectFrame(frame);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(16 * 1024);
    const assembler = new DirectFrameAssembler();
    let complete: Uint8Array | null = null;
    for (const chunk of chunks) complete = assembler.push(chunk);
    expect(complete).toEqual(frame);
  });

  test("rejects interleaved and out-of-order chunks", () => {
    const first = splitDirectFrame(new Uint8Array(70_000));
    const second = splitDirectFrame(new Uint8Array(80_000));
    const assembler = new DirectFrameAssembler();
    expect(assembler.push(first[0])).toBeNull();
    expect(() => assembler.push(second[0])).toThrow("interleaved");

    const ordered = new DirectFrameAssembler();
    expect(() => ordered.push(first[1])).toThrow("out-of-order");
  });
});
