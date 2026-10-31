/**
 * The computer's allowed directories, kept on the phone.
 *
 * The daemon lists once; every keystroke filters this array locally, because a
 * round trip to the relay costs 250 to 290 ms and a scan of the whole index
 * costs about a millisecond. Parsing is strict: a reply or a cached copy that
 * does not match the wire shape is refused rather than patched.
 */

export type DirIndexEntry = { path: string; name: string; parent: string; repo: boolean };

export type DirIndex = { version: string; entries: DirIndexEntry[]; truncated: boolean };

/**
 * Where the picker gets its index. The one implementation reads and writes the
 * cache for one computer and asks that computer's live session, so the view
 * never has to know which computer or which storage it is talking to.
 */
export type DirIndexPort = {
  cached(): DirIndex | null;
  fetch(version: string): Promise<DirIndex | null>;
  save(index: DirIndex): void;
};

export const DIR_INDEX_CACHE_KEY = "pairfob:dirIndex";

/** More rows than the daemon may ever send; a larger reply is not believed. */
export const DIR_INDEX_MAX_ROWS = 20_000;

/** A row per directory is a few hundred bytes; past this the cache write is skipped. */
export const DIR_INDEX_CACHE_MAX_BYTES = 1_572_864;

const VERSION = /^[0-9a-f]{16}$/u;

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

function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && value.length === 0)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return invalid(label);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalid(label);
  return value;
}

function versionOf(value: unknown, label: string): string {
  const version = text(value, label, 16);
  if (!VERSION.test(version)) invalid(label);
  return version;
}

function joinDirPath(base: string, relative: string): string {
  const separator = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
  return `${base}${separator}${relative}`;
}

function relativePath(value: unknown, label: string): string {
  const relative = text(value, label, 4096);
  if (relative.startsWith("/") || relative.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(relative)) invalid(label);
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) invalid(label);
  return relative;
}

/**
 * A full reply, or null for the `unchanged` answer. Rows become one flat list:
 * `path` is the pickable path, `name` and `parent` are what a row draws, and
 * `repo` is the daemon's `.git` mark.
 */
export function parseDirIndex(value: unknown): DirIndex | null {
  const result = record(value, "DirIndex");
  if ("unchanged" in result) {
    exact(result, ["unchanged"], "DirIndex");
    if (result.unchanged !== true) invalid("DirIndex");
    return null;
  }
  exact(result, ["version", "roots", "truncated"], "DirIndex");
  const version = versionOf(result.version, "DirIndex.version");
  if (!Array.isArray(result.roots)) invalid("DirIndex.roots");
  const truncated = bool(result.truncated, "DirIndex.truncated");
  const entries: DirIndexEntry[] = [];
  const seen = new Set<string>();
  for (const rawRoot of result.roots) {
    const root = record(rawRoot, "DirIndex root");
    exact(root, ["path", "repo", "dirs"], "DirIndex root");
    const base = text(root.path, "DirIndex root.path", 4096);
    bool(root.repo, "DirIndex root.repo");
    if (!Array.isArray(root.dirs)) invalid("DirIndex root.dirs");
    for (const rawRow of root.dirs) {
      const row = record(rawRow, "DirIndex row");
      // The daemon leaves `r` out when it is false, which is most rows: the
      // reply is one encrypted frame and the mark is not worth 10 bytes a row.
      const keys = Object.keys(row).sort().join(",");
      if (keys !== "p" && keys !== "p,r") invalid("DirIndex row");
      const relative = relativePath(row.p, "DirIndex row.p");
      const repo = "r" in row ? bool(row.r, "DirIndex row.r") : false;
      const path = joinDirPath(base, relative);
      if (seen.has(path)) invalid("DirIndex row.p");
      seen.add(path);
      const cut = relative.lastIndexOf("/");
      entries.push({
        path,
        name: relative.slice(cut + 1),
        parent: cut <= 0 ? base : joinDirPath(base, relative.slice(0, cut)),
        repo,
      });
      if (entries.length > DIR_INDEX_MAX_ROWS) invalid("DirIndex rows");
    }
  }
  return { version, entries, truncated };
}

function depthOf(path: string): number {
  let depth = 0;
  for (const character of path) {
    if (character === "/" || character === "\\") depth++;
  }
  return depth;
}

type Scored = { entry: DirIndexEntry; score: number; depth: number };

/**
 * The entries that answer `query`, best first. Every whitespace-separated token
 * must appear in the lowercased path; the last token scores the basename
 * (equal, prefix, contains, path only). Ties go to the shorter name, then the
 * shallower path, then the path's own order.
 */
export function filterDirs(entries: readonly DirIndexEntry[], query: string, limit = 60): DirIndexEntry[] {
  const cap = Math.max(0, limit);
  const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!tokens.length) return entries.slice(0, cap);
  const last = tokens[tokens.length - 1];
  const scored: Scored[] = [];
  for (const entry of entries) {
    const path = entry.path.toLowerCase();
    if (!tokens.every((token) => path.includes(token))) continue;
    const name = entry.name.toLowerCase();
    const score = name === last ? 0 : name.startsWith(last) ? 1 : name.includes(last) ? 2 : 3;
    scored.push({ entry, score, depth: depthOf(entry.path) });
  }
  scored.sort((left, right) => left.score - right.score
    || left.entry.name.length - right.entry.name.length
    || left.depth - right.depth
    || left.entry.path.localeCompare(right.entry.path));
  return scored.slice(0, cap).map((item) => item.entry);
}

function parseCachedEntry(value: unknown): DirIndexEntry {
  const item = record(value, "DirIndex cache entry");
  exact(item, ["path", "name", "parent", "repo"], "DirIndex cache entry");
  return {
    path: text(item.path, "DirIndex cache entry.path", 4096),
    name: text(item.name, "DirIndex cache entry.name", 4096),
    parent: text(item.parent, "DirIndex cache entry.parent", 4096, true),
    repo: bool(item.repo, "DirIndex cache entry.repo"),
  };
}

function parseCachedIndex(value: unknown): DirIndex | null {
  const item = record(value, "DirIndex cache");
  exact(item, ["version", "entries", "truncated"], "DirIndex cache");
  const version = versionOf(item.version, "DirIndex cache.version");
  const truncated = bool(item.truncated, "DirIndex cache.truncated");
  if (!Array.isArray(item.entries) || item.entries.length > DIR_INDEX_MAX_ROWS) invalid("DirIndex cache.entries");
  const entries = item.entries.map(parseCachedEntry);
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) invalid("DirIndex cache.entries");
  return { version, entries, truncated };
}

/** The cached index for this computer, or null when it is absent or malformed. */
export function readDirIndexCache(host: string): DirIndex | null {
  try {
    const raw = localStorage.getItem(DIR_INDEX_CACHE_KEY);
    if (!raw) return null;
    const stored = record(JSON.parse(raw), "DirIndex cache");
    exact(stored, ["host", "index"], "DirIndex cache");
    if (stored.host !== host) return null;
    return parseCachedIndex(stored.index);
  } catch {
    return null;
  }
}

/** Keep the index for this computer. A copy too large to be useful is not written. */
export function writeDirIndexCache(host: string, index: DirIndex): void {
  try {
    const raw = JSON.stringify({ host, index });
    if (new TextEncoder().encode(raw).length > DIR_INDEX_CACHE_MAX_BYTES) return;
    localStorage.setItem(DIR_INDEX_CACHE_KEY, raw);
  } catch {
    /* storage blocked or full; the next search asks the daemon again */
  }
}
