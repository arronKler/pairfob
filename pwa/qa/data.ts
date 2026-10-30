import type { SnapshotWire } from "../src/lib/dashboard";
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
import { CODEX_APPROVAL_SCREEN, GROK_QUESTION_SCREEN, PI_SELECTOR_SCREEN } from "../src/lib/terminal-dialog.fixtures";
import { WIDE_PNG, WIDE_PNG_HEIGHT, WIDE_PNG_PATH, WIDE_PNG_SHA, WIDE_PNG_WIDTH } from "./wide-image";

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
const WIDE_HANDLE = "media_" + "b".repeat(32);
/** The image a path names: the large one by its own path, the single pixel for every other. */
const imageAt = (path: string) => path === WIDE_PNG_PATH
  ? { bytes: WIDE_PNG, sha: WIDE_PNG_SHA, handle: WIDE_HANDLE, width: WIDE_PNG_WIDTH, height: WIDE_PNG_HEIGHT }
  : { bytes: TINY_PNG, sha: TINY_PNG_SHA, handle: MEDIA_HANDLE, width: 1, height: 1 };
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
      { pane_id: PANE, workspace_id: "w1", tab_id: "w1:t1", cwd: ROOT, agent: "codex", agent_status: "working", label: "React migration", history_available: true, scroll: { viewport_rows: 28 },
        activity: { type: "tool", name: "apply_patch", label: "src/features/session/chat/agent-chat.tsx", state: "running", at: Date.now() - 20_000 } },
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", cwd: ROOT, agent: "claude", agent_status: "blocked", label: "Review interactions", history_available: true,
        activity: { type: "tool", name: "Bash", label: "bun test src/features", state: "running", at: Date.now() - 90_000 } },
      { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2", cwd: ROOT, agent: "grok", agent_status: "done", label: "Validate types", history_available: true,
        activity: { type: "assistant", at: Date.now() - 4 * 60_000, turn: { steps: 14, files: 3 } } },
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

export function attentionSnapshot(updated = false): SnapshotWire {
  const base = snapshot();
  const seed = base.panes?.[0]!;
  const facts = [
    ["attention-blocked", "blocked", false, true, 31],
    ["attention-done-old", "done", false, true, 40],
    ["attention-done-new", "done", false, true, updated ? 99 : 80],
    ["attention-working", "working", false, true, 50],
    ["attention-launching", "idle", true, false, 60],
    ["attention-not-ready", "idle", false, false, 61],
    ["attention-unknown", "unknown", false, undefined, 62],
    ["attention-ready", "idle", false, true, 63],
  ] as const;
  return { ...base, panes: facts.map(([paneId, status, launchPending, interactiveReady, sequence], index) => ({
    ...seed,
    pane_id: paneId,
    label: paneId.replace("attention-", ""),
    agent: "pi",
    agent_status: status,
    terminal_id: `terminal-${index}`,
    agent_instance_id: updated && paneId === "attention-ready" ? "agent-ready-replaced" : `agent-${index}`,
    revision: (updated ? 40 : 20) + index,
    state_change_seq: sequence,
    interactive_ready: interactiveReady,
    launch_pending: launchPending,
  })) };
}

export function devices(): DeviceSummary[] {
  const sec = Math.floor(FIXED_NOW / 1000);
  return [
    { device_id: "dev_aaaaaaaaaaaa", label: "iPhone 16", self: true, connected: true, created_at: sec - 604800, last_seen: sec - 30 },
    { device_id: "dev_bbbbbbbbbbbb", label: "iPad mini", connected: false, created_at: sec - 864000, last_seen: sec - 7200 },
    { device_id: "dev_cccccccccccc", label: "Old phone", connected: false, created_at: sec - 864000, last_seen: sec - 86400, revoked_at: sec - 3600 },
  ];
}

export function phase2ConversationTrace(): AgentTraceItem[] {
  const turns: AgentTraceItem[] = [];
  for (let turn = 1; turn <= 12; turn++) {
    turns.push(
      { type: "user", text: `Turn ${turn}: inspect the conversation recovery path without replaying any mutation.` },
      { type: "thinking", text: `Checking owner generation, scroll position, and transcript tail for turn ${turn}.` },
      { type: "tool", name: "Read", input: `{"path":"src/chat/turn-${turn}.ts"}`, output: `Read ${20 + turn} lines. Owner and revision are stable.`, toolState: "done", detailRef: `qa-read-${turn}`, label: `src/chat/turn-${turn}.ts` },
    );
    if (turn === 4) turns.push({ type: "tool", name: "Bash", input: "bun test chat", output: "error: expected one refresh, received zero", toolState: "error", detailRef: "qa-tool-error", label: "bun test chat" });
    if (turn === 7) turns.push({ type: "tool", name: "Read", input: "{\"path\":\"empty.txt\"}", output: "", toolState: "done", detailRef: "qa-empty-output", label: "empty.txt" });
    turns.push({ type: "assistant", text: `Turn ${turn} complete. The transcript remains attached to the same Pi session${turn === 12 ? ".\n\nFinal check: foreground recovery refreshes reads only and does not resend the prompt." : "."}` });
  }
  return turns;
}

const TURN_START = FIXED_NOW - 600_000;

/** A real Codex approval prompt (captured from v0.159.2) as the pane shows it while the agent waits. */
export const NEEDS_YOU_SCREEN = CODEX_APPROVAL_SCREEN;

/** A turn paused on that prompt: the pending tool is the command it wants to run. */
export function needsYouTrace(): AgentTraceItem[] {
  return [
    { type: "user", text: "Create an empty file named hello.txt in this folder with the shell command touch hello.txt" },
    { type: "tool", name: "exec_command", label: "touch hello.txt", toolState: "running", detailRef: "qa-needs-touch" },
  ];
}

/** A real Grok question (captured from Grok Build 1.0.62): no cursor in the text, the digit answers. */
export const GROK_NEEDS_YOU_SCREEN = GROK_QUESTION_SCREEN;

/** Grok stopped to ask before taking any step. */
export function grokNeedsYouTrace(): AgentTraceItem[] {
  return [{ type: "user", text: "Ask me which color to use, then wait." }];
}

/** A real Pi extension dialog (captured from Pi 1.3.0): the cursor row is "→", the arrows answer it. */
export const PI_NEEDS_YOU_SCREEN = PI_SELECTOR_SCREEN;

/** Pi stopped on an extension dialog. */
export function piNeedsYouTrace(): AgentTraceItem[] {
  return [{ type: "user", text: "Ask before running the dangerous command, then wait." }];
}

/** Opt-in trace markers (proto/agent-trace-markers.md) around ordinary turns. */
export function markerTrace(): AgentTraceItem[] {
  return [
    { type: "command", text: "/clear" },
    { type: "user", text: "Why does the PWA jump to the pairing screen after Chrome resumes?" },
    { type: "thinking", text: "Tracing boot recovery and stored credential reads." },
    { type: "tool", name: "Read", input: '{"path":"src/app/bootstrap.ts"}', output: "Read 120 lines.", toolState: "done", detailRef: "qa-marker-read", label: "pwa/src/app/bootstrap.ts" },
    { type: "compaction" },
    { type: "assistant", text: "Boot treats a transient storage failure as **no saved computers**." },
    { type: "user", text: "Rewrite the whole boot flow." },
    { type: "tool", name: "Bash", input: "bun test src/app", toolState: "running", detailRef: "qa-marker-bash", label: "bun test src/app" },
    { type: "interrupt" },
    { type: "command", text: "/model opus" },
  ];
}

/**
 * Codex-shaped steps: a failed step the agent worked past, write_stdin reads of a
 * running command (direct and inside a code-mode snippet), then a turn that
 * stopped on a failed step with no reply.
 */
export function stepsTrace(): AgentTraceItem[] {
  return [
    { type: "user", text: "Check the latest usage numbers." },
    { type: "assistant", text: "I will refresh the production stats and compare them with the last run." },
    { type: "tool", name: "exec", input: "text(await tools.exec_command({cmd:\"cat /tmp/usage.ts\"}))", output: "export const query = 1;", toolState: "done", detailRef: "qa-steps-cat", label: "cat /tmp/usage.ts +1" },
    { type: "tool", name: "exec", input: "text(await tools.write_stdin({session_id:7,chars:\"\"}))", output: "write_stdin failed: session 7 has exited", toolState: "error", detailRef: "qa-steps-read-failed", label: "write_stdin" },
    { type: "tool", name: "exec", input: "text(await tools.exec_command({cmd:\"bun /tmp/usage.ts\"}))", output: "installs 385", toolState: "done", detailRef: "qa-steps-run", label: "bun /tmp/usage.ts +1" },
    { type: "tool", name: "exec", input: "text(await tools.write_stdin({session_id:8,chars:\"\"}))", output: "active 191", toolState: "done", detailRef: "qa-steps-read-code", label: "write_stdin +1" },
    { type: "tool", name: "write_stdin", output: "done", toolState: "done", detailRef: "qa-steps-read" },
    { type: "assistant", text: "Installs are at **385**, unchanged since the last run." },
    { type: "user", text: "Run the release build." },
    { type: "tool", name: "exec_command", input: '{"cmd":"bun test"}', output: "12 pass", toolState: "done", detailRef: "qa-steps-test", label: "bun test" },
    { type: "tool", name: "exec_command", input: '{"cmd":"bun run build"}', output: "error: out of memory", toolState: "error", detailRef: "qa-steps-build", label: "bun run build" },
  ];
}

/**
 * A finding the agent spoke between its steps: a block of prose with a heading,
 * a list and a link, so the transcript shows the shape that a press wrapping the
 * whole block would flatten.
 */
export function findingTrace(): AgentTraceItem[] {
  return [
    { type: "user", text: "Audit the chat composer for missing labels." },
    { type: "tool", name: "Read", input: '{"path":"pwa/src/features/session/chat/agent-compose.tsx"}', output: "Read 232 lines.", toolState: "done", detailRef: "qa-finding-read", label: "pwa/src/features/session/chat/agent-compose.tsx" },
    { type: "assistant", text: "## Two gaps in the composer\n\nThe field carries a placeholder and no name, so a reader is told **an unnamed text box**.\n\n- `aria-label` is missing\n- the hint line is not described by the field\n\nSee [the form rules](https://pairfob.com/doc/app) for the contract." },
    { type: "tool", name: "Grep", input: '{"pattern":"aria-label"}', output: "3 matches", toolState: "done", detailRef: "qa-finding-grep", label: "aria-label" },
    { type: "assistant", text: "Fixed both." },
  ];
}

export function trace(): AgentTraceItem[] {
  return [
    // The finished turn carries record times (trace_times); the live one below does not.
    { type: "user", text: "Check the mobile workspace layout and preserve the existing interactions.", at: TURN_START },
    { type: "thinking", text: "I will inspect the component boundaries, focus ownership, and responsive styles.", at: TURN_START + 2_000 },
    { type: "tool", name: "Read", input: '{"path":"src/app.ts"}', output: "Read 48 lines. The current layout uses a stable compose field.", label: "src/app.ts", at: TURN_START + 9_000 },
    { type: "assistant", at: TURN_START + 72_000, text: "The layout is ready.\n\n- Preserved the keyboard and selection.\n- Kept **all existing controls** available.\n\n```ts\nexport const ready = true;\n```\n\n[Read the project](https://pairfob.com)" },
    { type: "user", text: "Please also check the narrow phone view." },
    { type: "thinking", text: "Checking the 320 px layout, button targets, and horizontal overflow." },
    { type: "tool", name: "Browser", text: "Inspecting the viewport and touch targets.", label: "localhost:5173 · 320px" },
  ];
}

/**
 * The finished turn of `trace()`, its reply carrying the three shapes a code
 * block takes: one short line, one line longer than any column, and several
 * lines. `chat-complete` shows it; the other chat scenes keep `trace()`.
 */
export function completeTrace(): AgentTraceItem[] {
  const turn = trace().slice(0, 4);
  const reply = turn[3]!;
  const long = "PAIRFOB_ALLOWED_ROOTS=/work/pairfob:/work/dashboard pairfob daemon --origin https://pairfob.com --log-level debug --no-color";
  const several = "git switch -c layout/phone\nbun run typecheck\nbun test src/app src/features/session";
  turn[3] = { ...reply, text: `${reply.text}\n\nStart the daemon with both roots:\n\n\`\`\`sh\n${long}\n\`\`\`\n\nThen check it:\n\n\`\`\`sh\n${several}\n\`\`\`` };
  return turn;
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
      ? [file("logo.svg", path, 812), file("pixel.png", path, TINY_PNG.length), file("wide.png", path, WIDE_PNG.length), file("index.html", path, 420), file("report.html", path, 640), file("app.css", path, 160),
        file("notes.txt", path, 88)]
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

/** A README's shapes: headings, a list, a table, a fence, a quote, and file references. */
const README_MARKDOWN = [
  "# Pairfob",
  "",
  "Pair the phone with the computer that runs your agents. **No open port**, no",
  "SSH, no tunnel to configure.",
  "",
  "## Quick start",
  "",
  "1. Install the daemon on the computer.",
  "2. Scan the pairing code with this phone.",
  "3. Pick a pane and keep working.",
  "",
  "| Surface | Layout |",
  "| --- | --- |",
  "| Phone | One screen, tabs at the bottom |",
  "| Desktop | List, session and files side by side |",
  "",
  "```sh",
  "pairfob daemon --origin https://pairfob.com",
  "```",
  "",
  "> The relay only forwards encrypted frames; identity and keys stay on the computer.",
  "",
  "The mux routes frames in `internal/mux/hub.go`, and the browser handshake lives",
  "in `pwa/src/lib/protocol/client.ts`.",
  "",
].join("\n");

const APP_SOURCE = 'import { createRoot } from "react-dom/client";\n\nexport function App() {\n  return <main className="workspace">Ready</main>;\n}\n\ncreateRoot(document.getElementById("app")!).render(<App />);\n';

export function file(path = "src/app.ts"): WorkspaceFile {
  // An image is read as bytes through the media calls; the file read only says that it is one.
  if (/\.(png|jpe?g|gif|webp)$/i.test(path)) {
    return { path, kind: "binary", size: imageAt(path).bytes.length, modified_ms: FIXED_NOW - 3600000, content: "", truncated: false, revision: REVISION };
  }
  const content = /\.(md|markdown)$/i.test(path) ? README_MARKDOWN : APP_SOURCE;
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
  const image = imageAt(path);
  return {
    handle: image.handle, path, kind, mime, size: image.bytes.length, modified_ms: FIXED_NOW - 3600000, sha256: image.sha,
    expires_ms: FIXED_NOW + 60_000, chunk_bytes: MEDIA_CHUNK_BYTES,
    max_bytes: kind === "image" ? MEDIA_IMAGE_MAX_BYTES : MEDIA_MAX_BYTES,
    max_pixels: MEDIA_MAX_PIXELS, width: kind === "image" ? image.width : 0, height: kind === "image" ? image.height : 0,
  };
}

export function mediaChunk(handle: string, offset: number, length: number): WorkspaceMediaChunk {
  const all = handle === WIDE_HANDLE ? WIDE_PNG : TINY_PNG;
  const bytes = all.subarray(offset, offset + length);
  return { handle, offset, length: bytes.length, bytes, eof: offset + bytes.length >= all.length };
}

export function status(): GitStatus {
  return { branch: "main", head: "1234567890abcdef", upstream: "origin/main", ahead: 1, behind: 0,
    truncated: false, revision: REVISION, changes: [
      // As a daemon with git_change_stats answers: each layer's line counts and when the file last changed.
      { path: "src/app.ts", original_path: null, index: "M", worktree: "M",
        stat: { staged: { additions: 4, deletions: 2 }, worktree: { additions: 4, deletions: 2 } }, modified_ms: FIXED_NOW - 2 * 60_000 },
      { path: "src/styles.scss", original_path: null, index: " ", worktree: "M",
        stat: { worktree: { additions: 8, deletions: 2 } }, modified_ms: FIXED_NOW - 5 * 60_000 },
      { path: "README.md", original_path: null, index: "A", worktree: " ",
        stat: { staged: { additions: 12, deletions: 0 } }, modified_ms: FIXED_NOW - 3 * 3_600_000 },
    ] };
}

/**
 * A working tree with more changes than a list is read through at a glance:
 * the usual three first, as every other scene has them, then a dozen more
 * files changed on disk. Sixteen diffs in all, past the number from which the
 * column's file switcher offers its filter.
 */
export function manyStatus(): GitStatus {
  const base = status();
  const more = ["api/client.ts", "api/routes.ts", "api/schema.ts", "lib/cache.ts", "lib/dates.ts", "lib/format.ts",
    "ui/button.tsx", "ui/dialog.tsx", "ui/list.tsx", "ui/menu.tsx", "ui/sheet.tsx", "ui/tabs.tsx"];
  return { ...base, revision: "b".repeat(64), changes: [...base.changes, ...more.map((name, index) => ({
    path: `src/${name}`, original_path: null, index: " ", worktree: "M",
    stat: { worktree: { additions: 3 + index, deletions: index % 4 } }, modified_ms: FIXED_NOW - (10 + index) * 60_000,
  }))] };
}

/** Every file the fixture workspace lists, for a search by name. */
export function searchFiles(query: string, limit = 30): { query: string; items: { path: string; name: string }[]; truncated: boolean } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const all = ["", "src", "public"].flatMap((folder) => directory(folder).entries.filter((entry) => entry.kind === "file").map((entry) => entry.path));
  const matches = words.length ? all.filter((path) => words.every((word) => path.toLowerCase().includes(word))) : [];
  return { query, items: matches.slice(0, limit).map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) })), truncated: matches.length > limit };
}

/** What the agent's edit tools wrote in its current turn, as they named the files. */
export function turnWrites(): string[] {
  return [`${ROOT}/src/app.ts`, "src/styles.scss"];
}

/**
 * A patch deep in a long file (`workspace-diff-long`): five-digit line numbers, lines wider
 * than a phone, and enough of them to scroll, for the gutter, wrapping and the reading size.
 */
export const LONG_DIFF_PATH = "src/server.ts";

function longPatch(): string {
  const head = ["diff --git a/src/server.ts b/src/server.ts", "--- a/src/server.ts", "+++ b/src/server.ts"];
  const hunk = (start: number, label: string) => {
    const lines = [`@@ -${start},40 +${start},42 @@ ${label}`];
    for (let index = 0; index < 40; index++) {
      const at = start + index;
      const wide = `  const route${at} = router.register("/api/v2/workspaces/:workspace/sessions/:session/files/${at}", { method: "GET", cache: "no-store", timeoutMs: ${at} });`;
      if (index % 9 === 4) lines.push(`-${wide}`, `+${wide.replace("GET", "POST")}`);
      else if (index % 13 === 7) lines.push(`+  // ${at}: keep the handler beside its route so a reader finds both on one screen.`, ` ${wide}`);
      else lines.push(` ${index % 3 ? wide : `  handle(${at});`}`);
    }
    return lines;
  };
  return [...head, ...hunk(9978, "function routes(router: Router) {"), ...hunk(10_140, "function more(router: Router) {"), ""].join("\n");
}

export function diff(path = "src/app.ts", layer: "staged" | "worktree" = "worktree"): GitDiff {
  if (path === LONG_DIFF_PATH) return { path, layer, patch: longPatch(), additions: 12, deletions: 10, binary: false, truncated: false, revision: REVISION };
  return { path, layer, patch: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,4 +1,6 @@\n import { createRoot } from "react-dom/client";\n \n-export const ready = false;\n+export function App() {\n+  return <main className="workspace">Ready</main>;\n+}\n \n@@ -24,3 +26,3 @@ function mount(root: HTMLElement) {\n   const app = createRoot(root);\n-  app.render(<App />);\n+  app.render(<App ready />);\n }\n', additions: 4, deletions: 2,
    binary: false, truncated: false, revision: REVISION };
}

export { kindQuotas, legacyQuotas, manyQuotas, partialQuotas, quotas } from "./quota-data";
