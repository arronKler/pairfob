import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { x25519 } from "@noble/curves/ed25519.js";
import { Direction, DIR_C, MAX_PLAINTEXT } from "./aead.ts";
import { bytesToHex, hexToBytes } from "./bytes.ts";
import { fingerprint16, proof, sas, transcriptD, transcriptP, verifyEd25519 } from "./hello.ts";
import { pairfobHKDF, pairingKeys, sessionKeys, zeros32 } from "./kdf.ts";
import { deriveRecord, idProver, Prover } from "./spake.ts";

const vec = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../proto/pairfob-vectors.json"), "utf8"),
);

function padHex(n: bigint, nbytes: number): string {
  return n.toString(16).padStart(nbytes * 2, "0");
}

describe("frozen pairfob.v1 vectors (shipped protocol)", () => {
  test("single pairing code and caps from JSON", () => {
    expect(vec.normalized_s).toBe("7K3M9H2P");
    expect(vec.max_plain).toBe(262116);
    expect(MAX_PLAINTEXT).toBe(vec.max_plain);
    expect(idProver(vec.pair_ref_hex)).toBe(vec.id_prover);
  });

  test("Argon2id + SPAKE2+ + HKDF + AEAD + DeviceHello", async () => {
    const rec = await deriveRecord(vec.normalized_s, vec.daemon_id, vec.pair_ref_hex);
    expect(padHex(rec.w0, 32)).toBe(vec.w0);
    expect(padHex(rec.w1, 32)).toBe(vec.w1);
    expect(bytesToHex(rec.L)).toBe(vec.L);

    const pr = new Prover(rec, idProver(vec.pair_ref_hex), vec.daemon_id);
    const x = BigInt("0x" + vec.prover_x);
    const shareP = pr.start(x);
    expect(bytesToHex(shareP)).toBe(vec.shareP);
    const keys = pr.finish(hexToBytes(vec.shareV));
    expect(bytesToHex(keys.kShared)).toBe(vec.k_shared);
    expect(bytesToHex(keys.confirmP)).toBe(vec.confirm_p);

    expect(sas(keys.kShared)).toBe(vec.sas);
    const pair = pairingKeys(keys.kShared);
    expect(bytesToHex(pair.c2s)).toBe(vec.pair_c2s);
    expect(bytesToHex(pair.s2c)).toBe(vec.pair_s2c);

    const dummy = hexToBytes(vec.hkdf_sas4_ikm);
    const sas4 = pairfobHKDF(dummy, zeros32, new TextEncoder().encode("pairfob-v1/sas"), 4);
    expect(bytesToHex(sas4)).toBe(vec.hkdf_sas4);

    const rid = hexToBytes(vec.pair_ref_hex);
    const dir = new Direction(pair.c2s, DIR_C);
    const sealed = dir.seal(rid, new TextEncoder().encode(vec.ping_pt));
    expect(bytesToHex(sealed)).toBe(vec.aead_ping);

    const ephP = hexToBytes(vec.eph_p);
    const ephD = hexToBytes(vec.eph_d);
    const nonce = hexToBytes(vec.hello_nonce);
    const td = transcriptD(vec.daemon_id, vec.device_id, ephP, ephD, nonce, BigInt(vec.hello_ts), rid);
    expect(bytesToHex(td)).toBe(vec.hello_td);
    const tp = transcriptP(td);
    expect(bytesToHex(tp)).toBe(vec.hello_tp);
    const psk = hexToBytes(vec.device_psk);
    expect(bytesToHex(proof(psk, td))).toBe(vec.proof_d);
    expect(bytesToHex(proof(psk, tp))).toBe(vec.proof_p);
    const pk = hexToBytes(vec.ed25519_pk);
    expect(fingerprint16(pk)).toBe(vec.fp);
    expect(verifyEd25519(pk, td, hexToBytes(vec.sig_d))).toBe(true);

    const dh = x25519.getSharedSecret(hexToBytes(vec.eph_p_sk), hexToBytes(vec.eph_d));
    const sess = sessionKeys(dh, psk);
    expect(bytesToHex(sess.c2s)).toBe(vec.sess_c2s);
    expect(bytesToHex(sess.s2c)).toBe(vec.sess_s2c);
  }, 30000);
});
