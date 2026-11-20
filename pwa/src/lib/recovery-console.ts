import type { PairResult } from "./protocol/client";

type Computer = Pick<PairResult, "daemonId" | "deviceId" | "fp">;
const key = (id: string) => "pairfob.recovery-console." + id;

export function consoleURL(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^https:\/\/[^/]/i.test(text) || /[\s\\?#\u0000-\u001f\u007f]/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export function readConsole(computer: Computer): string {
  try {
    const item = JSON.parse(localStorage.getItem(key(computer.daemonId)) ?? "null");
    return item?.fp === computer.fp && item.device === computer.deviceId ? consoleURL(item.url)?.href ?? "" : "";
  } catch { return ""; }
}

export function saveConsole(computer: Computer, raw: string): void {
  const url = consoleURL(raw);
  if (!url) throw new Error("Invalid recovery console URL");
  localStorage.setItem(key(computer.daemonId), JSON.stringify({ fp: computer.fp, device: computer.deviceId, url: url.href }));
}

export function forgetConsole(id: string): void {
  localStorage.removeItem(key(id));
}
