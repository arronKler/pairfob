import { state, replaceAgentsFromSnapshot, type AppState } from "../src/state";
import { initialBoardViewState } from "../src/state-board";
import { t } from "../src/lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../src/lib/operations";
import { clearAgentTraceCache } from "../src/lib/agent-trace-cache";
import { clearAllDiffNotes } from "../src/lib/diff-notes";
import { resetComposeDrafts } from "../src/compose-drafts";
import { acceptDaemonVersion, checkDaemonRelease } from "../src/daemon-update";
import { views } from "../src/ui/agent-quota";
import { refreshBoardPreviews, clearBoardPreviews } from "../src/ui/board-preview";
import { clearWorkspacePendingReveal, enterWorkspace, loadDirectory, loadGitDiff, loadWorkspaceFile, workspaceModel, WORKSPACE_PENDING_DELAY_MS } from "../src/workspace";
import type { FixtureScene } from "./types";
import type { FixtureSession } from "./session";
import { FIXED_NOW } from "./environment";
import * as data from "./data";

const initial = structuredClone({ ...state, live: null, pairAbort: null });
export const scenes: FixtureScene[] = [
  { name: "boot", description: "Initial credential loading" },
  { name: "resuming", description: "Saved computer reconnecting" },
  { name: "connect", description: "First-run QR-first pairing" },
  { name: "connect-manual", description: "Manual code details expanded" },
  { name: "connect-error", description: "Invalid manual code feedback" },
  { name: "connect-add", description: "Add another computer" },
  { name: "pairing", description: "Pair code verification" },
  { name: "pairing-approval", description: "Waiting for approval on computer" },
  { name: "pairing-error", description: "Failed computer approval step" },
  { name: "computers-one", description: "One computer offline retry" },
  { name: "computers-many", description: "Saved computer picker" },
  { name: "home-empty", description: "No session yet" },
  { name: "home-populated", description: "Flat session list" },
  { name: "home-grouped", description: "Grouped workspace list" },
  { name: "home-offline", description: "Unverifiable session status" },
  { name: "desktop-empty", description: "Responsive rail with no selected pane; supply desktop viewport" },
  { name: "desktop-guided", description: "Responsive rail and guided pane; supply desktop viewport" },
  { name: "desktop-chat", description: "Responsive rail and agent chat; supply desktop viewport" },
  { name: "settings", description: "Connected settings and update footer" },
  { name: "settings-offline", description: "Offline settings" },
  { name: "settings-devices", description: "Self, offline and revoked device rows" },
  { name: "settings-loading", description: "Settings pending state" },
  { name: "settings-error", description: "Device and push configuration errors" },
  { name: "quota", description: "Available, unlimited, stale and unavailable quotas" },
  { name: "quota-loading", description: "Quota loading state" },
  { name: "quota-error", description: "Quota unavailable/error state" },
  { name: "board", description: "Weighted split layout with ANSI previews" },
  { name: "board-empty", description: "Board without workspaces" },
  { name: "workspace-loading", description: "Cold directory skeleton" },
  { name: "workspace-files", description: "Root file browser" },
  { name: "workspace-directory", description: "Nested directory breadcrumbs" },
  { name: "workspace-file", description: "Highlighted source file" },
  { name: "workspace-file-loading", description: "Pending source file skeleton" },
  { name: "workspace-changes", description: "Staged and working-tree groups" },
  { name: "workspace-diff", description: "Working-tree source diff" },
  { name: "workspace-diff-loading", description: "Pending diff skeleton" },
  { name: "workspace-error", description: "Workspace read failure" },
  { name: "guided", description: "Guided ANSI terminal and collapsed keys" },
  { name: "guided-draft", description: "Unsent compose draft" },
  { name: "guided-ime", description: "Focused compose with active composition and selection" },
  { name: "guided-expanded", description: "Expanded terminal key pad" },
  { name: "guided-slash", description: "Expanded command pad" },
  { name: "guided-wrap", description: "Wrapped terminal text" },
  { name: "guided-select", description: "Native text selection mode" },
  { name: "guided-row", description: "Selected rendered row action bar" },
  { name: "chat", description: "Streaming execution trace" },
  { name: "chat-complete", description: "Finished execution with Markdown reply" },
  { name: "chat-draft", description: "Multiline agent prompt draft" },
  { name: "chat-empty", description: "Empty agent history" },
  { name: "chat-loading", description: "Pending agent history" },
  { name: "chat-error", description: "Failed history with retry" },
  { name: "chat-older", description: "Older-history control and truncation notice" },
  { name: "terminal-live", description: "Real xterm/WebGL with local terminal RPC and injectable frames" },
  { name: "terminal-open-error", description: "Real renderer with a rejected local TerminalOpen" },
  { name: "terminal-loading", description: "Full terminal shell before renderer mount", shellOnly: true },
  { name: "terminal-error", description: "Full terminal shell retry state", shellOnly: true },
];

export function resetFixtureState(session: FixtureSession): void {
  clearWorkspacePendingReveal();
  clearAgentTraceCache();
  clearAllDiffNotes();
  clearBoardPreviews();
  resetComposeDrafts();
  Object.assign(state, structuredClone(initial), initialBoardViewState(), {
    phase: "live", screen: "home", live: session.live, credential: data.computers()[0], computers: data.computers(),
    networkOnline: true, p2pEnabled: true, networkMode: "auto", sessionTransport: "p2p", relayRttMs: 18,
    herdHost: "MacBook Pro", runtimeKind: "herdr", agentKinds: ["codex", "claude", "grok", "pi"],
    defaultTermMode: "guided", composeLive: false, defaultComposeLive: false, termFontPx: window.matchMedia("(min-width: 900px)").matches ? 13 : 12,
    termCols: 80, termFit: "pan", termWrap: false, listGroup: "flat", settingsLoading: false,
    pushEnabled: false, pushSubscribed: false, deviceList: [data.devices()[0]], snapshotAt: FIXED_NOW,
    operationCapabilities: Object.fromEntries(Object.keys(NO_OPERATION_CAPABILITIES).map((key) => [key, true])) as AppState["operationCapabilities"],
  } satisfies Partial<AppState>);
  replaceAgentsFromSnapshot(data.snapshot());
  state.paneId = "";
  state.paneText = data.PANE_TEXT;
  state.paneHash = "1".padStart(64, "0");
  views.set(session.live, { loading: false, items: data.quotas(), error: "" });
}

function pane(): void { state.screen = "pane"; state.paneId = data.PANE; }
function chat(): void {
  pane();
  state.agentChat = true;
  state.agentTraceLoadState = "ready";
  state.agentTraceItems = data.trace();
  state.agentTraceTail = state.agentTraceItems.length;
  state.agentTraceSig = "qa-fixture";
}
const pendingReveal = () => new Promise<void>((resolve) => setTimeout(resolve, WORKSPACE_PENDING_DELAY_MS + 40));

export async function applyScene(name: string, session: FixtureSession): Promise<void> {
  if (!scenes.some((scene) => scene.name === name)) throw new Error(`Unknown QA scene: ${name}`);
  if (name === "boot" || name === "resuming") { state.phase = name; return; }
  if (name.startsWith("connect") || name.startsWith("pairing")) {
    state.phase = name === "pairing" || name === "pairing-approval" ? "pairing" : "connect";
    state.addingComputer = name === "connect-add";
    state.computers = state.addingComputer ? data.computers() : [];
    state.credential = null;
    state.pairManualOpen = name === "connect-manual" || name === "connect-error";
    state.pairCodeDraft = name === "connect-error" ? "ABCD" : name === "connect-manual" ? "ABCD-EFGH-JKMPQR" : "";
    state.pairAwaitingApproval = name === "pairing-approval";
    if (name === "connect-error") { state.pairErrorTarget = "code"; state.notice = { text: t("err.pairIncomplete", { n: 4 }), tone: "error" }; }
    if (name === "pairing-error") { state.pairFailedStep = "verify"; state.notice = { text: t("err.pair_timeout"), tone: "error" }; }
    return;
  }
  if (name.startsWith("computers")) {
    state.phase = "pick";
    state.computers = name === "computers-one" ? data.computers().slice(0, 1) : data.computers();
    state.live = null;
    state.credential = null;
    return;
  }
  if (name === "home-empty" || name === "board-empty") replaceAgentsFromSnapshot({ panes: [] });
  if (name === "home-grouped") { state.listGroup = "space"; state.panePinned = { "w1:p3": FIXED_NOW - 3600000 }; }
  if (name === "home-offline" || name === "settings-offline") { state.networkOnline = false; session.setConnected(false); }
  if (name.startsWith("settings")) {
    state.screen = "settings";
    if (name === "settings-devices") state.deviceList = data.devices();
    if (name === "settings-loading") { state.settingsLoading = true; state.deviceList = []; state.pushEnabled = null; }
    if (name === "settings-error") { state.devicesError = t("err.devicesLoad"); state.pushConfigError = t("err.pushStatusLoad"); }
    acceptDaemonVersion({ build: "v2.4.0" });
    await checkDaemonRelease();
  }
  if (name.startsWith("quota")) {
    state.screen = "quota";
    views.set(session.live, { loading: name === "quota-loading", items: name === "quota" ? data.quotas() : null,
      error: name === "quota-error" ? t("quota.failed") : "" });
  }
  if (name.startsWith("board")) {
    state.screen = "board";
    state.boardFitted = false;
    await refreshBoardPreviews();
  }
  if (name.startsWith("workspace")) {
    pane();
    if (name === "workspace-loading") {
      session.hold("workspaceOpen");
      void enterWorkspace(data.PANE);
      await pendingReveal();
      return;
    }
    await enterWorkspace(data.PANE);
    if (name === "workspace-directory") await loadDirectory("src");
    if (name === "workspace-file-loading") session.hold("workspaceRead");
    if (name.startsWith("workspace-file") && name !== "workspace-files") {
      const pending = loadWorkspaceFile("src/app.ts");
      if (name.endsWith("loading")) { void pending; await pendingReveal(); } else await pending;
    }
    if (name === "workspace-changes" || name.startsWith("workspace-diff")) workspaceModel.tab = "changes";
    if (name === "workspace-diff-loading") session.hold("gitDiff");
    if (name.startsWith("workspace-diff")) {
      const pending = loadGitDiff("src/app.ts", "worktree");
      if (name.endsWith("loading")) { void pending; await pendingReveal(); } else await pending;
    }
    if (name === "workspace-error") workspaceModel.error = t("err.daemon_offline");
  }
  if (name.startsWith("guided") || name === "desktop-guided") {
    pane();
    state.composeDraft = name === "guided-draft" ? "Review the changes and explain the next step." : name === "guided-ime" ? "正在编辑的文字" : "";
    state.keysExpanded = name === "guided-expanded" || name === "guided-slash";
    state.padKind = name === "guided-slash" ? "slash" : "keys";
    state.termWrap = name === "guided-wrap";
    state.termSelect = name === "guided-select";
    state.paneRow = name === "guided-row" ? 2 : null;
  }
  if (name.startsWith("chat") || name === "desktop-chat") {
    chat();
    if (name === "chat-draft") state.composeDraft = "Review the interaction changes.\nKeep focus and selection stable.\nThen run the checks.";
    if (name === "chat-complete") { state.agents[0].status = "idle"; state.agentTraceItems = data.trace().slice(0, 4); }
    if (["chat-empty", "chat-loading", "chat-error"].includes(name)) state.agentTraceItems = [];
    if (name === "chat-loading") { state.agentTraceLoadState = "loading"; state.agentTraceBusy = true; }
    if (name === "chat-error") { state.agentTraceLoadState = "error"; state.agentTraceNote = t("chat.detailFailed"); }
    if (name === "chat-older") { state.agentTraceNext = "qa:older"; state.agentTraceTruncated = true; }
    state.agentTraceTail = state.agentTraceItems.length;
  }
  if (name.startsWith("terminal")) { pane(); state.fullTerminal = true; }
  if (name === "terminal-open-error") session.failNext("terminalOpen", "herdr_offline");
}

export function afterScenePaint(name: string): void {
  if (name !== "guided-ime") return;
  const input = document.querySelector<HTMLTextAreaElement>(".dock textarea");
  if (!input) throw new Error("QA guided IME fixture has no compose field");
  input.focus({ preventScroll: true });
  input.setSelectionRange(1, 4);
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "正在" }));
}
