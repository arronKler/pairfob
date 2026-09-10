import { base64Decode, base64Encode } from "./bytes.ts";

export const MEDIA_CHUNK_BYTES = 65_536;
export const MEDIA_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 32 * 1024 * 1024;
export const MEDIA_MAX_PIXELS = 16_777_216;
export const MEDIA_MAX_DIMENSION = 8192;

export type WorkspaceMediaKind = "image" | "video" | "audio" | "download";

export type WorkspaceMediaOpen = {
  handle: string;
  path: string;
  kind: WorkspaceMediaKind;
  mime: string;
  size: number;
  modified_ms: number;
  sha256: string;
  expires_ms: number;
  chunk_bytes: number;
  max_bytes: number;
  max_pixels: number;
  width: number;
  height: number;
};

export type WorkspaceMediaChunk = {
  handle: string;
  offset: number;
  length: number;
  bytes: Uint8Array;
  eof: boolean;
};

export type WorkspaceMediaClose = { handle: string; closed: true };

function invalid(label: string): never {
  throw new Error(`${label} 响应格式不正确`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(label);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) invalid(label);
}

function text(value: unknown, label: string, max: number, empty = true): string {
  if (typeof value !== "string" || value.length > max || (!empty && value.length === 0) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    return invalid(label);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) return invalid(label);
  return value as number;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalid(label);
  return value;
}

function relative(value: unknown, label: string): string {
  const result = text(value, label, 4096, false);
  if (/[\u0000-\u001f\u007f]/u.test(result) || result.startsWith("/") || result.startsWith("\\") || result.split(/[\\/]/u).some((part) => part === "..")) {
    return invalid(label);
  }
  return result;
}

function handle(value: unknown, label: string): string {
  const result = text(value, label, 38, false);
  if (!/^media_[0-9a-f]{32}$/u.test(result)) invalid(label);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label, 64, false);
  if (!/^[0-9a-f]{64}$/u.test(result)) invalid(label);
  return result;
}

export function parseWorkspaceMediaOpen(value: unknown): WorkspaceMediaOpen {
  const result = record(value, "WorkspaceMediaOpen");
  exact(result, [
    "handle", "path", "kind", "mime", "size", "modified_ms", "sha256", "expires_ms",
    "chunk_bytes", "max_bytes", "max_pixels", "width", "height",
  ], "WorkspaceMediaOpen");
  const kind = text(result.kind, "WorkspaceMediaOpen.kind", 16, false);
  if (kind !== "image" && kind !== "video" && kind !== "audio" && kind !== "download") invalid("WorkspaceMediaOpen.kind");
  const mime = text(result.mime, "WorkspaceMediaOpen.mime", 128, false);
  if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/u.test(mime)) invalid("WorkspaceMediaOpen.mime");
  const width = integer(result.width, "WorkspaceMediaOpen.width", 0, MEDIA_MAX_DIMENSION);
  const height = integer(result.height, "WorkspaceMediaOpen.height", 0, MEDIA_MAX_DIMENSION);
  return {
    handle: handle(result.handle, "WorkspaceMediaOpen.handle"),
    path: relative(result.path, "WorkspaceMediaOpen.path"),
    kind,
    mime,
    size: integer(result.size, "WorkspaceMediaOpen.size", 0, MEDIA_MAX_BYTES),
    modified_ms: integer(result.modified_ms, "WorkspaceMediaOpen.modified_ms", -8_640_000_000_000_000),
    sha256: digest(result.sha256, "WorkspaceMediaOpen.sha256"),
    expires_ms: integer(result.expires_ms, "WorkspaceMediaOpen.expires_ms"),
    chunk_bytes: integer(result.chunk_bytes, "WorkspaceMediaOpen.chunk_bytes", MEDIA_CHUNK_BYTES, MEDIA_CHUNK_BYTES),
    max_bytes: integer(result.max_bytes, "WorkspaceMediaOpen.max_bytes", 1, MEDIA_MAX_BYTES),
    max_pixels: integer(result.max_pixels, "WorkspaceMediaOpen.max_pixels", 1),
    width,
    height,
  };
}

export function parseWorkspaceMediaChunk(value: unknown): WorkspaceMediaChunk {
  const result = record(value, "WorkspaceMediaRead");
  exact(result, ["handle", "offset", "length", "bytes", "eof"], "WorkspaceMediaRead");
  const encoded = text(result.bytes, "WorkspaceMediaRead.bytes", 87_384);
  let bytes: Uint8Array;
  try {
    bytes = encoded ? base64Decode(encoded) : new Uint8Array();
  } catch {
    return invalid("WorkspaceMediaRead.bytes");
  }
  if (encoded && base64Encode(bytes) !== encoded) invalid("WorkspaceMediaRead.bytes");
  const length = integer(result.length, "WorkspaceMediaRead.length", 0, MEDIA_CHUNK_BYTES);
  if (bytes.length !== length) invalid("WorkspaceMediaRead.length");
  return {
    handle: handle(result.handle, "WorkspaceMediaRead.handle"),
    offset: integer(result.offset, "WorkspaceMediaRead.offset", 0, MEDIA_MAX_BYTES),
    length,
    bytes,
    eof: bool(result.eof, "WorkspaceMediaRead.eof"),
  };
}

export function parseWorkspaceMediaClose(value: unknown): WorkspaceMediaClose {
  const result = record(value, "WorkspaceMediaClose");
  exact(result, ["handle", "closed"], "WorkspaceMediaClose");
  if (result.closed !== true) invalid("WorkspaceMediaClose.closed");
  return { handle: handle(result.handle, "WorkspaceMediaClose.handle"), closed: true };
}

export function imageExceedsPixelBudget(width: number, height: number, maxPixels = MEDIA_MAX_PIXELS, maxDimension = MEDIA_MAX_DIMENSION): boolean {
  if (width <= 0 || height <= 0) return false;
  return width > maxDimension || height > maxDimension || width * height > maxPixels;
}
