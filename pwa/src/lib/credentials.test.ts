import { describe, expect, test } from "bun:test";
import { fingerprint16 } from "./protocol/hello.ts";
import { b64url } from "./protocol/bytes.ts";
import { decodeCredential, encodeCredential, migrateLegacyCredential, validateStoredCredential } from "./credentials.ts";

describe("stored credentials", () => {
  test("round trips every required field", () => {
    const daemonPk = Uint8Array.from({ length: 32 }, (_, index) => index);
    const pair = {
      daemonId: "d_0123456789abcdefabcd",
      deviceId: "dev_abcdefgh",
      psk: new Uint8Array(32).fill(7),
      daemonPk,
      fp: fingerprint16(daemonPk),
      relayOrigin: "https://pairfob.com",
      label: "Test phone",
      createdAt: 123,
    };
    const stored = encodeCredential(pair);
    expect(stored).toEqual({
      daemon_id: "d_0123456789abcdefabcd",
      device_id: "dev_abcdefgh",
      device_psk: b64url(pair.psk),
      daemon_pk: b64url(daemonPk),
      relay_origin: "https://pairfob.com",
      fp: pair.fp,
      label: "Test phone",
      created_at: 123,
    });
    expect(decodeCredential(stored)).toEqual(pair);
  });

  test("keeps hostname and last seen without invalidating old rows", () => {
    const daemonPk = Uint8Array.from({ length: 32 }, (_, index) => index);
    const pair = {
      daemonId: "d_0123456789abcdefabcd",
      deviceId: "dev_abcdefgh",
      psk: new Uint8Array(32).fill(7),
      daemonPk,
      fp: fingerprint16(daemonPk),
      relayOrigin: "https://pairfob.com",
      label: "Test phone",
      createdAt: 123,
      hostname: "studio",
      lastSeen: 456,
    };
    const stored = encodeCredential(pair);
    expect(stored.hostname).toBe("studio");
    expect(stored.last_seen).toBe(456);
    expect(decodeCredential(stored)).toEqual(pair);
    expect(validateStoredCredential({
      ...stored,
      hostname: "bad\nhost",
      last_seen: -1,
    })).toEqual({
      daemon_id: stored.daemon_id,
      device_id: stored.device_id,
      device_psk: stored.device_psk,
      daemon_pk: stored.daemon_pk,
      relay_origin: stored.relay_origin,
      fp: stored.fp,
      label: stored.label,
      created_at: stored.created_at,
    });
  });

  test("rejects corrupt key material and fingerprint", () => {
    expect(validateStoredCredential({})).toBeNull();
    expect(validateStoredCredential({
      daemon_id: "d",
      device_id: "dev",
      device_psk: b64url(new Uint8Array(31)),
      daemon_pk: b64url(new Uint8Array(32)),
      relay_origin: "https://pairfob.com",
      fp: "wrong",
      label: "phone",
      created_at: 1,
    })).toBeNull();
    const daemonPk = new Uint8Array(32);
    expect(() => encodeCredential({
      daemonId: "d_bad",
      deviceId: "dev_12345678",
      psk: new Uint8Array(32),
      daemonPk,
      fp: fingerprint16(daemonPk),
      relayOrigin: "https://pairfob.com",
      label: "phone",
      createdAt: 1,
    })).toThrow("invalid credential");
  });

  test("upgrades the prototype typed-array record", () => {
    const legacy = migrateLegacyCredential({
      daemon_id: "d_abcdef0123456789abcd",
      device_id: "dev_legacy01",
      device_psk: new Uint8Array(32).fill(1),
      daemon_pk: new Uint8Array(32).fill(2),
      sas: "unused",
    }, "https://pairfob.com");
    expect(legacy?.relay_origin).toBe("https://pairfob.com");
    expect(legacy?.fp).toBe(fingerprint16(new Uint8Array(32).fill(2)));
  });
});
