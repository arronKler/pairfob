// Native byte codecs avoid spreading terminal buffers into JS strings. Keep
// the older-browser path, with identical canonical validation on both paths.
type NativeDecoder = typeof Uint8Array & { fromBase64?: (value: string) => Uint8Array };
type NativeEncoder = Uint8Array & { toBase64?: () => string };
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: Uint8Array): string {
  const native = (bytes as NativeEncoder).toBase64;
  if (native) return native.call(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
  }
  return btoa(binary);
}

export function base64Decode(value: string): Uint8Array {
  // A flat alphabet check avoids the repeated-group regexp's stack growth on
  // large frames. Padding length and zero tail bits establish canonical form
  // without encoding the entire decoded buffer a second time. Native decoders
  // and atob both allow whitespace, so neither replaces this validation.
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding))) throw new Error("base64");
  if (padding && (ALPHABET.indexOf(value[value.length - padding - 1]) & (padding === 2 ? 15 : 3))) {
    throw new Error("base64 non-canonical");
  }
  const native = (Uint8Array as NativeDecoder).fromBase64;
  if (native) return native.call(Uint8Array, value);
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}
