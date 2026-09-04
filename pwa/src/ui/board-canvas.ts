import { agentTitle, statusLabel } from "../lib/dashboard";
import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import {
  BOARD_CELL_H,
  BOARD_CELL_W,
  clampBoardScale,
  fitBoardCamera,
  layoutForTab,
  numberDuplicateTitles,
  paneBoxes,
  paneCellGrid,
  type PaneBox,
  type TabLayout,
} from "../lib/layout";
import { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS, TERMINAL_MIN_COLS, TERMINAL_MIN_ROWS } from "../lib/protocol/terminal";
import { openPane } from "../live";
import { state } from "../state";
import { focusCompose } from "./session-view";
import {
  BOARD_DOUBLE_TAP_MS,
  BOARD_GESTURE_SLOP_PX,
  boardDoubleTap,
  boardDragMode,
  boardScrollLines,
} from "./board-gesture";
import { boardPreviewText, fillAnsiPreview, fitBoardPreviews, refreshBoardPanePreview } from "./board-preview";
import { guidedScrollController } from "./session/guided-scroll";

function applyTransform(stage: HTMLElement): void {
  stage.style.transform = `translate(${state.boardPanX}px, ${state.boardPanY}px) scale(${state.boardScale})`;
}

function stageSize(layout: TabLayout): { width: number; height: number } {
  return {
    width: Math.max(120, layout.area.width * BOARD_CELL_W),
    height: Math.max(80, layout.area.height * BOARD_CELL_H),
  };
}

function placeStage(viewport: HTMLElement, stage: HTMLElement, layout: TabLayout): void {
  const size = stageSize(layout);
  const camera = fitBoardCamera(
    viewport.clientWidth,
    viewport.clientHeight,
    size.width,
    size.height,
  );
  state.boardScale = camera.scale;
  state.boardPanX = camera.panX;
  state.boardPanY = camera.panY;
  state.boardFitted = true;
  applyTransform(stage);
}

function zoomAt(viewport: HTMLElement, stage: HTMLElement, clientX: number, clientY: number, nextScale: number): void {
  const prev = state.boardScale;
  const scale = clampBoardScale(nextScale);
  if (scale === prev) return;
  const rect = viewport.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const sx = (x - state.boardPanX) / prev;
  const sy = (y - state.boardPanY) / prev;
  state.boardScale = scale;
  state.boardPanX = x - sx * scale;
  state.boardPanY = y - sy * scale;
  applyTransform(stage);
}

let pendingOpenTimer = 0;
let pendingOpenPane = "";
let pendingOpenAt = 0;

function clearPendingBoardOpen(): void {
  if (pendingOpenTimer) window.clearTimeout(pendingOpenTimer);
  pendingOpenTimer = 0;
  pendingOpenPane = "";
  pendingOpenAt = 0;
}

function openBoardPane(paneId: string): void {
  clearPendingBoardOpen();
  if (!paneId) return;
  state.boardReturn = true;
  void openPane(paneId).then(() => {
    focusCompose();
    if (!document.querySelector(".full-terminal-compose-input, .dock-form textarea")) {
      requestAnimationFrame(() => focusCompose());
    }
  });
}

function scheduleBoardPaneOpen(paneId: string): void {
  if (!paneId) return;
  const now = Date.now();
  if (boardDoubleTap(pendingOpenPane, pendingOpenAt, paneId, now)) {
    openBoardPane(paneId);
    return;
  }
  clearPendingBoardOpen();
  pendingOpenPane = paneId;
  pendingOpenAt = now;
  pendingOpenTimer = window.setTimeout(() => {
    pendingOpenTimer = 0;
    const id = pendingOpenPane;
    pendingOpenPane = "";
    pendingOpenAt = 0;
    if (id) openBoardPane(id);
  }, BOARD_DOUBLE_TAP_MS);
}

function paneTile(box: PaneBox, layout: TabLayout, titles: Record<string, string>): HTMLElement {
  const agent = state.agents.find((item) => item.paneId === box.paneId);
  const selected = box.paneId === state.paneId;
  const title = titles[box.paneId] || box.paneId;
  const tile = button("", `board-pane status-${agent?.status || "idle"}${selected ? " sel" : ""}${box.focused ? " focused" : ""}`);
  tile.dataset.paneId = box.paneId;
  tile.style.left = `${box.left * 100}%`;
  tile.style.top = `${box.top * 100}%`;
  tile.style.width = `${box.width * 100}%`;
  tile.style.height = `${box.height * 100}%`;
  tile.setAttribute("aria-label", t("board.paneAria", { title }));
  const head = node("span", "board-pane-head");
  head.append(node("span", `agent-dot agent-${agent?.status || "idle"}`), node("span", "board-pane-name", title));
  const status = agent ? statusLabel(agent.status) : "";
  if (status) head.append(node("span", `pill pill-${agent?.status || "idle"}`, status));
  if (layout.zoomed && (box.focused || box.paneId === layout.focusedPaneId)) {
    head.append(node("span", "board-pane-zoom", t("board.zoomed")));
  }
  const screen = node("span", "board-pane-screen");
  screen.setAttribute("aria-hidden", "true");
  const pane = layout.panes.find((item) => item.paneId === box.paneId);
  fillAnsiPreview(screen, boardPreviewText(box.paneId), Math.round(pane?.rect.width || 0), Math.round(pane?.rect.height || 0));
  tile.append(head, screen);
  tile.addEventListener("click", (event) => {
    event.preventDefault();
    scheduleBoardPaneOpen(box.paneId);
  });
  tile.addEventListener("dblclick", (event) => {
    event.preventDefault();
    openBoardPane(box.paneId);
  });
  return tile;
}

export function fillBoardCanvas(host: HTMLElement): void {
  const viewport = node("div", "board-canvas");
  viewport.setAttribute("role", "application");
  viewport.setAttribute("aria-label", t("board.canvasAria"));
  const layout = layoutForTab(state.boardTabId, state.layouts, state.agents);
  if (!layout) {
    viewport.append(node("p", "empty-sub", t("board.empty")));
    host.append(viewport);
    return;
  }
  const size = stageSize(layout);
  const stage = node("div", "board-stage");
  stage.style.width = `${size.width}px`;
  stage.style.height = `${size.height}px`;
  const boxes = paneBoxes(layout);
  const titles = numberDuplicateTitles(
    boxes.map((box) => {
      const agent = state.agents.find((item) => item.paneId === box.paneId);
      return {
        id: box.paneId,
        title: agent ? agentTitle(agent, "flat") : box.paneId,
        cwd: agent?.cwd || "",
      };
    }),
  );
  for (const box of boxes) stage.append(paneTile(box, layout, titles));
  viewport.append(stage);
  bindCanvas(viewport, stage, layout);
  host.append(viewport);
}

function paneIdFromEvent(event: Event): string {
  const node = event.target instanceof Element ? event.target.closest(".board-pane") : null;
  return node instanceof HTMLElement ? node.dataset.paneId || "" : "";
}

function paneGrid(layout: TabLayout, paneId: string): { cols: number; rows: number } {
  const agent = state.agents.find((item) => item.paneId === paneId);
  const grid = paneCellGrid(paneId, layout, agent?.viewportRows);
  return {
    cols: Math.min(TERMINAL_MAX_COLS, Math.max(TERMINAL_MIN_COLS, grid?.cols || 80)),
    rows: Math.min(TERMINAL_MAX_ROWS, Math.max(TERMINAL_MIN_ROWS, grid?.rows || 24)),
  };
}

function scrollBoardPane(layout: TabLayout, paneId: string, direction: "up" | "down", lines: number): void {
  const session = state.live;
  if (!session?.isConnected() || !paneId || lines < 1) return;
  const grid = paneGrid(layout, paneId);
  void guidedScrollController.scroll({ session, paneId, cols: grid.cols, rows: grid.rows }, direction, lines).then(
    (ok) => {
      if (ok) schedulePanePreview(paneId);
    },
    () => undefined,
  );
}

let previewTimer: number | null = null;
let previewPane = "";

function schedulePanePreview(paneId: string): void {
  previewPane = paneId;
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    previewTimer = null;
    const id = previewPane;
    previewPane = "";
    if (id) void refreshBoardPanePreview(id);
  }, 120);
}

export function releaseBoardScroll(): void {
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  previewTimer = null;
  previewPane = "";
  clearPendingBoardOpen();
  guidedScrollController.dispose();
}

function bindCanvas(viewport: HTMLElement, stage: HTMLElement, layout: TabLayout): void {
  applyTransform(stage);
  requestAnimationFrame(() => {
    if (!viewport.isConnected) return;
    if (!state.boardFitted) placeStage(viewport, stage, layout);
    fitBoardPreviews(viewport);
  });
  let pointers = new Map<number, { x: number; y: number }>();
  let origin = { x: 0, y: 0 };
  let hitPane = "";
  let mode: "undecided" | "pan" | "scroll" | "pinch" = "undecided";
  let moved = false;
  let pinch = 0;
  let scrollRemainder = 0;
  const point = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY });
  viewport.addEventListener("pointerdown", (event) => {
    const next = point(event);
    pointers.set(event.pointerId, next);
    origin = next;
    hitPane = paneIdFromEvent(event);
    moved = false;
    mode = "undecided";
    scrollRemainder = 0;
    try {
      viewport.setPointerCapture(event.pointerId);
    } catch {
      /* jsdom/happy-dom may not implement capture */
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
      mode = "pinch";
      hitPane = "";
    }
    if (event.pointerType === "touch" || event.pointerType === "pen") event.preventDefault();
  }, { capture: true, passive: false });
  viewport.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    const prev = pointers.get(event.pointerId)!;
    const next = point(event);
    pointers.set(event.pointerId, next);
    if (pointers.size === 2) {
      mode = "pinch";
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0 && dist > 0) {
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        zoomAt(viewport, stage, midX, midY, state.boardScale * (dist / pinch));
        pinch = dist;
        moved = true;
      }
      event.preventDefault();
      return;
    }
    const fromOriginX = next.x - origin.x;
    const fromOriginY = next.y - origin.y;
    if (mode === "undecided") {
      if (Math.hypot(fromOriginX, fromOriginY) < BOARD_GESTURE_SLOP_PX) return;
      mode = boardDragMode(fromOriginX, fromOriginY, hitPane);
      moved = true;
      event.preventDefault();
      if (mode === "pan") {
        state.boardPanX += fromOriginX;
        state.boardPanY += fromOriginY;
        applyTransform(stage);
      } else {
        const stepped = boardScrollLines(0, fromOriginY);
        scrollRemainder = stepped.remainder;
        if (stepped.lines) scrollBoardPane(layout, hitPane, stepped.direction, stepped.lines);
      }
      return;
    }
    if (mode === "pan") {
      moved = true;
      event.preventDefault();
      state.boardPanX += next.x - prev.x;
      state.boardPanY += next.y - prev.y;
      applyTransform(stage);
      return;
    }
    if (mode !== "scroll") return;
    moved = true;
    event.preventDefault();
    const stepped = boardScrollLines(scrollRemainder, next.y - prev.y);
    scrollRemainder = stepped.remainder;
    if (stepped.lines) scrollBoardPane(layout, hitPane, stepped.direction, stepped.lines);
  }, { capture: true, passive: false });
  const end = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (pointers.size === 0) {
      if (!moved && hitPane) {
        for (const tile of viewport.querySelectorAll<HTMLButtonElement>(".board-pane")) {
          if (tile.dataset.paneId !== hitPane) continue;
          tile.click();
          break;
        }
      }
      if (mode === "scroll" && hitPane) schedulePanePreview(hitPane);
      mode = "undecided";
    }
    if (moved) event.preventDefault();
  };
  viewport.addEventListener("pointerup", end, true);
  viewport.addEventListener("pointercancel", end, true);
  viewport.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
        zoomAt(viewport, stage, event.clientX, event.clientY, state.boardScale * factor);
        return;
      }
      const paneId = paneIdFromEvent(event);
      if (paneId) {
        event.preventDefault();
        const stepped = boardScrollLines(scrollRemainder, -event.deltaY);
        scrollRemainder = stepped.remainder;
        if (stepped.lines) scrollBoardPane(layout, paneId, stepped.direction, stepped.lines);
        return;
      }
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
      zoomAt(viewport, stage, event.clientX, event.clientY, state.boardScale * factor);
    },
    { passive: false },
  );
  viewport.addEventListener(
    "click",
    (event) => {
      if (!moved) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
}

export function fitCurrentBoard(): void {
  const viewport = document.querySelector<HTMLElement>(".board-canvas");
  const stage = document.querySelector<HTMLElement>(".board-stage");
  const layout = layoutForTab(state.boardTabId, state.layouts, state.agents);
  if (!viewport || !stage || !layout) return;
  placeStage(viewport, stage, layout);
}

export function nudgeBoardZoom(direction: 1 | -1): void {
  const viewport = document.querySelector<HTMLElement>(".board-canvas");
  const stage = document.querySelector<HTMLElement>(".board-stage");
  if (!viewport || !stage) return;
  const rect = viewport.getBoundingClientRect();
  zoomAt(viewport, stage, rect.left + rect.width / 2, rect.top + rect.height / 2, state.boardScale * (direction > 0 ? 1.2 : 1 / 1.2));
}
