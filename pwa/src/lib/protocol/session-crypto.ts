import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "./bytes.ts";
import { verifyEd25519 } from "./hello.ts";

/** One fresh DeviceHello key exchange. Private keys are never pooled or reused. */
export type SessionCrypto = {
  publicKey: Uint8Array;
  sharedSecret(peer: Uint8Array): Promise<Uint8Array>;
  verify(pk: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
  dispose(): void;
};

const unsupportedX = new WeakSet<SubtleCrypto>();
const unsupportedEd = new WeakSet<SubtleCrypto>();
// Only public verification keys are cached, bounded per crypto provider.
const verificationKeys = new WeakMap<SubtleCrypto, Map<string, Promise<CryptoKey>>>();
const MAX_VERIFICATION_KEYS = 16;
const unsupported = (error: unknown) =>
  typeof error === "object" && error !== null && "name" in error && error.name === "NotSupportedError";

async function verifySignature(
  subtle: SubtleCrypto | null, pk: Uint8Array, message: Uint8Array, signature: Uint8Array,
): Promise<boolean> {
  if (!subtle || unsupportedEd.has(subtle)) return verifyEd25519(pk, message, signature);
  let cache = verificationKeys.get(subtle);
  if (!cache) { cache = new Map(); verificationKeys.set(subtle, cache); }
  const identity = bytesToHex(pk);
  let key = cache.get(identity);
  try {
    if (!key) {
      if (cache.size >= MAX_VERIFICATION_KEYS) cache.delete(cache.keys().next().value!);
      key = subtle.importKey("raw", pk.slice(), "Ed25519", false, ["verify"]);
      cache.set(identity, key);
    }
    // A negative native verdict is final. Only lack of algorithm support may
    // select the existing implementation; verification errors never bypass auth.
    return await subtle.verify("Ed25519", await key, signature.slice(), message.slice());
  } catch (error) {
    if (cache.get(identity) === key) cache.delete(identity);
    if (!unsupported(error)) throw error;
    unsupportedEd.add(subtle);
    return verifyEd25519(pk, message, signature);
  }
}

/** Existing implementation, also the explicit byte-compatible benchmark oracle. */
export function legacySessionCrypto(subtle: SubtleCrypto | null = null): SessionCrypto {
  let secret: Uint8Array | null = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(secret);
  const dispose = () => { secret?.fill(0); secret = null; };
  return {
    publicKey,
    verify: (pk, message, signature) => verifySignature(subtle, pk, message, signature),
    sharedSecret: async (peer) => {
      if (!secret) throw new Error("session ephemeral key is retired");
      try { return x25519.getSharedSecret(secret, peer); } finally { dispose(); }
    },
    dispose,
  };
}

/** Native primitives preserve X25519/Ed25519 and all transcript/KDF bytes. */
export async function createSessionCrypto(
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<SessionCrypto> {
  if (!subtle || unsupportedX.has(subtle)) return legacySessionCrypto(subtle);
  let keys: CryptoKeyPair;
  try {
    keys = await subtle.generateKey("X25519", false, ["deriveBits"]) as CryptoKeyPair;
  } catch (error) {
    if (!unsupported(error)) throw error;
    unsupportedX.add(subtle);
    return legacySessionCrypto(subtle);
  }
  const publicKey = new Uint8Array(await subtle.exportKey("raw", keys.publicKey));
  let secret: CryptoKey | null = keys.privateKey;
  return {
    publicKey,
    verify: (pk, message, signature) => verifySignature(subtle, pk, message, signature),
    sharedSecret: async (peer) => {
      if (!secret) throw new Error("session ephemeral key is retired");
      const privateKey = secret;
      secret = null;
      const publicPeer = await subtle.importKey("raw", peer.slice(), "X25519", false, []);
      return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: publicPeer }, privateKey, 256));
    },
    dispose: () => { secret = null; },
  };
}
