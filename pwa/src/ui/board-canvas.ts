import { nextTransition, shareOpening } from "./transition";
import {
  BOARD_CELL_H,
  BOARD_CELL_W,
  clampBoardScale,
  fitBoardCamera,
  layoutForTab,
  paneCellGrid,
  type TabLayout,
} from "../lib/layout";
import { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS, TERMINAL_MIN_COLS, TERMINAL_MIN_ROWS } from "../lib/protocol/terminal";
import { openPane } from "../live";
import { state } from "../state";
import { focusCompose } from "./session-view";
import { BOARD_GESTURE_SLOP_PX, boardDragMode, boardScrollLines } from "./board-gesture";
import { refreshBoardPanePreview } from "./board-preview";
import { guidedScrollController } from "./session/guided-scroll";

export function applyBoardTransform(stage: HTMLElement): void {
  stage.style.transform = `translate(${state.boardPanX}px, ${state.boardPanY}px) scale(${state.boardScale})`;
}

export function boardStageSize(layout: TabLayout): { width: number; height: number } {
  return {
    width: Math.max(120, layout.area.width * BOARD_CELL_W),
    height: Math.max(80, layout.area.height * BOARD_CELL_H),
  };
}

export function placeBoardStage(viewport: HTMLElement, stage: HTMLElement, layout: TabLayout): void {
  const size = boardStageSize(layout);
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
  applyBoardTransform(stage);
}

export function zoomBoardAt(viewport: HTMLElement, stage: HTMLElement, clientX: number, clientY: number, nextScale: number): void {
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
  applyBoardTransform(stage);
}

export function openBoardPane(paneId: string, tile?: HTMLElement): void {
  if (!paneId) return;
  state.boardReturn = true;
  // The tile is the same object as the pane about to fill the screen, so it
  // expands into it instead of the screen sliding in from the side.
  shareOpening(tile);
  nextTransition("expand", paneId);
  void openPane(paneId).then(() => {
    focusCompose();
    if (!document.querySelector(".full-terminal-compose-input, .dock-form textarea")) {
      requestAnimationFrame(() => focusCompose());
    }
  });
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
  guidedScrollController.dispose();
}

export function bindBoardCanvasGestures(viewport: HTMLElement, stage: HTMLElement, layout: TabLayout): () => void {
  let retired = false;
  applyBoardTransform(stage);
  const frame = requestAnimationFrame(() => {
    if (retired || !viewport.isConnected) return;
    if (!state.boardFitted) placeBoardStage(viewport, stage, layout);
  });
  let pointers = new Map<number, { x: number; y: number }>();
  let origin = { x: 0, y: 0 };
  let hitPane = "";
  let mode: "undecided" | "pan" | "scroll" | "pinch" = "undecided";
  let moved = false;
  let pinch = 0;
  let scrollRemainder = 0;
  const point = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY });
  const onDown = (event: PointerEvent) => {
    if (retired) return;
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
  };
  const onMove = (event: PointerEvent) => {
    if (retired || !pointers.has(event.pointerId)) return;
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
        zoomBoardAt(viewport, stage, midX, midY, state.boardScale * (dist / pinch));
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
        applyBoardTransform(stage);
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
      applyBoardTransform(stage);
      return;
    }
    if (mode !== "scroll") return;
    moved = true;
    event.preventDefault();
    const stepped = boardScrollLines(scrollRemainder, next.y - prev.y);
    scrollRemainder = stepped.remainder;
    if (stepped.lines) scrollBoardPane(layout, hitPane, stepped.direction, stepped.lines);
  };
  const end = (event: PointerEvent) => {
    if (retired) return;
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
  const onWheel = (event: WheelEvent) => {
    if (retired) return;
    if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
        zoomBoardAt(viewport, stage, event.clientX, event.clientY, state.boardScale * factor);
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
      zoomBoardAt(viewport, stage, event.clientX, event.clientY, state.boardScale * factor);
  };
  const onClick = (event: MouseEvent) => {
    if (retired || !moved) return;
    event.preventDefault();
    event.stopPropagation();
  };
  viewport.addEventListener("pointerdown", onDown, { capture: true, passive: false });
  viewport.addEventListener("pointermove", onMove, { capture: true, passive: false });
  viewport.addEventListener("pointerup", end, true);
  viewport.addEventListener("pointercancel", end, true);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("click", onClick, true);
  return () => {
    retired = true;
    cancelAnimationFrame(frame);
    viewport.removeEventListener("pointerdown", onDown, true);
    viewport.removeEventListener("pointermove", onMove, true);
    viewport.removeEventListener("pointerup", end, true);
    viewport.removeEventListener("pointercancel", end, true);
    viewport.removeEventListener("wheel", onWheel);
    viewport.removeEventListener("click", onClick, true);
  };
}

export function fitCurrentBoard(): void {
  const viewport = document.querySelector<HTMLElement>(".board-canvas");
  const stage = document.querySelector<HTMLElement>(".board-stage");
  const layout = layoutForTab(state.boardTabId, state.layouts, state.agents);
  if (!viewport || !stage || !layout) return;
  placeBoardStage(viewport, stage, layout);
}

export function nudgeBoardZoom(direction: 1 | -1): void {
  const viewport = document.querySelector<HTMLElement>(".board-canvas");
  const stage = document.querySelector<HTMLElement>(".board-stage");
  if (!viewport || !stage) return;
  const rect = viewport.getBoundingClientRect();
  zoomBoardAt(viewport, stage, rect.left + rect.width / 2, rect.top + rect.height / 2, state.boardScale * (direction > 0 ? 1.2 : 1 / 1.2));
}
