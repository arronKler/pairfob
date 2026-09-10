import { describe, expect, test } from "bun:test";
import { base64Encode } from "./bytes";
import {
  MEDIA_CHUNK_BYTES,
  imageExceedsPixelBudget,
  parseWorkspaceMediaChunk,
  parseWorkspaceMediaClose,
  parseWorkspaceMediaOpen,
} from "./workspace-media";

const sha = "a".repeat(64);
const handle = "media_" + "b".repeat(32);

function openFixture(over: Record<string, unknown> = {}) {
  return {
    handle, path: "photos/cat.png", kind: "image", mime: "image/png", size: 4, modified_ms: 1,
    sha256: sha, expires_ms: 1_700_000_000_000, chunk_bytes: MEDIA_CHUNK_BYTES,
    max_bytes: 10 * 1024 * 1024, max_pixels: 16_777_216, width: 8, height: 8, ...over,
  };
}

describe("workspace media protocol boundary", () => {
  test("parses an exact open result", () => {
    expect(parseWorkspaceMediaOpen(openFixture()).kind).toBe("image");
  });

  test("rejects extra fields, traversal, and prefix hashes as media digests", () => {
    expect(() => parseWorkspaceMediaOpen(openFixture({ extra: true }))).toThrow();
    expect(() => parseWorkspaceMediaOpen(openFixture({ path: "../secret.png" }))).toThrow();
    expect(() => parseWorkspaceMediaOpen(openFixture({ sha256: "zz" }))).toThrow();
    expect(() => parseWorkspaceMediaOpen(openFixture({ handle: "term_" + "b".repeat(32) }))).toThrow();
    expect(() => parseWorkspaceMediaOpen(openFixture({ chunk_bytes: 1024 }))).toThrow();
  });

  test("requires canonical standard base64 and exact offset/length", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    const encoded = base64Encode(bytes);
    const chunk = parseWorkspaceMediaChunk({
      handle, offset: 0, length: bytes.length, bytes: encoded, eof: false,
    });
    expect(chunk.bytes).toEqual(bytes);
    expect(() => parseWorkspaceMediaChunk({
      handle, offset: 0, length: bytes.length, bytes: encoded + "\n", eof: false,
    })).toThrow();
    expect(() => parseWorkspaceMediaChunk({
      handle, offset: 0, length: bytes.length + 1, bytes: encoded, eof: false,
    })).toThrow();
    expect(parseWorkspaceMediaClose({ handle, closed: true }).closed).toBe(true);
    expect(() => parseWorkspaceMediaClose({ handle, closed: false })).toThrow();
  });

  test("pixel budget rejects oversized decoded images only", () => {
    expect(imageExceedsPixelBudget(8, 8)).toBe(false);
    expect(imageExceedsPixelBudget(8193, 1)).toBe(true);
    expect(imageExceedsPixelBudget(4096, 4097)).toBe(true);
    expect(imageExceedsPixelBudget(0, 10)).toBe(false);
  });
});
