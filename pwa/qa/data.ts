import type { SnapshotWire } from "../src/lib/dashboard";
import type { AgentQuota } from "../src/lib/agent-quota";
import type { AgentTraceItem } from "../src/lib/operations";
import type { PairResult } from "../src/lib/protocol/client";
import type { DeviceSummary } from "../src/lib/protocol/session-types";
import type { GitDiff, GitStatus, WorkspaceDescriptor, WorkspaceDirectoryPage, WorkspaceFile } from "../src/lib/workspace";
import {
  MEDIA_CHUNK_BYTES,
  MEDIA_IMAGE_MAX_BYTES,
  MEDIA_MAX_BYTES,
  MEDIA_MAX_PIXELS,
  type WorkspaceMediaChunk,
  type WorkspaceMediaKind,
  type WorkspaceMediaOpen,
} from "../src/lib/protocol/workspace-media";
import { FIXED_NOW } from "./environment";

export const REVISION = "a".repeat(64);
export const PANE = "w1:p1";

const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
  0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const TINY_PNG_SHA = "d6ad79754ddf8117ef07ae148ac239cf61d9ff537511a2b6f86e5d5b8de08d6b";
const MEDIA_HANDLE = "media_" + "a".repeat(32);
export const ROOT = "/work/pairfob";
export const PANE_TEXT = [
  "\u001b[1;36mPairfob\u001b[0m  ·  workspace /work/pairfob",
  "",
  "\u001b[32m✓\u001b[0m Loaded 8 files in 42 ms",
  "\u001b[32m✓\u001b[0m TypeScript checks passed",
  "",
  "\u001b[1mChanges\u001b[0m",
  "  src/app.ts       +12 -4",
  "  src/styles.scss   +8 -2",
  "",
  "All checks passed. Ready for the next step.",
  "",
  "❯ ",
].join("\n");

export function computers(): PairResult[] {
  return [
    { daemonId: "d_aaaaaaaaaaaaaaaaaaaa", deviceId: "dev_aaaaaaaaaaaa", hostname: "MacBook Pro", label: "This phone", lastSeen: FIXED_NOW - 60000 },
    { daemonId: "d_bbbbbbbbbbbbbbbbbbbb", deviceId: "dev_bbbbbbbbbbbb", hostname: "Studio Mac", label: "This phone", lastSeen: FIXED_NOW - 3600000 },
    { daemonId: "d_cccccccccccccccccccc", deviceId: "dev_cccccccccccc", hostname: "Linux workstation", label: "This phone", lastSeen: FIXED_NOW - 86400000 },
  ].map((item) => ({ ...item, psk: new Uint8Array(32), daemonPk: new Uint8Array(32), relayOrigin: location.origin,
    fp: "0123456789abcdef", createdAt: FIXED_NOW - 7 * 86400000 }));
}

export function snapshot(): SnapshotWire {
  return {
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: PANE },
    workspaces: [{ workspace_id: "w1", label: "pairfob", cwd: ROOT }, { workspace_id: "w2", label: "dashboard", cwd: "/work/dashboard" }],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "implementation" },
      { tab_id: "w1:t2", workspace_id: "w1", label: "tests" },
      { tab_id: "w2:t1", workspace_id: "w2", label: "review" },
    ],
    panes: [
      { pane_id: PANE, workspace_id: "w1", tab_id: "w1:t1", cwd: ROOT, agent: "codex", agent_status: "working", label: "React migration", history_available: true, scroll: { viewport_rows: 28 } },
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", cwd: ROOT, agent: "claude", agent_status: "blocked", label: "Review interactions", history_available: true },
      { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2", cwd: ROOT, agent: "grok", agent_status: "done", label: "Validate types", history_available: true },
      { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", cwd: "/work/dashboard", agent: "pi", agent_status: "idle", label: "Mobile layout", history_available: true },
      { pane_id: "w2:p2", workspace_id: "w2", tab_id: "w2:t1", cwd: "/work/dashboard", agent: "", label: "Development server" },
    ],
    layouts: [{ workspace_id: "w1", tab_id: "w1:t1", zoomed: false, focused_pane_id: PANE,
      area: { x: 0, y: 0, width: 100, height: 40 }, panes: [
        { pane_id: PANE, focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
        { pane_id: "w1:p2", focused: false, rect: { x: 60, y: 0, width: 40, height: 40 } },
      ] }],
  };
}

export function devices(): DeviceSummary[] {
  const sec = Math.floor(FIXED_NOW / 1000);
  return [
    { device_id: "dev_aaaaaaaaaaaa", label: "iPhone 16", self: true, connected: true, created_at: sec - 604800, last_seen: sec - 30 },
    { device_id: "dev_bbbbbbbbbbbb", label: "iPad mini", connected: false, created_at: sec - 864000, last_seen: sec - 7200 },
    { device_id: "dev_cccccccccccc", label: "Old phone", connected: false, created_at: sec - 864000, last_seen: sec - 86400, revoked_at: sec - 3600 },
  ];
}

export function quotas(): AgentQuota[] {
  const sec = Math.floor(FIXED_NOW / 1000);
  return [
    { provider: "codex", plan: "Pro", status: "ok", source: "app_server", observed_at: sec - 30,
      windows: [{ name: "five_hour", used_percent: 28, window_minutes: 300, resets_at: sec + 7200 }, { name: "seven_day", used_percent: 54, window_minutes: 10080, resets_at: sec + 345600 }] },
    { provider: "claude", plan: "Max", status: "ok", source: "statusline", observed_at: sec - 60,
      windows: [{ name: "five_hour", used_percent: 61, window_minutes: 300, resets_at: sec + 10800 }] },
    { provider: "copilot", plan: "Pro", status: "ok", source: "github_api", observed_at: sec - 20,
      windows: [{ name: "premium interactions", used_percent: 0, window_minutes: 43200, resets_at: 0, unlimited: true }] },
    { provider: "cursor", plan: "Pro", status: "stale", source: "web_api", observed_at: sec - 3600,
      windows: [{ name: "Included plan", used_percent: 45, window_minutes: 43200, resets_at: sec + 864000 }] },
    { provider: "antigravity", plan: "", status: "not_running", source: "local_api", observed_at: 0, windows: [] },
    { provider: "grok", plan: "", status: "auth_required", source: "oauth", observed_at: 0, windows: [] },
  ];
}

export function trace(): AgentTraceItem[] {
  return [
    { type: "user", text: "Check the mobile workspace layout and preserve the existing interactions." },
    { type: "thinking", text: "I will inspect the component boundaries, focus ownership, and responsive styles." },
    { type: "tool", name: "Read", input: '{"path":"src/app.ts"}', output: "Read 48 lines. The current layout uses a stable compose field." },
    { type: "assistant", text: "The layout is ready.\n\n- Preserved the keyboard and selection.\n- Kept **all existing controls** available.\n\n```ts\nexport const ready = true;\n```\n\n[Read the project](https://pairfob.com)" },
    { type: "user", text: "Please also check the narrow phone view." },
    { type: "thinking", text: "Checking the 320 px layout, button targets, and horizontal overflow." },
    { type: "tool", name: "Browser", text: "Inspecting the viewport and touch targets." },
  ];
}

export function descriptor(): WorkspaceDescriptor {
  return { name: "pairfob", root: ROOT, features: { files: true, git_status: true, git_diff: true, git_branches: true },
    git: { name: "pairfob", branch: "main", head: "1234567890abcdef", detached: false } };
}

export function directory(path = ""): WorkspaceDirectoryPage {
  const modified = FIXED_NOW - 3600000;
  const file = (name: string, parent = path, size = 284) => ({ name, path: parent ? `${parent}/${name}` : name,
    kind: "file" as const, size, modified_ms: modified, hidden: name.startsWith("."), revision: REVISION });
  const dir = (name: string, parent = path) => ({
    name, path: parent ? `${parent}/${name}` : name, kind: "directory" as const, size: 0, modified_ms: modified, hidden: false,
  });
  // Extension-name/list samples for file-icon mapping (no media RPC fixtures:
  // these are directory entries only, with no binary content).
  const nested = path === "src"
    ? [
      file("app.ts"), file("app.tsx", path, 512), file("index.js", path, 196), file("styles.scss", path, 1840),
      file("types.ts", path, 312), file("main.go", path, 890), file("util.py", path, 220), file("lib.rs", path, 740),
      file("schema.proto", path, 640), file("query.sql", path, 410), file("App.vue", path, 380), file("Widget.svelte", path, 290),
    ]
    : path === "public"
      ? [file("logo.svg", path, 812), file("index.html", path, 420), file("app.css", path, 160), file("notes.txt", path, 88)]
      : path
        ? [file("app.ts"), file("styles.scss", path, 1840), file("types.ts", path, 312)]
        : [
          dir("src"), dir("public"), dir("proto"), dir("workers"),
          file("README.md", "", 1485), file("package.json", "", 946), file("go.mod", "", 180),
          file("Dockerfile", "", 420), file(".gitignore", "", 64), file("wrangler.toml", "", 310),
          file("LICENSE", "", 1080), file("Makefile", "", 220), file(".env.local", "", 96),
          file("yarn.lock", "", 1800), file("tsconfig.json", "", 540),
        ];
  return { path, entries: nested, next_cursor: null, truncated: false, revision: REVISION };
}

export function file(path = "src/app.ts"): WorkspaceFile {
  const content = 'import { createRoot } from "react-dom/client";\n\nexport function App() {\n  return <main className="workspace">Ready</main>;\n}\n\ncreateRoot(document.getElementById("app")!).render(<App />);\n';
  return { path, kind: "text", size: new TextEncoder().encode(content).length, modified_ms: FIXED_NOW - 3600000,
    content, truncated: false, revision: REVISION };
}

export function mediaOpen(path: string): WorkspaceMediaOpen {
  const kind: WorkspaceMediaKind = /\.(png|jpe?g|gif|webp)$/i.test(path) ? "image"
    : /\.(mp4|webm|mov|m4v|ogv)$/i.test(path) ? "video"
    : /\.(mp3|wav|ogg|oga|m4a|aac|flac|weba)$/i.test(path) ? "audio"
    : "download";
  const mime = kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg"
    : path.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
  return {
    handle: MEDIA_HANDLE, path, kind, mime, size: TINY_PNG.length, modified_ms: FIXED_NOW - 3600000, sha256: TINY_PNG_SHA,
    expires_ms: FIXED_NOW + 60_000, chunk_bytes: MEDIA_CHUNK_BYTES,
    max_bytes: kind === "image" ? MEDIA_IMAGE_MAX_BYTES : MEDIA_MAX_BYTES,
    max_pixels: MEDIA_MAX_PIXELS, width: kind === "image" ? 1 : 0, height: kind === "image" ? 1 : 0,
  };
}

export function mediaChunk(handle: string, offset: number, length: number): WorkspaceMediaChunk {
  const bytes = TINY_PNG.subarray(offset, offset + length);
  return { handle, offset, length: bytes.length, bytes, eof: offset + bytes.length >= TINY_PNG.length };
}

export function status(): GitStatus {
  return { branch: "main", head: "1234567890abcdef", upstream: "origin/main", ahead: 1, behind: 0,
    truncated: false, revision: REVISION, changes: [
      { path: "src/app.ts", original_path: null, index: "M", worktree: "M" },
      { path: "src/styles.scss", original_path: null, index: " ", worktree: "M" },
      { path: "README.md", original_path: null, index: "A", worktree: " " },
    ] };
}

export function diff(path = "src/app.ts", layer: "staged" | "worktree" = "worktree"): GitDiff {
  return { path, layer, patch: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,4 +1,6 @@\n import { createRoot } from "react-dom/client";\n \n-export const ready = false;\n+export function App() {\n+  return <main className="workspace">Ready</main>;\n+}\n ', additions: 3, deletions: 1,
    binary: false, truncated: false, revision: REVISION };
}
