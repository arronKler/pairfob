import { isDesk } from "../src/app/viewport";
import { clearAgentTraceCache } from "../src/lib/agent-trace-cache";
import { clearAllDiffNotes } from "../src/lib/diff-notes";
import { t } from "../src/lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../src/lib/operations";
import { applyOriginConfig, clearNotificationTarget, clearPairingFragment, noteRelayRtt, setNetworkMode,
  setNetworkOnline, setPhase, setSessionTransport, setConnectFailure, setRetryingUnreachable } from "../src/features/connection/connection-store";
import { setConnectionRecordSource } from "../src/features/connection/connection-path";
import { applyRuntimeIdentity, resetRuntime, applyDeviceList, setPushEnabled, setPushSubscribed,
  setDevicesError, setPushConfigError, beginSettingsRead, setIdentityPending } from "../src/features/connection/runtime-store";
import { setScreen, setComputersFrom } from "../src/app/navigation-store";
import { attachLiveSession, setAddingComputer, setComputers, setCredential, setLastUsedDaemon } from "../src/features/computers/catalog-store";
import { setPairAwaitingApproval, setPairCodeDraft, setPairFailure, setPairManualOpen, resetPairingInput } from "../src/features/pairing/form-store";
import { liveAgents, resetDashboard, replaceAgentsFromSnapshot } from "../src/features/dashboard/catalog-store";
import { focusBoard } from "../src/features/board/layout-store";
import {
  applyPaneRead, resetPaneView, selectPane, setAgentChat, setFullTerminal, setPaneRow, setTermSelect,
  noteSnapshotAt,
} from "../src/features/session/session-store";
import { adoptPaneCompose, resetComposeField, setComposeDraft, setComposeLive } from "../src/features/session/compose-store";
import { applyTrace, resetTrace, setTraceBusy, setTraceLoadState, setTraceNote } from "../src/features/session/chat/trace-store";
import {
  adoptDaemonPreferences, applyHerdTouches, PANE_ACTIVATED_KEY, PANE_TOUCHED_KEY, panePinned, rememberPane, resetHerdPresentationChoices,
  setDefaultTermMode, setKeysExpanded, setListGroup, setListGroupCollapsed,
  setPadKind, setTermFont, setTermGrid, setTermWrap, togglePanePin,
} from "../src/features/settings/preferences-store";
import { applyCapabilities, setOperationBusy } from "../src/features/operations/capabilities-store";
import { clearNotice, showError } from "../src/app/notices-store";
import { resetComposeDrafts } from "../src/features/session/drafts/compose-drafts";
import { acceptDaemonVersion, checkDaemonRelease } from "../src/features/settings/daemon-update";
import { clearBoardPreviews } from "../src/features/board/preview/store";
import { refreshBoardPreviews } from "../src/features/board/preview/refresh";
import { setQuotaSnapshot } from "../src/features/agent-quota/store";
import { openCommandPalette } from "../src/features/command-palette";
import { noteOverlayOrigin } from "../src/shared/ui/overlay/origin";
import { loadHerdSessions } from "../src/features/herd-sessions/load";
import {
  clearWorkspacePendingReveal, enterWorkspace, getWorkspaceSnapshot, loadDirectory, loadGitDiff, loadWorkspaceFile, setWorkspaceError,
  showWorkspaceTab, WORKSPACE_PENDING_DELAY_MS,
} from "../src/features/workspace";
import type { FixtureScene } from "./types";
import type { FixtureSession, SessionSource } from "./session";
import { clockAt, FIXED_NOW } from "./environment";
import { recordedAgentSession, type RecordedAgent } from "./agent-sessions";
import * as data from "./data";
import { BUSY_AGENT_KINDS, BUSY_PINNED, busyPaneText, busySnapshot } from "./demo-data";
import { resetAttachmentFixture, seedAttachmentTray } from "./attachments";
import { openInspectorScene } from "./inspector-scenes";
import { paneScreen, wideScreen } from "./terminal-screens";

/**
 * Named-domain fixture setup for deterministic QA scenes.
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
  { name: "resuming-slow", description: "Reconnect past 8 s: pairfob.com reached, waiting on the computer" },
  { name: "resuming-slow-relay", description: "Reconnect past 8 s: still waiting on pairfob.com" },
  { name: "home-unreachable", description: "The only computer is offline: connection path and computer-side steps; beside the locked rail from 720 px" },
  { name: "home-unreachable-relay", description: "The only computer cannot be reached because pairfob.com is unreachable; beside the locked rail from 720 px" },
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
  { name: "attention-rich", description: "Rich task readiness and completion facts" },
  { name: "attention-rich-updated", description: "Runtime occupant replacement and newer completion sequence" },
  { name: "attention-empty", description: "Attention filters with no matching checking tasks" },
  { name: "attention-legacy", description: "Legacy agents without readiness facts" },
  { name: "home-grouped", description: "Grouped workspace list" },
  { name: "home-offline", description: "Unverifiable session status" },
  { name: "home-busy", description: "Busy computer: six workspaces, many agents and terminals, grouped" },
  { name: "home-reading", description: "Just connected: runtime and first snapshot not read yet" },
  { name: "home-empty-locked", description: "No session yet on a computer that does not allow starting one remotely" },
  { name: "home-exited", description: "Connected, Herdr is not running: no session to list, the command to run and a retry" },
  { name: "home-unverified", description: "Connected, Herdr did not answer: no session to list, retry and connection details" },
  { name: "home-offline-empty", description: "This device lost the network before any session was read" },
  { name: "home-reconnecting", description: "The connection dropped before any session was read; it is being restored" },
  { name: "home-recent", description: "Sessions opened from this device, most recent first: the palette's recent section has a history" },
  { name: "home-update", description: "A computer whose pairfob is behind the release: the update dot on the Settings entry" },
  { name: "home-herd-sessions", description: "A computer running a second Herdr session: the session switch under the rail's head, beside the title on the phone" },
  { name: "palette", description: "Search and jump open with nothing typed; no session opened from this device yet" },
  { name: "palette-recent", description: "Search and jump open with nothing typed, over home-recent's history" },
  { name: "palette-query", description: "Search and jump with a query typed: the sessions of one workspace" },
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
  { name: "board-busy", description: "Busy computer board: multi-pane tabs with per-pane previews" },
  { name: "board-zoomed", description: "Busy board whose first tab is zoomed on the computer" },
  { name: "board-offline", description: "Busy board while reconnecting: read-only layout" },
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
  { name: "guided-attachments", description: "Attachment tray: in-body, ready, uploading, failed and restored items" },
  { name: "guided-attachments-relay", description: "Attachment tray waiting for a direct connection" },
  { name: "guided-live", description: "Live input: keys go straight to the terminal" },
  { name: "guided-live-expanded", description: "Live input with the terminal key pad open" },
  { name: "inspector-guided-changes", description: "Inspector beside the guided pane: staged and working-tree groups; supply 900 px or more" },
  { name: "inspector-guided-diff", description: "Inspector beside the guided pane: working-tree source diff" },
  { name: "inspector-chat-changes", description: "Inspector beside agent chat: staged and working-tree groups; supply 900 px or more" },
  { name: "inspector-chat-diff", description: "Inspector beside agent chat: working-tree source diff" },
  { name: "inspector-chat-diff-note", description: "Inspector diff with a saved line note waiting to be sent" },
  { name: "inspector-chat-file", description: "Inspector beside agent chat: highlighted source file" },
  { name: "inspector-chat-files", description: "Inspector beside agent chat: root file browser" },
  { name: "chat", description: "Streaming execution trace" },
  { name: "chat-complete", description: "Finished execution with Markdown reply" },
  { name: "chat-draft", description: "Multiline agent prompt draft" },
  { name: "chat-empty", description: "Empty agent history" },
  { name: "chat-loading", description: "Pending agent history" },
  { name: "chat-error", description: "Failed history with retry" },
  { name: "chat-older", description: "Older-history control and truncation notice" },
  { name: "chat-markers", description: "Slash command chip, context compaction divider and interrupted turn" },
  { name: "chat-needs-you", description: "Agent waiting on a terminal approval answered from the chat" },
  { name: "chat-cursor", description: "A recorded Cursor session: steps end without a result, no times" },
  { name: "chat-hermes", description: "A recorded Hermes session: thinking, shell results and a failed command" },
  { name: "chat-opencode", description: "A recorded opencode session: thinking, tools and a failed command" },
  { name: "chat-steps", description: "Codex steps: a failure the agent worked past, command-output reads, and a turn stopped on a failed step" },
  { name: "chat-pi-long", description: "Long Pi transcript with tool success, error, and empty output" },
  { name: "chat-pi-unread", description: "Long Pi transcript scrolled away from the tail with unread updates" },
  { name: "chat-pi-recovery", description: "Long Pi transcript ready for disconnect, reconnect, and foreground actions" },
  { name: "chat-pi-compose", description: "Focused multiline compose at a narrow phone viewport" },
  { name: "terminal-live", description: "Real xterm/WebGL with local terminal RPC and injectable frames" },
  { name: "terminal-open-error", description: "Real renderer with a rejected local TerminalOpen" },
  { name: "terminal-frame", description: "Real renderer with the pane's screen drawn, redrawn after every resize" },
  { name: "terminal-wide", description: "Real renderer with a column ruler and rows that fill the whole grid" },
  { name: "terminal-inspector", description: "terminal-wide with the inspector open: the terminal keeps its columns and pans" },
  { name: "terminal-loading", description: "Full terminal shell before renderer mount", shellOnly: true },
  { name: "terminal-error", description: "Full terminal shell retry state", shellOnly: true },
];

const AGENT_KINDS = ["codex", "claude", "grok", "pi"];

const EMPTY_LIST_SCENES = new Set(["home-empty-locked", "home-exited", "home-unverified", "home-offline-empty", "home-reconnecting"]);
const BUSY_SCENES = new Set(["home-busy", "board-busy", "board-zoomed", "board-offline"]);

/** Complete-terminal scenes whose computer draws a screen, so they are not ready until it is delivered. */
const TERMINAL_SCREENS: Record<string, NonNullable<SessionSource["terminalScreen"]>> = {
  "terminal-frame": paneScreen,
  "terminal-wide": wideScreen,
  "terminal-inspector": wideScreen,
};

/** The computer a scene talks to: busy scenes bring their own snapshot and screens. */
export function sceneSource(name: string): SessionSource {
  if (name === "chat-needs-you") return { snapshot: blockedFocusedSnapshot, paneText: () => data.NEEDS_YOU_SCREEN };
  if (name === "home-herd-sessions") return { herdSessions: [{ name: null, running: true }, { name: "release", running: true }, { name: "scratch", running: false }] };
  if (TERMINAL_SCREENS[name]) return { terminalScreen: TERMINAL_SCREENS[name] };
  return BUSY_SCENES.has(name) ? { snapshot: busySnapshot, paneText: busyPaneText, agentKinds: BUSY_AGENT_KINDS } : {};
}

/**
 * What a complete-terminal scene waits for before it is ready: the stage its
 * real controller must reach, and whether the computer's screen must have
 * arrived. Null for every other scene, the two shell-only ones included.
 */
export function terminalSceneReadiness(name: string): { stage: "live" | "error"; screen: boolean } | null {
  if (name === "terminal-open-error") return { stage: "error", screen: false };
  if (name === "terminal-live") return { stage: "live", screen: false };
  return TERMINAL_SCREENS[name] ? { stage: "live", screen: true } : null;
}

/**
 * The reader's own opens, oldest first, as minutes before the fixture clock.
 * Recorded through the open action's stamp, each at its own instant.
 */
const RECENT_OPENS: Array<[paneId: string, minutesAgo: number]> = [
  [data.PANE, 190], ["w2:p2", 47], ["w2:p1", 12], ["w1:p3", 3],
];

/**
 * When each of those sessions last changed, as minutes before the fixture
 * clock: what a row's "… ago" counts from. None is the instant the session was
 * opened at, so the list shows the two apart, ordered by the opens and dated by
 * the changes, and opening a row can be seen to leave its time alone.
 */
const RECENT_CHANGES: Array<[paneId: string, minutesAgo: number]> = [
  [data.PANE, 26], ["w2:p2", 4 * 60], ["w2:p1", 75], ["w1:p3", 8],
];

/** The second fixture computer; its pairfob is one release behind (`/dl/VERSION` answers v2.4.0). */
const OUTDATED_BUILD = "v2.3.0";

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

/** The herd/board fixture snapshot with the focused pane in another status. */
function focusedSnapshot(status: string, agent?: string): ReturnType<typeof data.snapshot> {
  const base = data.snapshot();
  return {
    ...base,
    panes: (base.panes ?? []).map((entry) => entry.pane_id === base.focused?.pane_id
      ? { ...entry, agent_status: status, ...(agent ? { agent } : {}) } : entry),
  };
}
const idleFocusedSnapshot = () => focusedSnapshot("idle");
const blockedFocusedSnapshot = () => focusedSnapshot("blocked");

/**
 * Return every domain to the QA fixture baseline. Idempotent and subscription-
 * safe: it never clears store subscribers, never unmounts the running App and
 * never writes a whole-app record. Call before each scene, then `applyScene`.
 */
export function resetFixtureBaseline(session: FixtureSession): void {
  // Open-order and recency stamps persist per computer. Forget them first, in
  // memory and in the fixture's storage, so the snapshot fold below starts from
  // a list nobody has opened anything on.
  resetHerdPresentationChoices();
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index) ?? "";
    if (key.startsWith(PANE_ACTIVATED_KEY) || key.startsWith(PANE_TOUCHED_KEY)) localStorage.removeItem(key);
  }
  clearWorkspacePendingReveal();
  clearAgentTraceCache();
  clearAllDiffNotes();
  clearBoardPreviews();
  resetComposeDrafts();
  resetAttachmentFixture();

  // Connection / navigation baseline.
  applyOriginConfig({ protocol: 2, p2p: true });
  clearPairingFragment();
  clearNotificationTarget();
  resetPairingInput();
  setNetworkMode("auto");
  setNetworkOnline(true);
  setSessionTransport("p2p");
  noteRelayRtt(18);
  setConnectionRecordSource(null);
  setConnectFailure("");
  setRetryingUnreachable(false);
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

  // Preferences baseline (desktop font matches the desk breakpoint). A pin a
  // previous scene applied is toggled back off so the next home scene starts
  // flat again — the domain has no full `setPanePinned` API to overwrite.
  const desk = isDesk();
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
  if (name.startsWith("resuming-slow")) {
    // The fixture clock is frozen, so the recorded attempt simply started 9 s earlier.
    const started = FIXED_NOW - 9_000;
    setConnectionRecordSource(() => name === "resuming-slow-relay"
      ? [{ event: "connect_start", at: started }]
      : [{ event: "connect_start", at: started }, { event: "ws_open", at: started + 400 }, { event: "route_bound", at: started + 500 }]);
    setPhase("resuming");
    return;
  }
  if (name.startsWith("home-unreachable")) {
    const relay = name === "home-unreachable-relay";
    setConnectionRecordSource(() => [{ event: "connect_start", at: FIXED_NOW - 12_000 },
      ...(relay ? [] : [{ event: "ws_open", at: FIXED_NOW - 11_600 }]), { event: "connect_failed", at: FIXED_NOW - 4_000 }]);
    setConnectFailure(relay ? "timeout" : "daemon_offline");
    setComputers(data.computers().slice(0, 1));
    attachLiveSession(null);
    setCredential(null);
    setLastUsedDaemon(null);
    setPhase("pick");
    return;
  }
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
  if (EMPTY_LIST_SCENES.has(name)) {
    // An empty list for each reason the list can give: the snapshot was read and holds nothing.
    replaceAgentsFromSnapshot({ panes: [] });
    if (name === "home-empty-locked") applyCapabilities({ ...allCapabilities(), create_conversation: false } as typeof NO_OPERATION_CAPABILITIES, AGENT_KINDS);
    if (name === "home-exited") applyRuntimeIdentity({ herdHost: "MacBook Pro", runtimeKind: "offline" });
    if (name === "home-unverified") applyRuntimeIdentity({ herdHost: "MacBook Pro", runtimeKind: "" });
    if (name === "home-offline-empty") setNetworkOnline(false);
    if (name === "home-offline-empty" || name === "home-reconnecting") session.setConnected(false);
  }
  if (name === "home-reading") {
    // The moment after going live: nothing read yet, the first GetConfig in flight.
    resetDashboard();
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "" });
    setIdentityPending(true);
  }
  if (BUSY_SCENES.has(name)) {
    replaceAgentsFromSnapshot(busySnapshot());
    applyCapabilities(allCapabilities() as typeof NO_OPERATION_CAPABILITIES, BUSY_AGENT_KINDS);
    if (name === "home-busy") {
      setListGroup("space");
      for (const paneId of BUSY_PINNED) togglePanePin(paneId);
    }
  }
  if (name === "attention-rich" || name === "attention-rich-updated")
    replaceAgentsFromSnapshot(data.attentionSnapshot(name === "attention-rich-updated"));
  if (name === "attention-empty") replaceAgentsFromSnapshot({ ...data.snapshot(), panes: data.snapshot().panes?.filter((pane) => pane.agent_status !== "unknown") });
  if (name === "attention-legacy") replaceAgentsFromSnapshot(data.snapshot());
  if (name === "home-grouped") { setListGroup("space"); togglePanePin("w1:p3"); }
  if (name === "home-recent" || name === "palette-recent") {
    for (const [paneId, minutesAgo] of RECENT_OPENS) clockAt(FIXED_NOW - minutesAgo * 60_000, () => rememberPane(paneId));
    // Each change goes through the fold a snapshot runs: the same list with that one session's status as it was before.
    const agents = liveAgents();
    for (const [paneId, minutesAgo] of RECENT_CHANGES) {
      const before = agents.map((agent) => agent.paneId === paneId
        ? { ...agent, status: agent.status === "idle" ? "working" as const : "idle" as const } : agent);
      applyHerdTouches(before, agents, FIXED_NOW - minutesAgo * 60_000);
    }
  }
  if (name === "home-update") {
    // The version belongs to a computer, so this scene is paired with the
    // second one: the baseline computer stays current for every other scene.
    const outdated = data.computers()[1];
    setCredential(outdated);
    setLastUsedDaemon(null);
    applyRuntimeIdentity({ herdHost: outdated.hostname ?? "", runtimeKind: "herdr" });
    acceptDaemonVersion({ build: OUTDATED_BUILD });
    await checkDaemonRelease();
  }
  if (name === "home-herd-sessions") await loadHerdSessions();
  if (name === "home-offline" || name === "settings-offline" || name === "board-offline") { setNetworkOnline(false); session.setConnected(false); }
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
      error: name === "quota-error" ? "quota.failed" : "" });
  }
  if (name.startsWith("board")) {
    setScreen("board");
    const focus = (BUSY_SCENES.has(name) ? busySnapshot() : data.snapshot()).focused;
    if (name === "board-zoomed") {
      // Zoom the fixture computer itself, so a refresh or a restore behaves like herdr.
      // A harness whose computer is not the busy one gets the same picture patched in.
      const own = await session.live.snapshot();
      if ((own.panes as Array<{ pane_id: string }> | undefined)?.some((pane) => pane.pane_id === "b1:p2")) {
        await session.live.zoomPane({ pane_id: "b1:p2", mode: "on" });
        replaceAgentsFromSnapshot(await session.live.snapshot());
      } else {
        type WireLayout = { tab_id: string };
        const zoomed = busySnapshot();
        zoomed.layouts = (zoomed.layouts as Array<WireLayout & { panes: Array<{ pane_id: string }> }>).map((layout) => layout.tab_id !== "b1:t1" ? layout
          : { ...layout, zoomed: true, focused_pane_id: "b1:p2", panes: layout.panes.map((pane) => ({ ...pane, focused: pane.pane_id === "b1:p2" })) });
        replaceAgentsFromSnapshot(zoomed);
      }
    }
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
    // Beside the list a first look opens on changes; these scenes are the files tab at any width.
    if (name !== "workspace-changes" && !name.startsWith("workspace-diff") && getWorkspaceSnapshot().tab !== "files") showWorkspaceTab("files");
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
    setKeysExpanded(name === "guided-expanded" || name === "guided-slash" || name === "guided-live-expanded");
    setComposeLive(name.startsWith("guided-live"));
    setPadKind(name === "guided-slash" ? "slash" : "keys");
    setTermWrap(name === "guided-wrap");
    setTermSelect(name === "guided-select");
    setPaneRow(name === "guided-row" ? 2 : null);
    if (name.startsWith("guided-attachments")) {
      const relay = name === "guided-attachments-relay";
      if (relay) setSessionTransport("relay");
      setComposeDraft(seedAttachmentTray(relay ? "relay" : "p2p"));
    }
  }
  if (name.startsWith("chat") || name === "desktop-chat") {
    chatPane();
    if (name.startsWith("chat-pi-")) {
      const trace = data.phase2ConversationTrace();
      session.setTrace(trace);
      applyTrace({ agentTraceItems: trace, agentTraceTail: trace.length, agentTraceLoadState: "ready", agentTraceSig: JSON.stringify(trace) });
    }
    if (name === "chat-pi-unread") applyTrace({ agentTraceFollow: false, agentTraceUnread: true });
    if (name === "chat-pi-compose") setComposeDraft("First line stays intact.\n第二行正在使用输入法组合。\nThird line verifies the narrow compose area.");
    if (name === "chat-draft") setComposeDraft("Review the interaction changes.\nKeep focus and selection stable.\nThen run the checks.");
    if (name === "chat-complete") {
      replaceAgentsFromSnapshot(idleFocusedSnapshot());
      applyTrace({ agentTraceItems: data.completeTrace(), agentTraceTail: 4 });
    }
    if (["chat-empty", "chat-loading", "chat-error"].includes(name)) applyTrace({ agentTraceItems: [], agentTraceTail: 0 });
    if (name === "chat-loading") { setTraceLoadState("loading"); setTraceBusy(true); }
    if (name === "chat-error") { setTraceLoadState("error"); setTraceNote(t("chat.detailFailed")); }
    if (name === "chat-older") applyTrace({ agentTraceNext: "qa:older", agentTraceTruncated: true });
    if (name === "chat-needs-you") {
      replaceAgentsFromSnapshot(blockedFocusedSnapshot());
      const trace = data.needsYouTrace();
      session.setTrace(trace);
      applyTrace({ agentTraceItems: trace, agentTraceTail: trace.length, agentTraceLoadState: "ready", agentTraceSig: JSON.stringify(trace) });
    }
    if (name === "chat-cursor" || name === "chat-hermes" || name === "chat-opencode") {
      const agent = name.slice("chat-".length) as RecordedAgent;
      replaceAgentsFromSnapshot(focusedSnapshot("idle", agent));
      const { view, backing } = recordedAgentSession(agent);
      session.setTrace(backing);
      applyTrace({ agentTraceItems: view, agentTraceTail: view.length, agentTraceLoadState: "ready", agentTraceSig: JSON.stringify(view) });
    }
    if (name === "chat-markers" || name === "chat-steps") {
      replaceAgentsFromSnapshot(idleFocusedSnapshot());
      const trace = name === "chat-steps" ? data.stepsTrace() : data.markerTrace();
      session.setTrace(trace);
      applyTrace({ agentTraceItems: trace, agentTraceTail: trace.length, agentTraceLoadState: "ready", agentTraceSig: JSON.stringify(trace) });
    }
  }
  if (name.startsWith("terminal")) {
    paneScene(data.PANE);
    setFullTerminal(true);
    setAgentChat(false);
  }
  if (name === "terminal-open-error") session.failNext("terminalOpen", "herdr_offline");
  if (name.startsWith("inspector-guided")) guidedPane();
  if (name.startsWith("inspector-chat")) chatPane();
  if (name.startsWith("inspector") || name === "terminal-inspector") await openInspectorScene(name);
}

const pendingReveal = () => new Promise<void>((resolve) => setTimeout(resolve, WORKSPACE_PENDING_DELAY_MS + 40));

/** What the reader types in `palette-query`: it matches two sessions by workspace and no action. */
const PALETTE_QUERY = "dash";

/**
 * Search and jump is a dialog over the page, opened once the page underneath is
 * painted. Its query is the field's own state, so the query scene types into
 * the field as the reader would. The scene stands for ⌘K, and the palette's
 * form follows the gesture that asked, so the fixture says a key did.
 */
function openPaletteScene(name: string): void {
  noteOverlayOrigin({ input: "key", target: document.activeElement, x: 0, y: 0, atPointer: false });
  openCommandPalette();
  const field = document.querySelector<HTMLInputElement>("dialog.command-palette[open] input");
  if (!field) throw new Error(`QA ${name} fixture could not open search and jump`);
  if (name !== "palette-query") return;
  // The field's own window supplies the setter and the event, so the same
  // lines type into a browser page and into a test document.
  const view = field.ownerDocument.defaultView;
  const setValue = view && Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")?.set;
  if (!view || !setValue) throw new Error(`QA ${name} fixture cannot type into search and jump`);
  setValue.call(field, PALETTE_QUERY);
  field.dispatchEvent(new view.Event("input", { bubbles: true }));
}

export function afterScenePaint(name: string): void {
  if (name.startsWith("palette")) { openPaletteScene(name); return; }
  if (name !== "guided-ime" && name !== "chat-pi-compose") return;
  const input = document.querySelector<HTMLTextAreaElement>(".dock textarea, .agent-dock textarea");
  if (!input) throw new Error(`QA ${name} fixture has no compose field`);
  input.focus({ preventScroll: true });
  const selection = name === "guided-ime" ? [1, 4] : [22, 25];
  input.setSelectionRange(selection[0], selection[1]);
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "正在" }));
}