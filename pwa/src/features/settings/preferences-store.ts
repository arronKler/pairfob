import { parseListGroup, parsePinnedAt, prunePinnedAt, togglePinnedAt, touchPane, nextTouchedAt,
  type AgentCard, type ListGroup, type PinnedAt, type TouchedAt } from "../../lib/ranking";
import { parseTermMode, TERM_MODE_OPTIONS, type TermMode } from "../../lib/terminal-mode";
import { batch, createDomain, detach } from "../../shared/model/domain-store";
import type { DomainEnvironment } from "../../shared/model/domain-environment";
import { daemonId as connectedDaemonId } from "../computers/catalog-store";

/**
 * Preferences domain: device-local choices about how a terminal, a list or an
 * input pad looks and behaves.
 *
 * The record starts from pure defaults; the browser boot lifecycle hydrates it
 * from storage and the responsive layout through `hydratePreferences`, so this
 * module imports without `window`, `localStorage` or `navigator`.
 *
 * Every daemon-scoped map persists under the connected computer's key, and each
 * setter writes storage inside the same batch as the record change: a subscriber
 * must never run between the two, or it could persist another computer's map
 * under this one's key.
 */
export const TERM_FONT_KEY = "pairfob:termFont";
export const TERM_WRAP_KEY = "pairfob:termWrap";
export const TERM_FIT_KEY = "pairfob:termFit";
export const TERM_COLS_KEY = "pairfob:termCols";
export const KEYS_EXPANDED_KEY = "pairfob:keysExpanded";
export const PAD_KIND_KEY = "pairfob:padKind";
export const DEFAULT_COMPOSE_LIVE_KEY = "pairfob:defaultComposeLive";
export const PANE_COMPOSE_LIVE_KEY = "pairfob:paneComposeLive";
export const LIST_GROUP_KEY = "pairfob:listGroup";
export const PANE_TOUCHED_KEY = "pairfob:paneTouched";
export const PANE_PINNED_KEY = "pairfob:panePinned";
export const PANE_TERM_MODE_KEY = "pairfob:paneTermMode";
export const DEFAULT_TERM_MODE_KEY = "pairfob:defaultTermMode";

export type TermFit = "pan" | "fit";
export const TERM_COL_PRESETS = [80, 100, 120] as const;
export type TermCols = (typeof TERM_COL_PRESETS)[number];
export type PadKind = "keys" | "slash";

export const TERM_FONT_MIN = 9;
export const TERM_FONT_MAX = 22;

/** Phone default; the boot hydration raises it on a wide layout. */
export const DEFAULT_TERM_FONT_PX = 12;
export const DESK_TERM_FONT_PX = 13;

export type PreferencesRecord = {
  termFontPx: number;
  termWrap: boolean;
  /** pan = keep the selected columns and slide; fit = resize the PTY to the phone. */
  termFit: TermFit;
  termCols: TermCols;
  keysExpanded: boolean;
  /** Expanded pad body: terminal keys or slash-command chips. */
  padKind: PadKind;
  listGroup: ListGroup;
  /** true = that grouped heading is collapsed. Missing ids follow first-open. */
  listGroupCollapsed: Record<string, boolean>;
  paneTouched: TouchedAt;
  panePinned: PinnedAt;
  /** Fallback preference when a pane has no stored mode of its own. */
  defaultTermMode: TermMode;
  /** Per-pane mode preference. Missing ids use `defaultTermMode`. */
  paneTermModes: Record<string, TermMode>;
  /** Default input behavior for panes without their own choice. */
  defaultComposeLive: boolean;
  /** Per-pane live/compose choice, scoped by the connected daemon in storage. */
  paneComposeLive: Record<string, boolean>;
};

/** Guarded storage read for call-time loaders (a session opening, not an import). */
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}

export type StoredValueReader = (key: string) => string | null;

function parseJSON(raw: string | null): unknown {
  try {
    return JSON.parse(raw || "{}") as unknown;
  } catch {
    return {};
  }
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function loadListGroup(read: StoredValueReader = readStorage): ListGroup {
  return parseListGroup(read(LIST_GROUP_KEY));
}

export function loadTermFont(read: StoredValueReader = readStorage, desk = false): number {
  const raw = Number(read(TERM_FONT_KEY));
  if (Number.isFinite(raw) && raw >= TERM_FONT_MIN && raw <= TERM_FONT_MAX) return Math.round(raw);
  return desk ? DESK_TERM_FONT_PX : DEFAULT_TERM_FONT_PX;
}

export function loadTermWrap(read: StoredValueReader = readStorage): boolean {
  return read(TERM_WRAP_KEY) === "1";
}

export function loadTermFit(read: StoredValueReader = readStorage): TermFit {
  return read(TERM_FIT_KEY) === "fit" ? "fit" : "pan";
}

export function loadTermCols(read: StoredValueReader = readStorage): TermCols {
  const raw = Number(read(TERM_COLS_KEY));
  if (TERM_COL_PRESETS.includes(raw as TermCols)) return raw as TermCols;
  return 80;
}

export function loadKeysExpanded(read: StoredValueReader = readStorage): boolean {
  return read(KEYS_EXPANDED_KEY) === "1";
}

export function loadPadKind(read: StoredValueReader = readStorage): PadKind {
  return read(PAD_KIND_KEY) === "slash" ? "slash" : "keys";
}

export function loadDefaultComposeLive(read: StoredValueReader = readStorage): boolean {
  return read(DEFAULT_COMPOSE_LIVE_KEY) === "1";
}

export function loadDefaultTermMode(read: StoredValueReader = readStorage): TermMode {
  return parseTermMode(read(DEFAULT_TERM_MODE_KEY));
}

export function loadPaneTouched(read: StoredValueReader = readStorage): TouchedAt {
  const raw = parseJSON(read(paneTouchedKey()));
  if (!isRecordObject(raw)) return {};
  const out: TouchedAt = {};
  for (const [paneId, stamp] of Object.entries(raw)) {
    if (paneId && typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0) out[paneId] = stamp;
  }
  return out;
}

export function loadPanePinned(read: StoredValueReader = readStorage): PinnedAt {
  return parsePinnedAt(parseJSON(read(panePinnedKey())));
}

export function loadPaneTermModes(read: StoredValueReader = readStorage): Record<string, TermMode> {
  const raw = parseJSON(read(paneTermModeKey()));
  if (!isRecordObject(raw)) return {};
  const out: Record<string, TermMode> = {};
  for (const [paneId, mode] of Object.entries(raw)) {
    if (paneId && TERM_MODE_OPTIONS.includes(mode as TermMode)) out[paneId] = mode as TermMode;
  }
  return out;
}

export function loadPaneComposeLive(read: StoredValueReader = readStorage): Record<string, boolean> {
  const raw = parseJSON(read(paneComposeLiveKey()));
  if (!isRecordObject(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [paneId, live] of Object.entries(raw)) {
    if (paneId && typeof live === "boolean") out[paneId] = live;
  }
  return out;
}

/** Pure defaults: no storage, no layout query, no browser global. */
export function initialPreferences(): PreferencesRecord {
  return {
    termFontPx: DEFAULT_TERM_FONT_PX,
    termWrap: false,
    termFit: "pan",
    termCols: 80,
    keysExpanded: false,
    padKind: "keys",
    listGroup: "flat",
    listGroupCollapsed: {},
    paneTouched: {},
    panePinned: {},
    defaultTermMode: "auto",
    paneTermModes: {},
    defaultComposeLive: false,
    paneComposeLive: {},
  };
}

const preferencesDomain = createDomain<PreferencesRecord>("preferences", initialPreferences());
export const preferencesStore = preferencesDomain.store;
const { read, write } = preferencesDomain.controller;

/**
 * Adopt the stored choices and the boot layout once, from the browser boot
 * lifecycle. One write, one publish, before the first mount.
 */
export function hydratePreferences(environment: DomainEnvironment): void {
  const { read: stored, desk } = environment;
  write((record) => {
    record.termFontPx = loadTermFont(stored, desk);
    record.termWrap = loadTermWrap(stored);
    record.termFit = loadTermFit(stored);
    record.termCols = loadTermCols(stored);
    record.keysExpanded = loadKeysExpanded(stored);
    record.padKind = loadPadKind(stored);
    record.listGroup = loadListGroup(stored);
    record.defaultTermMode = loadDefaultTermMode(stored);
    record.defaultComposeLive = loadDefaultComposeLive(stored);
  });
}

/** Per-daemon storage keys: a choice about one computer never leaks to another. */
function daemonScope(): string {
  return connectedDaemonId();
}

export function paneTouchedKey(): string {
  return `${PANE_TOUCHED_KEY}:${daemonScope()}`;
}

function panePinnedKey(): string {
  return `${PANE_PINNED_KEY}:${daemonScope()}`;
}

function paneTermModeKey(): string {
  return `${PANE_TERM_MODE_KEY}:${daemonScope()}`;
}

function paneComposeLiveKey(): string {
  return `${PANE_COMPOSE_LIVE_KEY}:${daemonScope()}`;
}

/** Reload every daemon-scoped map after the credential changes. */
export function adoptDaemonPreferences(): void {
  write((record) => {
    record.paneTouched = loadPaneTouched();
    record.panePinned = loadPanePinned();
    record.paneTermModes = loadPaneTermModes();
    record.paneComposeLive = loadPaneComposeLive();
  });
}

export function defaultTermMode(): TermMode {
  return read().defaultTermMode;
}

export function defaultComposeLive(): boolean {
  return read().defaultComposeLive;
}

export function listGroup(): ListGroup {
  return read().listGroup;
}

/** Detached per-pane touch stamps for ranking; callers cannot edit canonical data. */
export function paneTouched(): TouchedAt {
  return { ...read().paneTouched };
}

/** Detached per-pane pin stamps for ranking; callers cannot edit canonical data. */
export function panePinned(): PinnedAt {
  return { ...read().panePinned };
}

/** Detached accordion state for action-time decisions; React reads the snapshot. */
export function listGroupCollapsed(): Record<string, boolean> {
  return { ...read().listGroupCollapsed };
}

/** Fixture/teardown: clear the herd presentation choices (touches, pins, folds). */
export function resetHerdPresentationChoices(): void {
  write((record) => {
    record.paneTouched = {};
    record.panePinned = {};
    record.listGroupCollapsed = {};
  });
}

export function saveListGroup(): void {
  writeStorage(LIST_GROUP_KEY, read().listGroup);
}

export function setListGroup(group: ListGroup): void {
  if (read().listGroup === group) return;
  batch(() => {
    write((record) => {
      record.listGroup = group;
    });
    saveListGroup();
  });
}

export function setListGroupCollapsed(collapsed: Record<string, boolean>): void {
  if (collapsed === read().listGroupCollapsed) return;
  write((record) => {
    record.listGroupCollapsed = detach(collapsed);
  });
}

export function savePaneTouched(): void {
  writeStorage(paneTouchedKey(), JSON.stringify(read().paneTouched));
}

export function rememberPane(paneId: string): void {
  batch(() => {
    write((record) => {
      record.paneTouched = touchPane(record.paneTouched, paneId);
    });
    savePaneTouched();
  });
}

function sameTouched(left: TouchedAt, right: TouchedAt): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/**
 * Fold herd status transitions into recency. Uses the same `nextTouchedAt`
 * map `rememberPane` writes; never a raw field assign.
 */
export function applyHerdTouches(previous: readonly AgentCard[], next: readonly AgentCard[], now = Date.now()): void {
  const current = read().paneTouched;
  const updated = nextTouchedAt([...previous], [...next], current, now);
  if (sameTouched(updated, current)) return;
  batch(() => {
    write((record) => {
      record.paneTouched = updated;
    });
    savePaneTouched();
  });
}

export function savePanePinned(): void {
  writeStorage(panePinnedKey(), JSON.stringify(read().panePinned));
}

export function togglePanePin(paneId: string): void {
  batch(() => {
    write((record) => {
      record.panePinned = togglePinnedAt(record.panePinned, paneId);
    });
    savePanePinned();
  });
}

/** Forget pins for panes the daemon no longer reports. */
export function prunePanePins(livePaneIds: readonly string[]): void {
  if (!livePaneIds.length) return;
  const pinned = prunePinnedAt(read().panePinned, [...livePaneIds]);
  if (pinned === read().panePinned) return;
  batch(() => {
    write((record) => {
      record.panePinned = pinned;
    });
    savePanePinned();
  });
}

export function savePaneTermModes(): void {
  writeStorage(paneTermModeKey(), JSON.stringify(read().paneTermModes));
}

export function paneTermMode(paneId: string): TermMode {
  if (!paneId) return read().defaultTermMode;
  return parseTermMode(read().paneTermModes[paneId], read().defaultTermMode);
}

export function setPaneTermMode(paneId: string, mode: TermMode): void {
  if (!paneId) return;
  if (read().paneTermModes[paneId] === mode) return;
  batch(() => {
    write((record) => {
      record.paneTermModes = { ...record.paneTermModes, [paneId]: mode };
    });
    savePaneTermModes();
  });
}

export function savePaneComposeLive(): void {
  writeStorage(paneComposeLiveKey(), JSON.stringify(read().paneComposeLive));
}

export function paneComposeLive(paneId: string): boolean {
  const { paneComposeLive: perPane, defaultComposeLive: fallback } = read();
  if (!paneId) return fallback;
  return Object.prototype.hasOwnProperty.call(perPane, paneId) ? perPane[paneId] : fallback;
}

export function setPaneComposeLive(paneId: string, live: boolean): void {
  if (!paneId || read().paneComposeLive[paneId] === live) return;
  batch(() => {
    write((record) => {
      record.paneComposeLive = { ...record.paneComposeLive, [paneId]: live };
    });
    savePaneComposeLive();
  });
}

/** Drop per-pane choices for panes the daemon no longer reports. */
export function prunePanePreferences(livePaneIds: readonly string[]): void {
  if (!livePaneIds.length) return;
  const live = new Set(livePaneIds);
  const modes = read().paneTermModes;
  const compose = read().paneComposeLive;
  let modesChanged = false;
  let composeChanged = false;
  const nextModes: Record<string, TermMode> = {};
  for (const [paneId, mode] of Object.entries(modes)) {
    if ((mode === "guided" || mode === "full" || mode === "agent") && live.has(paneId)) nextModes[paneId] = mode;
    else modesChanged = true;
  }
  const nextCompose: Record<string, boolean> = {};
  for (const [paneId, value] of Object.entries(compose)) {
    if (live.has(paneId)) nextCompose[paneId] = value;
    else composeChanged = true;
  }
  if (!modesChanged && !composeChanged) return;
  batch(() => {
    write((record) => {
      if (modesChanged) record.paneTermModes = nextModes;
      if (composeChanged) record.paneComposeLive = nextCompose;
    });
    if (modesChanged) savePaneTermModes();
    if (composeChanged) savePaneComposeLive();
  });
}

export function saveDefaultTermMode(): void {
  writeStorage(DEFAULT_TERM_MODE_KEY, read().defaultTermMode);
}

export function setDefaultTermMode(mode: TermMode): void {
  if (read().defaultTermMode === mode) return;
  batch(() => {
    write((record) => {
      record.defaultTermMode = mode;
    });
    saveDefaultTermMode();
  });
}

export function saveDefaultComposeLive(): void {
  writeStorage(DEFAULT_COMPOSE_LIVE_KEY, read().defaultComposeLive ? "1" : "0");
}

export function setDefaultComposeLive(live: boolean): void {
  if (read().defaultComposeLive === live) return;
  batch(() => {
    write((record) => {
      record.defaultComposeLive = live;
    });
    saveDefaultComposeLive();
  });
}

export function clampTermFont(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_TERM_FONT_PX;
  return Math.min(TERM_FONT_MAX, Math.max(TERM_FONT_MIN, Math.round(px)));
}

export function termLineHeightPx(fontPx: number): number {
  return Math.max(fontPx + 2, Math.ceil(fontPx * 1.5));
}

export function termFontPx(): number {
  return read().termFontPx;
}

/** Update the live type scale without persisting; pinch settle calls saveTermFont. */
export function setTermFontPx(px: number): void {
  const next = clampTermFont(px);
  if (read().termFontPx === next) return;
  write((record) => {
    record.termFontPx = next;
  });
}

export function termWrap(): boolean {
  return read().termWrap;
}

export function padKind(): PadKind {
  return read().padKind;
}

export function termFit(): TermFit {
  return read().termFit;
}

export function termCols(): TermCols {
  return read().termCols;
}

export function saveTermFont(): void {
  writeStorage(TERM_FONT_KEY, String(read().termFontPx));
}

export function setTermFont(px: number): void {
  const next = clampTermFont(px);
  if (read().termFontPx === next) return;
  batch(() => {
    write((record) => {
      record.termFontPx = next;
    });
    saveTermFont();
  });
}

export function saveTermWrap(): void {
  writeStorage(TERM_WRAP_KEY, read().termWrap ? "1" : "0");
}

export function setTermWrap(wrap: boolean): void {
  if (read().termWrap === wrap) return;
  batch(() => {
    write((record) => {
      record.termWrap = wrap;
    });
    saveTermWrap();
  });
}

export function saveTermFit(): void {
  writeStorage(TERM_FIT_KEY, read().termFit);
}

export function saveTermCols(): void {
  writeStorage(TERM_COLS_KEY, String(read().termCols));
}

export function setTermGrid(fit: TermFit, cols: TermCols): void {
  if (read().termFit === fit && read().termCols === cols) return;
  batch(() => {
    write((record) => {
      record.termFit = fit;
      record.termCols = cols;
    });
    saveTermFit();
    saveTermCols();
  });
}

export function saveKeysExpanded(): void {
  writeStorage(KEYS_EXPANDED_KEY, read().keysExpanded ? "1" : "0");
}

export function keysExpanded(): boolean {
  return read().keysExpanded;
}

export function setKeysExpanded(expanded: boolean): void {
  if (read().keysExpanded === expanded) return;
  batch(() => {
    write((record) => {
      record.keysExpanded = expanded;
    });
    saveKeysExpanded();
  });
}

export function savePadKind(): void {
  writeStorage(PAD_KIND_KEY, read().padKind);
}

export function setPadKind(kind: PadKind): void {
  if (read().padKind === kind) return;
  batch(() => {
    write((record) => {
      record.padKind = kind;
    });
    savePadKind();
  });
}

/** Test/teardown reset: restore the pure defaults and publish them. */
export function resetPreferences(): void {
  const defaults = initialPreferences();
  write((record) => {
    Object.assign(record, defaults);
  });
}

export { parseTermMode };
export type { ListGroup, PinnedAt, TouchedAt, TermMode };
