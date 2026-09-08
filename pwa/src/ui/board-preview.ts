import { parseAnsi, type StyledLine } from "../lib/ansi";
import { BOARD_CELL_H, BOARD_CELL_W, layoutForTab, type TabLayout } from "../lib/layout";
import type { LiveSession } from "../lib/protocol/client";
import { state } from "../state";

export const BOARD_PREVIEW_MAX_PANES = 8;
export const BOARD_PREVIEW_MIN_LINES = 8;
export const BOARD_PREVIEW_MAX_LINES = 80;

type Preview = { text: string; hash: string };

const previews = new Map<string, Preview>();
let generation = 0;
let tail: Promise<void> = Promise.resolve();
let previewRevision = 0;
const previewListeners = new Set<() => void>();

export function boardPreviewRevision(): number {
  return previewRevision;
}

export function subscribeBoardPreviews(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}

function notifyBoardPreviews(): void {
  previewRevision += 1;
  for (const listener of previewListeners) listener();
}

export function boardPreviewText(paneId: string): string {
  return previews.get(paneId)?.text || "";
}

export function boardPreviewSnapshot(paneId: string): Readonly<Preview> | undefined {
  return previews.get(paneId);
}

export function clearBoardPreviews(): void {
  generation += 1;
  previews.clear();
  notifyBoardPreviews();
}

export function previewLineCount(rows?: number, cellHeight?: number): number {
  const n = rows && rows >= BOARD_PREVIEW_MIN_LINES ? rows : cellHeight;
  if (!n || !Number.isFinite(n)) return 24;
  return Math.min(BOARD_PREVIEW_MAX_LINES, Math.max(BOARD_PREVIEW_MIN_LINES, Math.round(n)));
}

export function boardPreviewPaneIds(layout: TabLayout | null): string[] {
  if (!layout) return [];
  const ids = layout.panes.map((pane) => pane.paneId).filter(Boolean);
  const focused = layout.focusedPaneId;
  if (focused && ids.includes(focused)) {
    return [focused, ...ids.filter((id) => id !== focused)].slice(0, BOARD_PREVIEW_MAX_PANES);
  }
  return ids.slice(0, BOARD_PREVIEW_MAX_PANES);
}

export function previewGridPx(cols: number, rows: number): { width: number; height: number } {
  return {
    width: Math.max(0, Math.round(cols) * BOARD_CELL_W),
    height: Math.max(0, Math.round(rows) * BOARD_CELL_H),
  };
}

function padPreviewRows(lines: StyledLine[], rows: number): StyledLine[] {
  const n = Math.max(0, Math.round(rows));
  if (!n) return lines;
  const out = lines.slice(0, n);
  while (out.length < n) out.push({ text: "", spans: [] });
  return out;
}

export function ansiPreviewModel(text: string, cols = 0, rows = 0): { lines: StyledLine[]; width: number; height: number } {
  const parsed = parseAnsi(text);
  const live = parsed.length ? parsed : [{ text: "", spans: [] }];
  const lines = rows > 0 ? padPreviewRows(live, rows) : live;
  const grid = cols > 0 && rows > 0 ? previewGridPx(cols, rows) : { width: 0, height: 0 };
  return { lines, width: grid.width, height: grid.height };
}

/** Fit the TUI grid into the cell; keep glyph aspect (no X/Y stretch). */
export function previewFillScale(sw: number, sh: number, cw: number, ch: number): { x: number; y: number } {
  if (sw <= 1 || cw <= 1) return { x: 1, y: 1 };
  const byWidth = cw / sw;
  const byHeight = sh > 1 && ch > 1 ? ch / sh : byWidth;
  const scale = Math.min(byWidth, byHeight);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 2) return { x: 1, y: 1 };
  return { x: scale, y: scale };
}

export function applyBoardPreviewFont(host: HTMLElement): void {
  const probe = document.createElement("span");
  probe.textContent = "0000000000";
  probe.style.fontFamily = globalThis.getComputedStyle?.(host).fontFamily || "monospace";
  probe.style.fontSize = "100px";
  probe.style.lineHeight = "1";
  probe.style.whiteSpace = "pre";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  host.append(probe);
  const ch = probe.offsetWidth / 10;
  probe.remove();
  if (ch > 0) host.style.fontSize = `${100 * (BOARD_CELL_W / ch)}px`;
  host.style.lineHeight = `${BOARD_CELL_H}px`;
}

export function fitPreviewBuffer(host: HTMLElement): void {
  const inner = host.querySelector(".board-pane-buffer");
  if (!(inner instanceof HTMLElement)) return;
  inner.style.transform = "";
  const cw = host.clientWidth;
  const ch = host.clientHeight;
  if (cw <= 0 || ch <= 0) return;
  const sw = inner.offsetWidth || inner.scrollWidth;
  const sh = inner.offsetHeight || inner.scrollHeight;
  const scale = previewFillScale(sw, sh, cw, ch);
  inner.style.transform = `scale(${scale.x}, ${scale.y})`;
  inner.style.transformOrigin = "0 0";
}

export async function refreshBoardPanePreview(paneId: string): Promise<void> {
  if (!paneId || state.screen !== "board") return;
  const session = state.live;
  if (!session?.isConnected() || !state.networkOnline || document.visibilityState === "hidden") return;
  const layout = layoutForTab(state.boardTabId, state.layouts, state.agents);
  const pane = layout?.panes.find((item) => item.paneId === paneId);
  if (!pane) return;
  const agent = state.agents.find((item) => item.paneId === paneId);
  try {
    await readOne(session, paneId, previewLineCount(agent?.viewportRows, pane.rect.height));
  } catch {
    /* a missed thumbnail is retried by the board poll */
  }
}

async function readOne(session: LiveSession, paneId: string, lines: number, token = generation): Promise<void> {
  const read = await session.paneRead(paneId, lines);
  // A late reply must not repopulate a cleared cache or notify another session.
  if (token !== generation || state.live !== session || state.screen !== "board") return;
  const text = typeof read?.text === "string" ? read.text : "";
  const hash = typeof read?.hash === "string" ? read.hash : "";
  const prev = previews.get(paneId);
  if (prev && hash && prev.hash === hash && prev.text === text) return;
  previews.set(paneId, { text, hash });
  notifyBoardPreviews();
}

async function runBoardPreviews(token: number): Promise<void> {
  if (token !== generation || state.screen !== "board") return;
  const session = state.live;
  if (!session?.isConnected() || !state.networkOnline || document.visibilityState === "hidden") return;
  const layout = layoutForTab(state.boardTabId, state.layouts, state.agents);
  const ids = boardPreviewPaneIds(layout);
  const live = new Set(state.agents.map((agent) => agent.paneId));
  for (const paneId of [...previews.keys()]) {
    if (!live.has(paneId)) previews.delete(paneId);
  }
  for (const paneId of ids) {
    if (token !== generation || state.screen !== "board" || state.live !== session) return;
    const pane = layout?.panes.find((item) => item.paneId === paneId);
    const agent = state.agents.find((item) => item.paneId === paneId);
    const lines = previewLineCount(agent?.viewportRows, pane?.rect.height);
    try {
      await readOne(session, paneId, lines, token);
    } catch {
      continue;
    }
  }
}

/** Serial pane.read of the visible tab. Later calls supersede an in-flight pass. */
export function refreshBoardPreviews(): Promise<void> {
  const token = ++generation;
  const next = tail.then(
    () => runBoardPreviews(token),
    () => runBoardPreviews(token),
  );
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
