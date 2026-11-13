import { expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import vectors from "../../../../proto/pairfob-vectors.json";
import { hexToBytes } from "./bytes.ts";
import { sessionKeys } from "./kdf.ts";
import { createSessionCrypto, legacySessionCrypto } from "./session-crypto.ts";

const native = globalThis.crypto.subtle;
// Each provider has its own capability/cache state, just as separate browser realms do.
function provider(overrides: Partial<SubtleCrypto> = {}): SubtleCrypto {
  return new Proxy(native, {
    get(target, property) {
      const override = Reflect.get(overrides, property);
      if (override) return override;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
const unsupported = () => new DOMException("algorithm unavailable", "NotSupportedError");
const pk = hexToBytes(vectors.ed25519_pk);
const message = hexToBytes(vectors.hello_td);
const signature = hexToBytes(vectors.sig_d);

for (const [name, create] of [
  ["native", () => createSessionCrypto()],
  ["legacy", () => createSessionCrypto(null)],
] as const) {
  test(`${name} X25519 agrees with the daemon and retires each private key after use`, async () => {
    const client = await create();
    const daemonSecret = x25519.utils.randomPrivateKey();
    const expected = x25519.getSharedSecret(daemonSecret, client.publicKey);
    const actual = await client.sharedSecret(x25519.getPublicKey(daemonSecret));
    expect(actual).toEqual(expected);
    expect(sessionKeys(actual, hexToBytes(vectors.device_psk))).toEqual(sessionKeys(expected, hexToBytes(vectors.device_psk)));
    await expect(client.sharedSecret(x25519.getPublicKey(daemonSecret))).rejects.toThrow("retired");
    client.dispose();
  });

  test(`${name} preserves the frozen DeviceHello signature and rejects tampering`, async () => {
    const client = await create();
    try {
      expect(await client.verify(pk, message, signature)).toBe(true);
      const altered = message.slice(); altered[0] ^= 1;
      expect(await client.verify(pk, altered, signature)).toBe(false);
      expect(await client.verify(pk, message, new Uint8Array(64))).toBe(false);
    } finally { client.dispose(); }
  });

  test(`${name} never reuses ephemeral keys and disposal prevents DH`, async () => {
    const a = await create(), b = await create();
    expect(a.publicKey).not.toEqual(b.publicKey);
    a.dispose(); b.dispose();
    await expect(a.sharedSecret(b.publicKey)).rejects.toThrow("retired");
  });

  test(`${name} rejects an all-zero peer key`, async () => {
    const client = await create();
    await expect(client.sharedSecret(new Uint8Array(32))).rejects.toThrow();
    await expect(client.sharedSecret(x25519.getPublicKey(new Uint8Array(32).fill(1)))).rejects.toThrow("retired");
  });
}

test("unsupported X25519 falls back once per provider while preserving native Ed25519", async () => {
  let attempts = 0, verifications = 0;
  const subtle = provider({
    generateKey: (() => { attempts++; return Promise.reject(unsupported()); }) as SubtleCrypto["generateKey"],
    verify: (...args) => { verifications++; return native.verify(...args); },
  });
  for (let i = 0; i < 2; i++) {
    const client = await createSessionCrypto(subtle);
    const daemon = x25519.utils.randomPrivateKey();
    expect(await client.sharedSecret(x25519.getPublicKey(daemon))).toEqual(x25519.getSharedSecret(daemon, client.publicKey));
    expect(await client.verify(pk, message, signature)).toBe(true);
    client.dispose();
  }
  expect(attempts).toBe(1);
  expect(verifications).toBe(2);
});

test("unsupported Ed25519 falls back once, including synchronous provider errors", async () => {
  let attempts = 0;
  const client = await createSessionCrypto(provider({
    importKey: (() => { attempts++; throw unsupported(); }) as SubtleCrypto["importKey"],
  }));
  try {
    expect(await client.verify(pk, message, signature)).toBe(true);
    expect(await client.verify(pk, message, new Uint8Array(64))).toBe(false);
    expect(attempts).toBe(1);
  } finally { client.dispose(); }
});

test("negative native verification never falls back to a valid legacy signature", async () => {
  const client = await createSessionCrypto(provider({ verify: async () => false }));
  try { expect(await client.verify(pk, message, signature)).toBe(false); }
  finally { client.dispose(); }
});

test("provider failures other than unsupported algorithms fail closed", async () => {
  const failure = new DOMException("provider failed", "OperationError");
  await expect(createSessionCrypto(provider({ generateKey: (() => Promise.reject(failure)) as SubtleCrypto["generateKey"] }))).rejects.toBe(failure);
  const client = await createSessionCrypto(provider({ verify: async () => { throw failure; } }));
  try { await expect(client.verify(pk, message, signature)).rejects.toBe(failure); }
  finally { client.dispose(); }
});

test("only public verification keys are cached, shared concurrently and bounded to 16", async () => {
  let imports = 0;
  const subtle = provider({ importKey: ((...args: Parameters<SubtleCrypto["importKey"]>) => {
    imports++; return native.importKey(...args);
  }) as SubtleCrypto["importKey"] });
  // Legacy DH isolates the verification-key imports in this count.
  const a = legacySessionCrypto(subtle), b = legacySessionCrypto(subtle);
  try {
    expect(await Promise.all([a.verify(pk, message, signature), b.verify(pk, message, signature)])).toEqual([true, true]);
    expect(imports).toBe(1);
    for (let i = 1; i <= 16; i++) {
      const secret = new Uint8Array(32).fill(i);
      expect(await a.verify(ed25519.getPublicKey(secret), message, ed25519.sign(message, secret))).toBe(true);
    }
    expect(imports).toBe(17);
    expect(await b.verify(pk, message, signature)).toBe(true);
    expect(imports).toBe(18); // The oldest public key was evicted.
  } finally { a.dispose(); b.dispose(); }
});
