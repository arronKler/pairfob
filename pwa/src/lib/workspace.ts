export type WorkspaceFeatures = {
  files: boolean;
  git_status: boolean;
  git_diff: boolean;
  git_branches: boolean;
};

export type WorkspaceRepository = {
  name: string;
  branch: string | null;
  head: string;
  detached: boolean;
};

export type WorkspaceDescriptor = {
  name: string;
  root: string;
  features: WorkspaceFeatures;
  git: WorkspaceRepository | null;
};

export type WorkspaceEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number;
  modified_ms: number;
  hidden: boolean;
};

export type WorkspaceDirectoryPage = {
  path: string;
  entries: WorkspaceEntry[];
  next_cursor: string | null;
  truncated: boolean;
  revision: string;
};

export type WorkspaceFile = {
  path: string;
  kind: "text" | "binary";
  size: number;
  modified_ms: number;
  content: string;
  truncated: boolean;
  revision: string;
};

export type GitChange = {
  path: string;
  original_path: string | null;
  index: string;
  worktree: string;
};

export type GitStatus = {
  branch: string | null;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
  truncated: boolean;
  revision: string;
};

export type GitDiff = {
  path: string;
  layer: "worktree" | "staged";
  patch: string;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  revision: string;
};

export type GitBranch = {
  name: string;
  kind: "local" | "remote";
  current: boolean;
  head: string;
  upstream: string | null;
};

export type GitBranches = { items: GitBranch[]; truncated: boolean; revision: string };
export type GitLayer = "worktree" | "staged";
export type GitChangeKind = "added" | "conflict" | "copied" | "deleted" | "modified" | "renamed" | "type" | "untracked";

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

function text(value: unknown, label: string, max = 4096, empty = true): string {
  if (typeof value !== "string" || value.length > max || (!empty && value.length === 0) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    return invalid(label);
  }
  return value;
}

function safeText(value: unknown, label: string, max = 4096, empty = true): string {
  const result = text(value, label, max, empty);
  if (/[\u0000-\u001f\u007f]/u.test(result)) invalid(label);
  return result;
}

function relative(value: unknown, label: string, empty = false): string {
  const result = safeText(value, label, 4096, empty);
  if (result.startsWith("/") || result.startsWith("\\") || result.split(/[\\/]/u).some((part) => part === "..")) invalid(label);
  return result;
}

function nullableText(value: unknown, label: string, max = 4096): string | null {
  return value === null ? null : safeText(value, label, max, false);
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) return invalid(label);
  return value as number;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalid(label);
  return value;
}

function revision(value: unknown, label: string): string {
  const result = text(value, label, 64, false);
  if (!/^[0-9a-f]{64}$/u.test(result)) invalid(label);
  return result;
}

export function parseWorkspaceDescriptor(value: unknown): WorkspaceDescriptor {
  const result = record(value, "WorkspaceOpen");
  exact(result, ["name", "root", "features", "git"], "WorkspaceOpen");
  const features = record(result.features, "WorkspaceOpen.features");
  exact(features, ["files", "git_status", "git_diff", "git_branches"], "WorkspaceOpen.features");
  let git: WorkspaceRepository | null = null;
  if (result.git !== null) {
    const raw = record(result.git, "WorkspaceOpen.git");
    exact(raw, ["name", "branch", "head", "detached"], "WorkspaceOpen.git");
    git = {
      name: safeText(raw.name, "WorkspaceOpen.git.name", 4096, false),
      branch: nullableText(raw.branch, "WorkspaceOpen.git.branch", 512),
      head: safeText(raw.head, "WorkspaceOpen.git.head", 128),
      detached: bool(raw.detached, "WorkspaceOpen.git.detached"),
    };
  }
  return {
    name: safeText(result.name, "WorkspaceOpen.name", 4096, false),
    root: safeText(result.root, "WorkspaceOpen.root", 4096, false),
    features: {
      files: bool(features.files, "WorkspaceOpen.features.files"),
      git_status: bool(features.git_status, "WorkspaceOpen.features.git_status"),
      git_diff: bool(features.git_diff, "WorkspaceOpen.features.git_diff"),
      git_branches: bool(features.git_branches, "WorkspaceOpen.features.git_branches"),
    },
    git,
  };
}

function parseEntry(value: unknown): WorkspaceEntry {
  const item = record(value, "WorkspaceList entry");
  exact(item, ["name", "path", "kind", "size", "modified_ms", "hidden"], "WorkspaceList entry");
  const kind = text(item.kind, "WorkspaceList.kind", 16, false);
  if (kind !== "directory" && kind !== "file" && kind !== "symlink" && kind !== "other") invalid("WorkspaceList.kind");
  return {
    name: safeText(item.name, "WorkspaceList.name", 4096, false),
    path: relative(item.path, "WorkspaceList.path"),
    kind,
    size: integer(item.size, "WorkspaceList.size"),
    modified_ms: integer(item.modified_ms, "WorkspaceList.modified_ms", -8_640_000_000_000_000),
    hidden: bool(item.hidden, "WorkspaceList.hidden"),
  };
}

export function parseWorkspaceDirectory(value: unknown): WorkspaceDirectoryPage {
  const result = record(value, "WorkspaceList");
  exact(result, ["path", "entries", "next_cursor", "truncated", "revision"], "WorkspaceList");
  if (!Array.isArray(result.entries) || result.entries.length > 240) invalid("WorkspaceList.entries");
  return {
    path: relative(result.path, "WorkspaceList.path", true),
    entries: result.entries.map(parseEntry),
    next_cursor: result.next_cursor === null ? null : text(result.next_cursor, "WorkspaceList.next_cursor", 32, false),
    truncated: bool(result.truncated, "WorkspaceList.truncated"),
    revision: revision(result.revision, "WorkspaceList.revision"),
  };
}

export function parseWorkspaceFile(value: unknown): WorkspaceFile {
  const result = record(value, "WorkspaceRead");
  exact(result, ["path", "kind", "size", "modified_ms", "content", "truncated", "revision"], "WorkspaceRead");
  const kind = text(result.kind, "WorkspaceRead.kind", 16, false);
  if (kind !== "text" && kind !== "binary") invalid("WorkspaceRead.kind");
  return {
    path: relative(result.path, "WorkspaceRead.path"),
    kind,
    size: integer(result.size, "WorkspaceRead.size"),
    modified_ms: integer(result.modified_ms, "WorkspaceRead.modified_ms", -8_640_000_000_000_000),
    content: text(result.content, "WorkspaceRead.content", 131072),
    truncated: bool(result.truncated, "WorkspaceRead.truncated"),
    revision: revision(result.revision, "WorkspaceRead.revision"),
  };
}

function parseChange(value: unknown): GitChange {
  const item = record(value, "GitStatus change");
  exact(item, ["path", "original_path", "index", "worktree"], "GitStatus change");
  const index = safeText(item.index, "GitStatus.index", 1, false);
  const worktree = safeText(item.worktree, "GitStatus.worktree", 1, false);
  if (!/^[ MTADRCU?!]$/u.test(index) || !/^[ MTADRCU?!]$/u.test(worktree)) invalid("GitStatus change code");
  return {
    path: relative(item.path, "GitStatus.path"),
    original_path: item.original_path === null ? null : relative(item.original_path, "GitStatus.original_path"),
    index,
    worktree,
  };
}

export function parseGitStatus(value: unknown): GitStatus {
  const result = record(value, "GitStatus");
  exact(result, ["branch", "head", "upstream", "ahead", "behind", "changes", "truncated", "revision"], "GitStatus");
  if (!Array.isArray(result.changes) || result.changes.length > 1200) invalid("GitStatus.changes");
  return {
    branch: nullableText(result.branch, "GitStatus.branch", 512),
    head: safeText(result.head, "GitStatus.head", 128),
    upstream: nullableText(result.upstream, "GitStatus.upstream", 512),
    ahead: integer(result.ahead, "GitStatus.ahead"),
    behind: integer(result.behind, "GitStatus.behind"),
    changes: result.changes.map(parseChange),
    truncated: bool(result.truncated, "GitStatus.truncated"),
    revision: revision(result.revision, "GitStatus.revision"),
  };
}

export function parseGitDiff(value: unknown): GitDiff {
  const result = record(value, "GitDiff");
  exact(result, ["path", "layer", "patch", "additions", "deletions", "binary", "truncated", "revision"], "GitDiff");
  const layer = text(result.layer, "GitDiff.layer", 16, false);
  if (layer !== "worktree" && layer !== "staged") invalid("GitDiff.layer");
  return {
    path: relative(result.path, "GitDiff.path"),
    layer,
    patch: text(result.patch, "GitDiff.patch", 184320),
    additions: integer(result.additions, "GitDiff.additions"),
    deletions: integer(result.deletions, "GitDiff.deletions"),
    binary: bool(result.binary, "GitDiff.binary"),
    truncated: bool(result.truncated, "GitDiff.truncated"),
    revision: revision(result.revision, "GitDiff.revision"),
  };
}

export function parseGitBranches(value: unknown): GitBranches {
  const result = record(value, "GitBranches");
  exact(result, ["items", "truncated", "revision"], "GitBranches");
  if (!Array.isArray(result.items) || result.items.length > 400) invalid("GitBranches.items");
  return {
    items: result.items.map((value) => {
      const item = record(value, "GitBranches item");
      exact(item, ["name", "kind", "current", "head", "upstream"], "GitBranches item");
      const kind = text(item.kind, "GitBranches.kind", 16, false);
      if (kind !== "local" && kind !== "remote") invalid("GitBranches.kind");
      return {
        name: safeText(item.name, "GitBranches.name", 512, false),
        kind,
        current: bool(item.current, "GitBranches.current"),
        head: safeText(item.head, "GitBranches.head", 128),
        upstream: nullableText(item.upstream, "GitBranches.upstream", 512),
      };
    }),
    truncated: bool(result.truncated, "GitBranches.truncated"),
    revision: revision(result.revision, "GitBranches.revision"),
  };
}

export function gitLayers(change: GitChange): GitLayer[] {
  const layers: GitLayer[] = [];
  if (change.index !== " " && change.index !== "?") layers.push("staged");
  if (change.worktree !== " " || change.index === "?") layers.push("worktree");
  return layers;
}

export function gitChangeKind(change: GitChange, layer: GitLayer): GitChangeKind {
  const code = layer === "staged" ? change.index : change.index === "?" ? "?" : change.worktree;
  if (code === "?") return "untracked";
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  if (code === "U") return "conflict";
  if (code === "T") return "type";
  return "modified";
}

export type DiffLine = { kind: "meta" | "hunk" | "add" | "delete" | "context"; text: string; oldLine: number | null; newLine: number | null };

export function parseDiffLines(patch: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  if (!patch) return [];
  const lines = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");
  return lines.map((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: "hunk", text: line, oldLine: null, newLine: null };
    }
    if (line.startsWith("+") && !line.startsWith("+++")) return { kind: "add", text: line.slice(1), oldLine: null, newLine: newLine++ };
    if (line.startsWith("-") && !line.startsWith("---")) return { kind: "delete", text: line.slice(1), oldLine: oldLine++, newLine: null };
    if (line.startsWith(" ")) return { kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ };
    return { kind: "meta", text: line, oldLine: null, newLine: null };
  });
}

export function workspaceBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  const result = [{ label: "root", path: "" }];
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    result.push({ label: part, path: current });
  }
  return result;
}
