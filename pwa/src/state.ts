import { parsePairingFragment, type FragmentPairing } from "./lib/pairing-input";
import { clientWsURL } from "./lib/origin-config";
import { herdSignature, mapSnapshotAgents, type DashboardAgentCard, type SnapshotWire } from "./lib/dashboard";
import {
  applySeenCompletions,
  markCompletionSeen,
  parseSeenCompletions,
  projectAgentSubmission,
  projectCompletionAttention,
  type RuntimeAgentStatuses,
  type SeenCompletions,
} from "./lib/completion-attention";
import {
  parseListGroup,
  parsePinnedAt,
  prunePinnedAt,
  togglePinnedAt,
  touchPane,
  type ListGroup,
  type PinnedAt,
  type TouchedAt,
} from "./lib/ranking";
import { type PairErrorField } from "./lib/ui-model";
import { parseNotificationTarget, type NotificationTarget } from "./lib/notification-target";
import {
  type DeviceSummary,
  type FinishedP2PAttemptObservation,
  type LiveSession,
  type PairResult,
} from "./lib/protocol/client";
import { loadNetworkMode, persistNetworkMode, type NetworkMode } from "./lib/network-mode";
import { parseTermMode, TERM_MODE_OPTIONS, type TermMode } from "./lib/terminal-mode";
import type { MuxProtocol } from "./lib/protocol/mux";
import { NO_OPERATION_CAPABILITIES, type AgentTraceItem, type OperationCapabilities } from "./lib/operations";
import type { NoticeScope } from "./lib/notice-scope";
import { SNAPSHOT_FALLBACK_MS, PANE_READ_FALLBACK_MS } from "./poll";
import { createNoticeLifecycle, type Notice } from "./state-notices";
import { isDesk } from "./viewport";

export { SNAPSHOT_FALLBACK_MS, PANE_READ_FALLBACK_MS };
export { STATUS_NOTICE_MS, type Notice } from "./state-notices";
export { FRIENDLY_ERROR, GENERIC_NOTICE, genericNotice, messageOf, noticeFor, sessionEventNotice } from "./lib/notices";

export type Phase = "boot" | "connect" | "pairing" | "resuming" | "live" | "pick";
export type Screen = "home" | "pane" | "settings" | "computers";
export type StatusTone = "live" | "warn" | "off" | "demo";
export type AgentTraceLoadState = "cold" | "loading" | "ready" | "error";

function requireApp(): HTMLElement {
  const element = document.getElementById("app");
  if (!element) throw new Error("missing #app");
  return element;
}

export const app = requireApp();

export const TERM_FONT_KEY = "pairfob:termFont";
export const TERM_WRAP_KEY = "pairfob:termWrap";
export const TERM_FIT_KEY = "pairfob:termFit";
export const TERM_COLS_KEY = "pairfob:termCols";
export type TermFit = "pan" | "fit";
export const TERM_COL_PRESETS = [80, 100, 120] as const;
export type TermCols = (typeof TERM_COL_PRESETS)[number];
export const KEYS_EXPANDED_KEY = "pairfob:keysExpanded";
export const PAD_KIND_KEY = "pairfob:padKind";
export const DEFAULT_COMPOSE_LIVE_KEY = "pairfob:defaultComposeLive";
export const PANE_COMPOSE_LIVE_KEY = "pairfob:paneComposeLive";
export type PadKind = "keys" | "slash";
export const LIST_GROUP_KEY = "pairfob:listGroup";
export const PANE_TOUCHED_KEY = "pairfob:paneTouched";
export const PANE_PINNED_KEY = "pairfob:panePinned";
export const PANE_TERM_MODE_KEY = "pairfob:paneTermMode";
export const DEFAULT_TERM_MODE_KEY = "pairfob:defaultTermMode";
export { NETWORK_MODE_KEY } from "./lib/network-mode";
export { parseTermMode };
export type { NetworkMode, TermMode };
export const COMPLETION_SEEN_KEY = "pairfob:completionSeen";
export const COMPOSE_MIN_PX = 46;
export const COMPOSE_MAX_PX = 136;
export const TERM_FONT_MIN = 9;
export const TERM_FONT_MAX = 22;

function loadListGroup(): ListGroup {
  try {
    return parseListGroup(localStorage.getItem(LIST_GROUP_KEY));
  } catch {
    return "flat";
  }
}

function loadTermFont(): number {
  try {
    const raw = Number(localStorage.getItem(TERM_FONT_KEY));
    if (Number.isFinite(raw) && raw >= TERM_FONT_MIN && raw <= TERM_FONT_MAX) return Math.round(raw);
  } catch {
    /* private mode or storage blocked */
  }
  return isDesk() ? 13 : 12;
}

function loadTermWrap(): boolean {
  try {
    return localStorage.getItem(TERM_WRAP_KEY) === "1";
  } catch {
    return false;
  }
}

function loadTermFit(): TermFit {
  try {
    return localStorage.getItem(TERM_FIT_KEY) === "fit" ? "fit" : "pan";
  } catch {
    return "pan";
  }
}

function loadTermCols(): TermCols {
  try {
    const raw = Number(localStorage.getItem(TERM_COLS_KEY));
    if (TERM_COL_PRESETS.includes(raw as TermCols)) return raw as TermCols;
  } catch {
    /* private mode or storage blocked */
  }
  return 80;
}

function loadKeysExpanded(): boolean {
  try {
    return localStorage.getItem(KEYS_EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function loadPadKind(): PadKind {
  try {
    return localStorage.getItem(PAD_KIND_KEY) === "slash" ? "slash" : "keys";
  } catch {
    return "keys";
  }
}

function loadDefaultComposeLive(): boolean {
  try {
    return localStorage.getItem(DEFAULT_COMPOSE_LIVE_KEY) === "1";
  } catch {
    return false;
  }
}

function loadDefaultTermMode(): TermMode {
  try {
    return parseTermMode(localStorage.getItem(DEFAULT_TERM_MODE_KEY));
  } catch {
    return "auto";
  }
}

export type AppState = {
  originProtocol: MuxProtocol;
  p2pEnabled: boolean;
  fragment: FragmentPairing | null;
  notificationTarget: NotificationTarget | null;
  phase: Phase;
  screen: Screen;
  notice: Notice | null;
  pairCodeDraft: string;
  pairManualOpen: boolean;
  pairErrorTarget: PairErrorField;
  live: LiveSession | null;
  credential: PairResult | null;
  computers: PairResult[];
  lastUsedDaemonId: string | null;
  addingComputer: boolean;
  paneId: string;
  /** Raw Herdr ANSI controller is mounted instead of the guided pane view. */
  fullTerminal: boolean;
  /** Structured agent-execution view instead of the snapshot terminal. */
  agentChat: boolean;
  /** Fallback preference when a pane has no stored mode of its own. */
  defaultTermMode: TermMode;
  /** Per-pane mode preference. Missing ids use `defaultTermMode`. */
  paneTermModes: Record<string, TermMode>;
  /** Default input behavior for panes without their own choice. */
  defaultComposeLive: boolean;
  /** Per-pane live/compose choice, scoped by the connected daemon in storage. */
  paneComposeLive: Record<string, boolean>;
  agents: DashboardAgentCard[];
  paneText: string;
  paneHash: string;
  pairAwaitingApproval: boolean;
  pairAbort: AbortController | null;
  /** Browser-reported reachability. `true` is a hint; `false` gates network work. */
  networkOnline: boolean;
  /** Latest phone-to-Pairfob WebSocket heartbeat round trip. */
  relayRttMs: number | null;
  /** Active encrypted session path; P2P is attempted without blocking relay use. */
  sessionTransport: "relay" | "p2p";
  /** Settings preference for Auto / P2P / Relay. The live path is `sessionTransport`. */
  networkMode: NetworkMode;
  /** Last finished P2P attempt for the settings path card. Cancelled attempts are ignored. */
  lastP2PAttempt: FinishedP2PAttemptObservation | null;
  /** A user-requested transport change is negotiating or reconnecting. */
  transportSwitching: boolean;
  refreshBusy: boolean;
  snapshotPending: boolean;
  /** When the last Snapshot landed, so a pane change can pull status forward. */
  snapshotAt: number;
  paneReadBusy: boolean;
  paneReadPending: boolean;
  /** Terminal is pinned to the newest row; cleared when the reader scrolls up. */
  paneFollow: boolean;
  paneUnread: boolean;
  agentTraceItems: AgentTraceItem[];
  agentTraceNext: string | null;
  agentTraceBusy: boolean;
  agentTraceNote: string;
  agentTraceSig: string;
  agentTraceLoadState: AgentTraceLoadState;
  agentTraceTail: number;
  /** User bubble shown before the transcript has caught up. */
  agentTracePending: string;
  /** Pin the stream to the newest turn unless the reader scrolls up. */
  agentTraceFollow: boolean;
  /** True when the transcript advanced while the reader was scrolled up. */
  agentTraceUnread: boolean;
  /** Index of the terminal row whose action bar is open, or null. */
  paneRow: number | null;
  termWrap: boolean;
  /** pan = keep the selected columns and slide; fit = resize the PTY to the phone. */
  termFit: TermFit;
  termCols: TermCols;
  termSelect: boolean;
  keysExpanded: boolean;
  /** Expanded pad body: terminal keys or slash-command chips. */
  padKind: PadKind;
  listGroup: ListGroup;
  /** true = that grouped heading is collapsed. Missing ids follow first-open. */
  listGroupCollapsed: Record<string, boolean>;
  paneTouched: TouchedAt;
  panePinned: PinnedAt;
  runtimeAgentStatuses: RuntimeAgentStatuses;
  completionSeen: SeenCompletions;
  composeDraft: string;
  composeFocused: boolean;
  composeIME: boolean;
  /** When true, keystrokes go to the PTY immediately instead of waiting for 发送. */
  composeLive: boolean;
  lastHerdSig: string;
  deviceList: DeviceSummary[];
  pushEnabled: boolean | null;
  pushSubscribed: boolean | null;
  settingsLoading: boolean;
  devicesError: string;
  pushConfigError: string;
  settingsRequest: number;
  herdHost: string;
  runtimeKind: string;
  termFontPx: number;
  operationCapabilities: OperationCapabilities;
  agentKinds: string[];
  operationBusy: boolean;
};

export const state: AppState = {
  originProtocol: 2,
  p2pEnabled: false,
  fragment: null,
  notificationTarget: null,
  phase: "boot",
  screen: "home",
  notice: null,
  pairCodeDraft: "",
  pairManualOpen: false,
  pairErrorTarget: null,
  live: null,
  credential: null,
  computers: [],
  lastUsedDaemonId: null,
  addingComputer: false,
  paneId: "",
  fullTerminal: false,
  agentChat: false,
  defaultTermMode: loadDefaultTermMode(),
  paneTermModes: {},
  defaultComposeLive: loadDefaultComposeLive(),
  paneComposeLive: {},
  agents: [],
  paneText: "",
  paneHash: "",
  pairAwaitingApproval: false,
  pairAbort: null,
  networkOnline: navigator.onLine !== false,
  relayRttMs: null,
  sessionTransport: "relay",
  networkMode: loadNetworkMode(),
  lastP2PAttempt: null,
  transportSwitching: false,
  refreshBusy: false,
  snapshotPending: false,
  snapshotAt: 0,
  paneReadBusy: false,
  paneReadPending: false,
  paneFollow: true,
  paneUnread: false,
  agentTraceItems: [],
  agentTraceNext: null,
  agentTraceBusy: false,
  agentTraceNote: "",
  agentTraceSig: "",
  agentTraceLoadState: "cold",
  agentTraceTail: 0,
  agentTracePending: "",
  agentTraceFollow: true,
  agentTraceUnread: false,
  paneRow: null,
  termWrap: loadTermWrap(),
  termFit: loadTermFit(),
  termCols: loadTermCols(),
  termSelect: false,
  keysExpanded: loadKeysExpanded(),
  padKind: loadPadKind(),
  listGroup: loadListGroup(),
  listGroupCollapsed: {},
  paneTouched: {},
  panePinned: {},
  runtimeAgentStatuses: {},
  completionSeen: {},
  composeDraft: "",
  composeFocused: false,
  composeIME: false,
  composeLive: loadDefaultComposeLive(),
  lastHerdSig: "",
  deviceList: [],
  pushEnabled: null,
  pushSubscribed: null,
  settingsLoading: false,
  devicesError: "",
  pushConfigError: "",
  settingsRequest: 0,
  herdHost: "",
  runtimeKind: "",
  termFontPx: loadTermFont(),
  operationCapabilities: { ...NO_OPERATION_CAPABILITIES },
  agentKinds: [],
  operationBusy: false,
};

export function saveListGroup(): void {
  try {
    localStorage.setItem(LIST_GROUP_KEY, state.listGroup);
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function paneTouchedKey(): string {
  return `${PANE_TOUCHED_KEY}:${state.credential?.daemonId || "anon"}`;
}

export function loadPaneTouched(): TouchedAt {
  try {
    const raw = JSON.parse(localStorage.getItem(paneTouchedKey()) || "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: TouchedAt = {};
    for (const [paneId, stamp] of Object.entries(raw as Record<string, unknown>)) {
      if (paneId && typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0) out[paneId] = stamp;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePaneTouched(): void {
  try {
    localStorage.setItem(paneTouchedKey(), JSON.stringify(state.paneTouched));
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function rememberPane(paneId: string): void {
  state.paneTouched = touchPane(state.paneTouched, paneId);
  savePaneTouched();
}

function panePinnedKey(): string {
  return `${PANE_PINNED_KEY}:${state.credential?.daemonId || "anon"}`;
}

export function loadPanePinned(): PinnedAt {
  try {
    return parsePinnedAt(JSON.parse(localStorage.getItem(panePinnedKey()) || "{}") as unknown);
  } catch {
    return {};
  }
}

export function savePanePinned(): void {
  try {
    localStorage.setItem(panePinnedKey(), JSON.stringify(state.panePinned));
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function togglePanePin(paneId: string): void {
  state.panePinned = togglePinnedAt(state.panePinned, paneId);
  savePanePinned();
}

function paneTermModeKey(): string {
  return `${PANE_TERM_MODE_KEY}:${state.credential?.daemonId || "anon"}`;
}

export function loadPaneTermModes(): Record<string, TermMode> {
  try {
    const raw = JSON.parse(localStorage.getItem(paneTermModeKey()) || "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, TermMode> = {};
    for (const [paneId, mode] of Object.entries(raw as Record<string, unknown>)) {
      if (paneId && TERM_MODE_OPTIONS.includes(mode as TermMode)) out[paneId] = mode as TermMode;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePaneTermModes(): void {
  try {
    localStorage.setItem(paneTermModeKey(), JSON.stringify(state.paneTermModes));
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function paneTermMode(paneId: string): TermMode {
  if (!paneId) return state.defaultTermMode;
  return parseTermMode(state.paneTermModes[paneId], state.defaultTermMode);
}

export function setPaneTermMode(paneId: string, mode: TermMode): void {
  if (!paneId) return;
  if (state.paneTermModes[paneId] === mode) return;
  state.paneTermModes = { ...state.paneTermModes, [paneId]: mode };
  savePaneTermModes();
}

function paneComposeLiveKey(): string {
  return `${PANE_COMPOSE_LIVE_KEY}:${state.credential?.daemonId || "anon"}`;
}

export function loadPaneComposeLive(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(paneComposeLiveKey()) || "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, boolean> = {};
    for (const [paneId, live] of Object.entries(raw as Record<string, unknown>)) {
      if (paneId && typeof live === "boolean") out[paneId] = live;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePaneComposeLive(): void {
  try {
    localStorage.setItem(paneComposeLiveKey(), JSON.stringify(state.paneComposeLive));
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function paneComposeLive(paneId: string): boolean {
  if (!paneId) return state.defaultComposeLive;
  return Object.prototype.hasOwnProperty.call(state.paneComposeLive, paneId)
    ? state.paneComposeLive[paneId]
    : state.defaultComposeLive;
}

export function setPaneComposeLive(paneId: string, live: boolean): void {
  if (!paneId || state.paneComposeLive[paneId] === live) return;
  state.paneComposeLive = { ...state.paneComposeLive, [paneId]: live };
  savePaneComposeLive();
}

export function saveDefaultTermMode(): void {
  try {
    localStorage.setItem(DEFAULT_TERM_MODE_KEY, state.defaultTermMode);
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function setDefaultTermMode(mode: TermMode): void {
  if (state.defaultTermMode === mode) return;
  state.defaultTermMode = mode;
  saveDefaultTermMode();
}

export function setNetworkMode(mode: NetworkMode): void {
  if (state.networkMode === mode) return;
  state.networkMode = mode;
  persistNetworkMode(mode);
}

function prunePaneTermModes(): void {
  if (!state.agents.length) return;
  const live = new Set(state.agents.map((agent) => agent.paneId));
  let changed = false;
  const next: Record<string, TermMode> = {};
  for (const [paneId, mode] of Object.entries(state.paneTermModes)) {
    if ((mode === "guided" || mode === "full" || mode === "agent") && live.has(paneId)) next[paneId] = mode;
    else changed = true;
  }
  if (!changed) return;
  state.paneTermModes = next;
  savePaneTermModes();
}

function prunePaneComposeLive(): void {
  if (!state.agents.length) return;
  const panes = new Set(state.agents.map((agent) => agent.paneId));
  let changed = false;
  const next: Record<string, boolean> = {};
  for (const [paneId, live] of Object.entries(state.paneComposeLive)) {
    if (panes.has(paneId)) next[paneId] = live;
    else changed = true;
  }
  if (!changed) return;
  state.paneComposeLive = next;
  savePaneComposeLive();
}

function completionSeenKey(): string {
  const daemonId = state.credential?.daemonId || "anon";
  const deviceId = state.credential?.deviceId || "anon";
  return `${COMPLETION_SEEN_KEY}:${daemonId}:${deviceId}`;
}

export function loadCompletionSeen(): SeenCompletions {
  try {
    return parseSeenCompletions(localStorage.getItem(completionSeenKey()));
  } catch {
    return {};
  }
}

function saveCompletionSeen(): void {
  try {
    localStorage.setItem(completionSeenKey(), JSON.stringify(state.completionSeen));
  } catch {
    /* storage blocked; completion attention remains correct for this page */
  }
}

export function replaceAgentsFromSnapshot(snapshot: SnapshotWire): DashboardAgentCard[] {
  const previous = state.agents;
  const projected = projectCompletionAttention(
    mapSnapshotAgents(snapshot),
    state.runtimeAgentStatuses,
    state.completionSeen,
  );
  const seenChanged = projected.seen !== state.completionSeen;
  state.agents = projected.agents;
  state.runtimeAgentStatuses = projected.runtimeStatuses;
  state.completionSeen = projected.seen;
  if (seenChanged) saveCompletionSeen();
  prunePaneTermModes();
  prunePaneComposeLive();
  if (state.agents.length) {
    const pinned = prunePinnedAt(
      state.panePinned,
      state.agents.map((agent) => agent.paneId),
    );
    if (pinned !== state.panePinned) {
      state.panePinned = pinned;
      savePanePinned();
    }
  }
  return previous;
}

/** A successful terminal read is the mobile equivalent of viewing the result. */
export function acknowledgePaneCompletion(paneId: string): boolean {
  const seen = markCompletionSeen(state.completionSeen, state.runtimeAgentStatuses, paneId);
  if (seen === state.completionSeen) return false;
  state.completionSeen = seen;
  state.agents = applySeenCompletions(state.agents, seen);
  state.lastHerdSig = herdSignature(state.agents);
  saveCompletionSeen();
  return true;
}

export function markPaneSubmitted(paneId: string): void {
  const projected = projectAgentSubmission(
    state.agents,
    state.runtimeAgentStatuses,
    state.completionSeen,
    paneId,
  );
  if (projected.agents === state.agents) return;
  const seenChanged = projected.seen !== state.completionSeen;
  state.agents = projected.agents;
  state.runtimeAgentStatuses = projected.runtimeStatuses;
  state.completionSeen = projected.seen;
  state.lastHerdSig = herdSignature(state.agents);
  if (seenChanged) saveCompletionSeen();
}

export function clampTermFont(px: number): number {
  if (!Number.isFinite(px)) return 12;
  return Math.min(TERM_FONT_MAX, Math.max(TERM_FONT_MIN, Math.round(px)));
}

export function termLineHeightPx(fontPx: number): number {
  return Math.max(fontPx + 2, Math.ceil(fontPx * 1.5));
}

export function saveTermFont(): void {
  try {
    localStorage.setItem(TERM_FONT_KEY, String(state.termFontPx));
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function saveTermWrap(): void {
  try {
    localStorage.setItem(TERM_WRAP_KEY, state.termWrap ? "1" : "0");
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function saveTermFit(): void {
  try {
    localStorage.setItem(TERM_FIT_KEY, state.termFit);
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function saveTermCols(): void {
  try {
    localStorage.setItem(TERM_COLS_KEY, String(state.termCols));
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function saveKeysExpanded(): void {
  try {
    localStorage.setItem(KEYS_EXPANDED_KEY, state.keysExpanded ? "1" : "0");
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function savePadKind(): void {
  try {
    localStorage.setItem(PAD_KIND_KEY, state.padKind);
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function saveDefaultComposeLive(): void {
  try {
    localStorage.setItem(DEFAULT_COMPOSE_LIVE_KEY, state.defaultComposeLive ? "1" : "0");
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export function setDefaultComposeLive(live: boolean): void {
  if (state.defaultComposeLive === live) return;
  state.defaultComposeLive = live;
  saveDefaultComposeLive();
}

/** Reset every per-pane view mode. Called whenever the open pane changes. */
export function resetPaneView(): void {
  state.paneText = "";
  state.paneHash = "";
  state.composeDraft = "";
  state.composeFocused = false;
  state.composeIME = false;
  state.paneFollow = true;
  state.paneUnread = false;
  state.paneRow = null;
  state.termSelect = false;
  state.fullTerminal = false;
  state.agentChat = false;
  state.agentTraceItems = [];
  state.agentTraceNext = null;
  state.agentTraceBusy = false;
  state.agentTraceNote = "";
  state.agentTraceSig = "";
  state.agentTraceLoadState = "cold";
  state.agentTraceTail = 0;
  state.agentTracePending = "";
  state.agentTraceFollow = true;
  state.agentTraceUnread = false;
  // keysExpanded / padKind stay: they are keypad preferences, not per-pane view
  // modes. Collapsing on every switch put Ctrl+C and 换行 two taps away.
}

export function haptic(ms = 10): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}

export function wsURL(query?: { daemonId?: string; pairTicket?: string }): string {
  return clientWsURL(state.originProtocol, location, query);
}

export const {
  captureNoticeScope,
  noticeScopeIsCurrent,
  visibleNotice,
  clearNotice,
  clearNoticeForScope,
  showError,
  showStatus,
} = createNoticeLifecycle(state, app);

export function selectedAgent(): DashboardAgentCard | undefined {
  return state.agents.find((agent) => agent.paneId === state.paneId);
}

export function capturePairingFragment(): void {
  const initialHash = location.hash;
  if (initialHash) history.replaceState(null, "", `${location.pathname}${location.search}`);
  state.notificationTarget = parseNotificationTarget(initialHash);
  state.fragment = state.notificationTarget ? null : parsePairingFragment(initialHash);
  state.pairCodeDraft = state.fragment?.code || "";
}
