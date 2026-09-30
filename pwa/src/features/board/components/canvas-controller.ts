/**
 * The canvas controller contract, types only, so the overlay and key modules
 * the canvas renders can name it without importing the canvas back.
 */
import type { TabLayout } from "../../../lib/layout";
import type { LayoutDirection, ResizePaneInput, SplitDirection } from "../../../lib/operations";

/**
 * Canvas lifecycle the page hands down.
 *
 * The component owns refs and effects; every read or write of the camera, the
 * bound layout and the remote session goes through this interface, so the
 * gesture adapter stays free of application state and the page can retire it.
 */
export type BoardCanvasController = {
  applyTransform(stage: HTMLElement): void;
  /**
   * Bind the layout this canvas actually displays. The adapter must not resolve
   * a different one: the fit, the scroll grids and the tiles all come from it.
   */
  bindGestures(viewport: HTMLElement, stage: HTMLElement, layout: TabLayout): () => void;
  /**
   * Register the mounted canvas as the toolbar's target, with the layout it is
   * showing, so a fit measures what the reader sees.
   */
  registerHost(viewport: HTMLElement | null, stage: HTMLElement | null, layout: TabLayout | null): void;
  releaseHost(): void;
  openPane(paneId: string, tile: HTMLElement | null): void;
  openMenu?(paneId: string, point: { x: number; y: number }, tile: HTMLElement): void;
  zoomAt(
    viewport: HTMLElement,
    stage: HTMLElement,
    clientX: number,
    clientY: number,
    nextScale: number,
  ): void;
  /** Retire the remote scroll controller and any pending thumbnail read. */
  releaseScrollOnLeave(): void;
  /** A tile the incoming pane expands out of shares its view-transition name. */
  shareTileOpening(paneId: string, tile: HTMLElement | null): void;
  /**
   * Layout mutations the canvas drives directly (divider drag, stepper, lift
   * to swap). Each resolves once the operation settled, applied or not; the
   * canvas keeps its draft until then and redraws from the refreshed snapshot.
   * `request` comes from `model/divider.ts`, so its pane may be the neighbour.
   */
  commitResize(request: ResizePaneInput): Promise<void>;
  commitSwap(paneId: string, direction: LayoutDirection): Promise<void>;
  /** The reader picked where a split goes (placement mode): ask what to start there. */
  pickSplit(paneId: string, direction: SplitDirection): void;
  /** Why a layout action cannot run right now (offline, busy, capability, zoomed); "" when it can. */
  layoutReason(kind: BoardLayoutKind): string;
  /** The stepper sheet for one pane (a tap on a divider, or the menu entry). */
  openResizeSheet(paneId: string): void;
  /** Zoom on the computer ("在电脑上铺满") or restore the split. */
  toggleZoom(paneId: string, mode: "on" | "off"): Promise<void>;
  /** Pane actions the desk keys reach without the menu. */
  paneAction(paneId: string, action: "rename" | "close"): void;
};

export type BoardLayoutKind = "resize" | "swap" | "split" | "zoom";
