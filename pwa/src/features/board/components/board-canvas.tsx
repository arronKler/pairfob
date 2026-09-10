import { useEffect, useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { Button, EmptyState } from "../../../shared/ui/primitives";
import type { PaneBox, TabLayout } from "../../../lib/layout";
import { tileFillScale } from "../model/camera";
import type { BoardCanvasModel, BoardTileView } from "../model/board-view";
import { BoardAnsiPreview } from "./board-preview";

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
};

function tileStyle(box: PaneBox): CSSProperties {
  return {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    minWidth: `${box.width}px`,
    minHeight: `${box.height}px`,
  };
}

function BoardPaneTile({
  tile,
  zoomedLabel,
  controller,
  viewportRef,
  stageRef,
  previewPaint,
}: {
  tile: BoardTileView;
  zoomedLabel: string;
  controller: BoardCanvasController;
  viewportRef: RefObject<HTMLDivElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  previewPaint: object;
}) {
  const tileRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    controller.shareTileOpening(tile.paneId, tileRef.current);
  });
  return (
    <Button
      ref={tileRef}
      className={tile.className}
      data-pane-id={tile.paneId}
      data-react-board-preview=""
      aria-label={tile.aria}
      style={tileStyle(tile.box)}
      onClick={(event) => {
        event.preventDefault();
        controller.openPane(tile.paneId, tileRef.current);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        const viewport = viewportRef.current;
        const stage = stageRef.current;
        const tileNode = tileRef.current;
        if (!viewport || !stage || !tileNode) return;
        const frame = viewport.getBoundingClientRect();
        const spot = tileNode.getBoundingClientRect();
        controller.zoomAt(
          viewport,
          stage,
          spot.left + spot.width / 2,
          spot.top + spot.height / 2,
          tileFillScale(frame.width, frame.height, tile.box.width, tile.box.height),
        );
      }}
    >
      <span className="board-pane-head">
        <span className={`agent-dot agent-${tile.status}`} />
        <span className="board-pane-name">{tile.title}</span>
        {tile.pill ? <span className={`pill pill-${tile.status}`}>{tile.pill}</span> : null}
        {tile.zoomed ? <span className="board-pane-zoom">{zoomedLabel}</span> : null}
      </span>
      <BoardAnsiPreview paneId={tile.paneId} cols={tile.cols} rows={tile.rows} paint={previewPaint} />
    </Button>
  );
}

export function BoardCanvasView({
  canvas,
  controller,
}: {
  canvas: BoardCanvasModel;
  controller: BoardCanvasController;
}) {
  // A fresh token per canvas render: see BoardAnsiPreview's font timing.
  const previewPaint = {};
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // Host registration and gesture binding are owned per setup: when the canvas
  // or its controller is replaced, the previous owner releases exactly what it
  // registered and the new one binds the layout on screen.
  useLayoutEffect(() => {
    controller.registerHost(viewportRef.current, stageRef.current, canvas.layout);
    return () => controller.releaseHost();
  });
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (stage) controller.applyTransform(stage);
  });
  useEffect(() => {
    const viewport = viewportRef.current;
    const stage = stageRef.current;
    const layout = canvas.layout;
    if (!viewport || !stage || !layout) return;
    return controller.bindGestures(viewport, stage, layout);
    // Rebinding follows the resolved layout and its tab, not a title-only update.
  }, [canvas.tabId, canvas.signature, controller]);
  return (
    <div ref={viewportRef} className="board-canvas" role="application" aria-label={canvas.canvasAria}>
      {!canvas.layout ? (
        <EmptyState spec={{ figure: "grid", title: canvas.emptyTitle, sub: canvas.emptySub }} />
      ) : (
        <div
          ref={stageRef}
          className="board-stage"
          style={{ width: `${canvas.size!.width}px`, height: `${canvas.size!.height}px` }}
        >
          {canvas.tiles.map((tile) => (
            <BoardPaneTile
              key={tile.paneId}
              tile={tile}
              zoomedLabel={canvas.zoomedLabel}
              controller={controller}
              viewportRef={viewportRef}
              stageRef={stageRef}
              previewPaint={previewPaint}
            />
          ))}
        </div>
      )}
    </div>
  );
}
