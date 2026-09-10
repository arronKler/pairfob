import {
  MEDIA_IMAGE_MAX_BYTES,
  MEDIA_MAX_BYTES,
  type WorkspaceMediaKind,
} from "../../lib/protocol/workspace-media";

export type WorkspaceFileRole = "text" | "image" | "video" | "audio" | "svg" | "download";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "weba"]);

export function fileExtension(path: string): string {
  const name = path.split("/").pop() || path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function classifyWorkspaceFile(path: string): WorkspaceFileRole {
  const ext = fileExtension(path);
  if (ext === "svg") return "svg";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "text";
}

export function mediaCapBytes(kind: WorkspaceMediaKind | WorkspaceFileRole): number {
  return kind === "image" ? MEDIA_IMAGE_MAX_BYTES : MEDIA_MAX_BYTES;
}

export function formatMediaBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}

export function mediaFilename(path: string): string {
  return path.split("/").pop() || path;
}

/** Renderable media state published in the immutable workspace snapshot. */
export type WorkspaceMediaStatus = "idle" | "loading" | "ready" | "oversize" | "error" | "codec";

export type WorkspaceMediaView = {
  path: string;
  role: WorkspaceFileRole;
  status: WorkspaceMediaStatus;
  kind: WorkspaceMediaKind | "";
  mime: string;
  size: number;
  loaded: number;
  cap: number;
  /** Object URL of the loaded blob. A primitive string; the URL/Blob/loader
   * lifetime is owned privately by the workspace store, never deep-copied. */
  url: string;
  error: string;
  width: number;
  height: number;
};

export function emptyMediaView(): WorkspaceMediaView {
  return {
    path: "", role: "text", status: "idle", kind: "", mime: "",
    size: 0, loaded: 0, cap: 0, url: "", error: "", width: 0, height: 0,
  };
}
