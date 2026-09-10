import { clearAgentTraceCache } from "../src/lib/agent-trace-cache";
import { clearAllDiffNotes } from "../src/lib/diff-notes";
import { t } from "../src/lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../src/lib/operations";
import { applyOriginConfig, clearNotificationTarget, clearPairingFragment, noteRelayRtt, setNetworkMode,
  setNetworkOnline, setPhase, setSessionTransport } from "../src/features/connection/connection-store";
import { applyRuntimeIdentity, resetRuntime, applyDeviceList, setPushEnabled, setPushSubscribed,
  setDevicesError, setPushConfigError, beginSettingsRead } from "../src/features/connection/runtime-store";
import { setScreen, setComputersFrom } from "../src/app/navigation-store";
import { attachLiveSession, setAddingComputer, setComputers, setCredential, setLastUsedDaemon } from "../src/features/computers/catalog-store";
import { setPairAwaitingApproval, setPairCodeDraft, setPairFailure, setPairManualOpen, resetPairingInput } from "../src/features/pairing/form-store";
import { resetDashboard, replaceAgentsFromSnapshot } from "../src/features/dashboard/catalog-store";
import { focusBoard } from "../src/features/board/layout-store";
import {
  applyPaneRead, resetPaneView, selectPane, setAgentChat, setFullTerminal, setPaneRow, setTermSelect,
  noteSnapshotAt,
} from "../src/features/session/session-store";
import { adoptPaneCompose, resetComposeField, setComposeDraft, setComposeLive } from "../src/features/session/compose-store";
import { applyTrace, resetTrace, setTraceBusy, setTraceLoadState, setTraceNote } from "../src/features/session/chat/trace-store";
import {
  adoptDaemonPreferences, panePinned, setDefaultTermMode, setKeysExpanded, setListGroup, setListGroupCollapsed,
  setPadKind, setTermFont, setTermGrid, setTermWrap, togglePanePin,
} from "../src/features/settings/preferences-store";
import { applyCapabilities, setOperationBusy } from "../src/features/operations/capabilities-store";
import { clearNotice, showError } from "../src/app/notices-store";
import { resetComposeDrafts } from "../src/features/session/drafts/compose-drafts";
import { acceptDaemonVersion, checkDaemonRelease } from "../src/features/settings/daemon-update";
import { clearBoardPreviews } from "../src/features/board/preview/store";
import { refreshBoardPreviews } from "../src/features/board/preview/refresh";
import { setQuotaSnapshot } from "../src/features/agent-quota/store";
import {
  clearWorkspacePendingReveal, enterWorkspace, loadDirectory, loadGitDiff, loadWorkspaceFile, setWorkspaceError,
  showWorkspaceTab, WORKSPACE_PENDING_DELAY_MS,
} from "../src/features/workspace";
import type { FixtureScene } from "./types";
import type { FixtureSession } from "./session";
import { FIXED_NOW } from "./environment";
import * as data from "./data";

/**
 * Named-domain fixture setup for the 56 QA scenes.
 *
 * Every scene is expressed as typed, named actions on the ownership domains the
 * stable App reads — never the compatibility `state` facade and never a writable
 * whole-app bag. `resetFixtureBaseline` returns each domain to the fixture
 * baseline (idempotent, no subscriber removal), `applyScene` then raises the
 * fields a single scene needs, and the fixture commits once so the App composes
 * the page from the frame. Feature caches are cleared through their own
 * fixture-safe actions.
 */

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

const AGENT_KINDS = ["codex", "claude", "grok", "pi"];

function allCapabilities(): Record<string, boolean> {
  return Object.fromEntries(Object.keys(NO_OPERATION_CAPABILITIES).map((key) => [key, true]));
}

function paneScene(paneId: string): void {
  setScreen("pane");
  selectPane(paneId);
}

function guidedPane(): void {
  paneScene(data.PANE);
  setAgentChat(false);
  setFullTerminal(false);
}

function chatPane(): void {
  paneScene(data.PANE);
  setAgentChat(true);
  setFullTerminal(false);
  applyTrace({ agentTraceItems: data.trace(), agentTraceTail: data.trace().length, agentTraceLoadState: "ready", agentTraceSig: "qa-fixture" });
}

/** The herd/board fixture snapshot with the focused pane reported idle. */
function idleFocusedSnapshot(): ReturnType<typeof data.snapshot> {
  const base = data.snapshot();
  return {
    ...base,
    panes: (base.panes ?? []).map((entry) => entry.pane_id === base.focused?.pane_id ? { ...entry, agent_status: "idle" } : entry),
  };
}

/**
 * Return every domain to the QA fixture baseline. Idempotent and subscription-
 * safe: it never clears store subscribers, never unmounts the running App and
 * never writes a whole-app record. Call before each scene, then `applyScene`.
 */
export function resetFixtureBaseline(session: FixtureSession): void {
  clearWorkspacePendingReveal();
  clearAgentTraceCache();
  clearAllDiffNotes();
  clearBoardPreviews();
  resetComposeDrafts();

  // Connection / navigation baseline.
  applyOriginConfig({ protocol: 2, p2p: true });
  clearPairingFragment();
  clearNotificationTarget();
  resetPairingInput();
  setNetworkMode("auto");
  setNetworkOnline(true);
  setSessionTransport("p2p");
  noteRelayRtt(18);
  setPhase("live");
  setScreen("home");
  setComputersFrom("home");

  // Computers baseline: catalog + credential + the opaque live session handle.
  setComputers(data.computers());
  setCredential(data.computers()[0] ?? null);
  // The real catalog action remembers the seeded credential as last used; the
  // historical plain-state fixture had no such side effect, so restore its
  // no-last-used baseline explicitly. The product stores/app bootstrap still
  // read the same real lastUsedDaemon() — only QA re-asserts the fixture norm.
  setLastUsedDaemon(null);
  setAddingComputer(false);
  attachLiveSession(session.live);

  // Dashboard / herd projection.
  resetDashboard();
  replaceAgentsFromSnapshot(data.snapshot());

  // Session baseline: no pane, no chat, no terminal, guided text.
  resetPaneView();
  selectPane("");
  setAgentChat(false);
  setFullTerminal(false);
  applyPaneRead(data.PANE_TEXT, "1".padStart(64, "0"));
  noteSnapshotAt(FIXED_NOW);

  // Compose / chat baseline.
  resetComposeField();
  setComposeDraft("");
  setComposeLive(false);
  adoptPaneCompose("");
  resetTrace();

  // Preferences baseline (desktop font matches the 900px breakpoint). A pin a
  // previous scene applied is toggled back off so the next home scene starts
  // flat again — the domain has no full `setPanePinned` API to overwrite.
  const desk = window.matchMedia("(min-width: 900px)").matches;
  adoptDaemonPreferences();
  setDefaultTermMode("guided");
  setTermFont(desk ? 13 : 12);
  setTermWrap(false);
  setTermGrid("pan", 80);
  setKeysExpanded(false);
  setPadKind("keys");
  setListGroup("flat");
  setListGroupCollapsed({});
  for (const pinnedId of Object.keys(panePinned())) togglePanePin(pinnedId);

  // Runtime / capabilities / quota baseline.
  resetRuntime();
  applyRuntimeIdentity({ herdHost: "MacBook Pro", runtimeKind: "herdr" });
  setPushEnabled(false);
  setPushSubscribed(false);
  applyDeviceList(data.devices().slice(0, 1));
  applyCapabilities(allCapabilities() as typeof NO_OPERATION_CAPABILITIES, AGENT_KINDS);
  setOperationBusy(false);
  clearNotice();
  setQuotaSnapshot(session.live, { loading: false, items: data.quotas(), error: "" });
}

export async function applyScene(name: string, session: FixtureSession): Promise<void> {
  if (!scenes.some((scene) => scene.name === name)) throw new Error(`Unknown QA scene: ${name}`);
  if (name === "boot" || name === "resuming") { setPhase(name); return; }
  if (name.startsWith("connect") || name.startsWith("pairing")) {
    setPhase(name === "pairing" || name === "pairing-approval" ? "pairing" : "connect");
    setAddingComputer(name === "connect-add");
    setComputers(name === "connect-add" ? data.computers() : []);
    setCredential(null);
    setPairManualOpen(name === "connect-manual" || name === "connect-error");
    setPairCodeDraft(name === "connect-error" ? "ABCD" : name === "connect-manual" ? "ABCD-EFGH-JKMPQR" : "");
    setPairAwaitingApproval(name === "pairing-approval");
    if (name === "connect-error") { setPairFailure("code", null); showError(t("err.pairIncomplete", { n: 4 }), true); }
    if (name === "pairing-error") { setPairFailure(null, "verify"); showError(t("err.pair_timeout"), true); }
    return;
  }
  if (name.startsWith("computers")) {
    setPhase("pick");
    setComputers(name === "computers-one" ? data.computers().slice(0, 1) : data.computers());
    attachLiveSession(null);
    setCredential(null);
    // Keep the historical no-last-used picker: like the old plain-state
    // credential write, a picker scene must not leave the seeded daemon marked
    // as 上次使用 on its first row.
    setLastUsedDaemon(null);
    return;
  }
  if (name === "home-empty" || name === "board-empty") replaceAgentsFromSnapshot({ panes: [] });
  if (name === "home-grouped") { setListGroup("space"); togglePanePin("w1:p3"); }
  if (name === "home-offline" || name === "settings-offline") { setNetworkOnline(false); session.setConnected(false); }
  if (name.startsWith("settings")) {
    setScreen("settings");
    if (name === "settings-devices") applyDeviceList(data.devices());
    if (name === "settings-loading") { applyDeviceList([]); setPushEnabled(null); beginSettingsRead(); }
    if (name === "settings-error") { setDevicesError(t("err.devicesLoad")); setPushConfigError(t("err.pushStatusLoad")); }
    acceptDaemonVersion({ build: "v2.4.0" });
    await checkDaemonRelease();
  }
  if (name.startsWith("quota")) {
    setScreen("quota");
    setQuotaSnapshot(session.live, { loading: name === "quota-loading", items: name === "quota" ? data.quotas() : null,
      error: name === "quota-error" ? t("quota.failed") : "" });
  }
  if (name.startsWith("board")) {
    setScreen("board");
    const focus = data.snapshot().focused;
    if (focus) focusBoard(focus.workspace_id ?? "", focus.tab_id ?? "");
    await refreshBoardPreviews();
  }
  if (name.startsWith("workspace")) {
    guidedPane();
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
    if (name === "workspace-changes" || name.startsWith("workspace-diff")) showWorkspaceTab("changes");
    if (name === "workspace-diff-loading") session.hold("gitDiff");
    if (name.startsWith("workspace-diff")) {
      const pending = loadGitDiff("src/app.ts", "worktree");
      if (name.endsWith("loading")) { void pending; await pendingReveal(); } else await pending;
    }
    if (name === "workspace-error") setWorkspaceError(t("err.daemon_offline"));
  }
  if (name.startsWith("guided") || name === "desktop-guided") {
    guidedPane();
    setComposeDraft(name === "guided-draft" ? "Review the changes and explain the next step." : name === "guided-ime" ? "正在编辑的文字" : "");
    setKeysExpanded(name === "guided-expanded" || name === "guided-slash");
    setPadKind(name === "guided-slash" ? "slash" : "keys");
    setTermWrap(name === "guided-wrap");
    setTermSelect(name === "guided-select");
    setPaneRow(name === "guided-row" ? 2 : null);
  }
  if (name.startsWith("chat") || name === "desktop-chat") {
    chatPane();
    if (name === "chat-draft") setComposeDraft("Review the interaction changes.\nKeep focus and selection stable.\nThen run the checks.");
    if (name === "chat-complete") {
      replaceAgentsFromSnapshot(idleFocusedSnapshot());
      applyTrace({ agentTraceItems: data.trace().slice(0, 4), agentTraceTail: 4 });
    }
    if (["chat-empty", "chat-loading", "chat-error"].includes(name)) applyTrace({ agentTraceItems: [], agentTraceTail: 0 });
    if (name === "chat-loading") { setTraceLoadState("loading"); setTraceBusy(true); }
    if (name === "chat-error") { setTraceLoadState("error"); setTraceNote(t("chat.detailFailed")); }
    if (name === "chat-older") applyTrace({ agentTraceNext: "qa:older", agentTraceTruncated: true });
  }
  if (name.startsWith("terminal")) {
    paneScene(data.PANE);
    setFullTerminal(true);
    setAgentChat(false);
  }
  if (name === "terminal-open-error") session.failNext("terminalOpen", "herdr_offline");
}

const pendingReveal = () => new Promise<void>((resolve) => setTimeout(resolve, WORKSPACE_PENDING_DELAY_MS + 40));

export function afterScenePaint(name: string): void {
  if (name !== "guided-ime") return;
  const input = document.querySelector<HTMLTextAreaElement>(".dock textarea");
  if (!input) throw new Error("QA guided IME fixture has no compose field");
  input.focus({ preventScroll: true });
  input.setSelectionRange(1, 4);
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "正在" }));
}