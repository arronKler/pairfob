/**
 * Board canvas keys (desk).
 *
 * The same keys herdr answers after its prefix, without the prefix, while the
 * canvas has focus: arrows/hjkl select a pane, Shift swaps with a neighbour,
 * Alt/⌥ runs herdr's resize mode verbatim (`herdrNavMove`), v / - split,
 * z zooms on the computer, x closes, F2 renames, Enter opens, Escape clears,
 * ContextMenu / Shift+F10 opens the selected pane's menu.
 * Camera keys (0, ⌘/Ctrl ±) belong to the gesture adapter. The selection is a
 * data attribute on the rendered tile, so key repeat never re-renders React.
 * Keys typed into a field inside the canvas are never taken.
 */
import type { TabLayoutView } from "../../../lib/layout";
import type { LayoutDirection, SplitDirection } from "../../../lib/operations";
import { t } from "../../../lib/i18n";
import { edgeDivider, herdrNavMove } from "../model/divider";
import { clearLayoutDraft, setLayoutDraft } from "../model/draft-store";
import { directionalPanes, herdrNeighbor } from "../model/pane-menu";
import type { BoardCanvasController } from "../components/canvas-controller";

export type BoardKeyCommand =
  | { kind: "select" | "swap" | "resize"; direction: LayoutDirection }
  | { kind: "split"; direction: SplitDirection }
  | { kind: "open" | "zoom" | "close" | "rename" | "escape" | "menu" };

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey">;

const ARROWS: Record<string, LayoutDirection> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
/** Physical h/j/k/l, so ⌥ on a Mac (which rewrites `key`) still resolves. */
const VIM: Record<string, LayoutDirection> = { KeyH: "left", KeyL: "right", KeyK: "up", KeyJ: "down" };

export function boardKeyCommand(event: KeyLike): BoardKeyCommand | null {
  if (event.metaKey || event.ctrlKey) return null;
  const direction = ARROWS[event.key] ?? VIM[event.code];
  if (direction) {
    return { kind: event.altKey ? "resize" : event.shiftKey ? "swap" : "select", direction };
  }
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) return { kind: "menu" };
  if (event.altKey || event.shiftKey) return null;
  switch (event.key) {
    case "Enter": return { kind: "open" };
    case "v": return { kind: "split", direction: "right" };
    case "-": return { kind: "split", direction: "down" };
    case "z": return { kind: "zoom" };
    case "x": return { kind: "close" };
    case "F2": return { kind: "rename" };
    case "Escape": return { kind: "escape" };
    default: return null;
  }
}

export type BoardKeyboardDeps = {
  layout(): TabLayoutView | null;
  controller: BoardCanvasController;
  /** A short-lived hint near the selection when a key cannot act. */
  hint(text: string, anchor: HTMLElement | null): void;
  /** Leave placement mode, if any. */
  endPlacement(): void;
};

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export function bindBoardKeyboard(viewport: HTMLElement, deps: BoardKeyboardDeps): () => void {
  let selected = "";
  if (!viewport.hasAttribute("tabindex")) viewport.tabIndex = 0;
  const tileFor = (paneId: string) => [...viewport.querySelectorAll<HTMLElement>(".board-pane")]
    .find((tile) => tile.dataset.paneId === paneId) ?? null;
  const mark = (paneId: string) => {
    for (const tile of viewport.querySelectorAll<HTMLElement>(".board-pane[data-board-selected]")) delete tile.dataset.boardSelected;
    selected = paneId;
    const tile = paneId ? tileFor(paneId) : null;
    if (tile) tile.dataset.boardSelected = "";
  };

  const run = (command: BoardKeyCommand, layout: TabLayoutView): boolean => {
    const { controller } = deps;
    if (command.kind === "escape") {
      const had = !!selected;
      mark("");
      deps.endPlacement();
      return had;
    }
    // The first key shows where the selection starts: the computer's focused pane.
    if (!selected || !layout.panes.some((pane) => pane.paneId === selected)) {
      mark(layout.focusedPaneId && layout.panes.some((pane) => pane.paneId === layout.focusedPaneId)
        ? layout.focusedPaneId : layout.panes[0]?.paneId ?? "");
      if (command.kind === "select") return true;
    } else {
      mark(selected);
    }
    const pane = selected;
    const anchor = tileFor(pane);
    const refuse = (reason: string) => { deps.hint(reason, anchor); return true; };
    switch (command.kind) {
      case "select": {
        const next = herdrNeighbor(layout, pane, command.direction);
        if (next) mark(next);
        return true;
      }
      case "swap": {
        const reason = controller.layoutReason("swap");
        if (reason) return refuse(reason);
        if (!directionalPanes(layout, pane, command.direction).length) return refuse(t("pm.swapNoNeighbor"));
        void controller.commitSwap(pane, command.direction);
        return true;
      }
      case "resize": {
        const reason = controller.layoutReason("resize");
        if (reason) return refuse(reason);
        const move = herdrNavMove(layout, pane, command.direction);
        if (!move) return refuse(t(edgeDivider(layout, pane, command.direction) ? "boardCanvas.keyLimit" : "boardCanvas.keyNoDivider"));
        const draft = { tabId: layout.tabId, splitId: move.divider.id, ratio: move.targetRatio, pending: true };
        setLayoutDraft(draft);
        // Clear only this key's draft: a drag may have started on another tab meanwhile.
        void Promise.resolve(controller.commitResize(move.request)).finally(() => clearLayoutDraft(draft));
        return true;
      }
      case "split": {
        const reason = controller.layoutReason("split");
        if (reason) return refuse(reason);
        controller.pickSplit(pane, command.direction);
        return true;
      }
      case "zoom": {
        const reason = controller.layoutReason("zoom");
        if (reason) return refuse(reason);
        void controller.toggleZoom(pane, layout.zoomed ? "off" : "on");
        return true;
      }
      case "open":
        controller.openPane(pane, anchor);
        return true;
      case "menu": {
        if (!anchor) return false;
        const rect = anchor.getBoundingClientRect();
        controller.openMenu?.(pane, { x: rect.left + 20, y: rect.top + 28 }, anchor);
        return true;
      }
      case "close":
      case "rename":
        controller.paneAction(pane, command.kind);
        return true;
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || typing(event.target)) return;
    const target = event.target instanceof Element ? event.target : null;
    // Controls drawn over the canvas (dividers, banners, placement) own their keys.
    if (target?.closest("[data-board-overlay], [role=slider], dialog")) return;
    const tile = target?.closest<HTMLElement>(".board-pane") ?? null;
    if (target && target !== viewport && !tile) return;
    // A focused button keeps its native activation; the tile it sits in becomes the selection.
    if (target instanceof HTMLButtonElement && (event.key === "Enter" || event.key === " ")) return;
    if (tile?.dataset.paneId && tile.dataset.paneId !== selected) mark(tile.dataset.paneId);
    const layout = deps.layout();
    const command = layout ? boardKeyCommand(event) : null;
    if (!layout || !command) return;
    if (run(command, layout)) event.preventDefault();
  };
  viewport.addEventListener("keydown", onKeyDown);
  return () => {
    viewport.removeEventListener("keydown", onKeyDown);
    mark("");
  };
}
