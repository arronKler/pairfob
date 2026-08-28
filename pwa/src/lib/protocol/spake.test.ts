import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes } from "./bytes.ts";
import { deriveRecord, idProver, Prover } from "./spake.ts";

const vec = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../proto/pairfob-vectors.json"), "utf8"),
);

function padHex(n: bigint, nbytes: number): string {
  return n.toString(16).padStart(nbytes * 2, "0");
}

describe("SPAKE2+ vs frozen pairfob-vectors", () => {
  test("Argon2id w0/w1 match Go", async () => {
    const rec = await deriveRecord(vec.normalized_s, vec.daemon_id, vec.pair_ref_hex);
    expect(padHex(rec.w0, 32)).toBe(vec.w0);
    expect(padHex(rec.w1, 32)).toBe(vec.w1);
    expect(bytesToHex(rec.L)).toBe(vec.L);
  }, 30000);

  test("fixed x yields shareP and K_shared", async () => {
    const rec = await deriveRecord(vec.normalized_s, vec.daemon_id, vec.pair_ref_hex);
    const pr = new Prover(rec, idProver(vec.pair_ref_hex), vec.daemon_id);
    const x = BigInt("0x" + vec.prover_x);
    const shareP = pr.start(x);
    expect(bytesToHex(shareP)).toBe(vec.shareP);
    const keys = pr.finish(hexToBytes(vec.shareV));
    expect(bytesToHex(keys.kShared)).toBe(vec.k_shared);
  }, 30000);
});
