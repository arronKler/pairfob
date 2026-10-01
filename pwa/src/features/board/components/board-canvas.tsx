import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties, type RefObject } from "react";
import { Button, EmptyState, AgentAvatar } from "../../../shared/ui/primitives";
import { paneBoxes, type PaneBox, type TabLayout } from "../../../lib/layout";
import { tileFillScale } from "../model/camera";
import { layoutDraft, subscribeLayoutDraft } from "../model/draft-store";
import { layoutWithSplitRatio } from "../model/layout-draft";
import type { BoardCanvasModel, BoardTileView } from "../model/board-view";
import { BoardAnsiPreview } from "./board-preview";
import { BoardCanvasOverlays } from "./canvas-overlays";
import { t } from "../../../lib/i18n";

import type { BoardCanvasController } from "./canvas-controller";
export type { BoardCanvasController, BoardLayoutKind } from "./canvas-controller";

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
  box,
  controller,
  viewportRef,
  stageRef,
  previewPaint,
  highlighted,
}: {
  tile: BoardTileView;
  /** Where the tile sits now: the snapshot box, or the live divider draft. */
  box: PaneBox;
  controller: BoardCanvasController;
  viewportRef: RefObject<HTMLDivElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  previewPaint: object;
  highlighted: boolean;
}) {
  const tileRef = useRef<HTMLDivElement>(null);
  const menu = (point?: { x: number; y: number }) => {
    const element = tileRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    controller.openMenu?.(tile.paneId, point ?? { x: rect.right - 12, y: rect.top + 32 }, element);
  };
  useLayoutEffect(() => {
    controller.shareTileOpening(tile.paneId, tileRef.current);
  });
  return (
    <div
      ref={tileRef}
      role="group"
      className={tile.className}
      data-pane-id={tile.paneId}
      data-board-menu-target={highlighted || undefined}
      data-react-board-preview=""
      aria-label={tile.aria}
      style={tileStyle(box)}
      onContextMenu={(event) => {
        event.preventDefault(); event.stopPropagation();
        menu(event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined);
      }}
      onKeyDown={(event) => {
        if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
          event.preventDefault(); event.stopPropagation(); menu();
        }
      }}
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
          tileFillScale(frame.width, frame.height, box.width, box.height),
        );
      }}
    >
      <Button className="board-pane-open" aria-label={tile.aria} />
      {/* The pane's real screen, scaled with the camera at every zoom. */}
      <BoardAnsiPreview paneId={tile.paneId} cols={tile.cols} rows={tile.rows} paint={previewPaint} />
      {/* herdr's border title, at a fixed on-screen size whatever the zoom. */}
      <span className="board-pane-title">
        <AgentAvatar kind={tile.agentKind} size="sm" />
        {/* A plain terminal has no agent state: no dot, no status word. */}
        {tile.agentKind ? <span className={`board-pane-dot is-${tile.status}`} /> : null}
        <span className={`board-pane-name${tile.agentKind ? "" : " is-terminal"}`}>{tile.title}</span>
        {tile.pill ? <span className={`board-pane-word is-${tile.status}`}>{tile.pill}</span> : null}
        <Button className="board-pane-more" aria-label={t("boardMenu.more", { title: tile.title })}
          aria-haspopup="menu" onClick={(event) => { event.stopPropagation(); menu(); }}>⋯</Button>
      </span>
    </div>
  );
}

/** herdr shows one pane alone: say so on the canvas and offer the way back. */
function ZoomBanner({ canvas, controller }: { canvas: BoardCanvasModel; controller: BoardCanvasController }) {
  const reason = controller.layoutReason("zoom");
  // An overlay control: the gesture adapter leaves presses on it alone, or its capture would swallow the click.
  return (
    <div className="board-zoom-banner" role="status" data-board-overlay="">
      <span>{canvas.zoomBanner.text}</span>
      <Button disabled={!!reason} title={reason || undefined}
        onClick={() => { void controller.toggleZoom(canvas.zoomedPaneId, "off"); }}>
        {canvas.zoomBanner.restore}
      </Button>
    </div>
  );
}

export function BoardCanvasView({
  canvas,
  controller,
}: {
  canvas: BoardCanvasModel;
  controller: BoardCanvasController;
}) {
  // A fresh token per canvas model: see BoardAnsiPreview's font timing. A
  // draft-only render keeps it, so dragging a divider never re-measures fonts.
  const previewPaint = useMemo(() => ({}), [canvas]);
  const draft = useSyncExternalStore(subscribeLayoutDraft, layoutDraft);
  const boxes = useMemo(() => {
    if (!draft || !canvas.layout || draft.tabId !== canvas.tabId) return null;
    return new Map(paneBoxes(layoutWithSplitRatio(canvas.layout, draft.splitId, draft.ratio)).map((box) => [box.paneId, box]));
  }, [draft, canvas]);
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
              box={boxes?.get(tile.paneId) ?? tile.box}
              controller={controller}
              viewportRef={viewportRef}
              stageRef={stageRef}
              previewPaint={previewPaint}
              highlighted={canvas.highlightedPaneId === tile.paneId}
            />
          ))}
          <BoardCanvasOverlays canvas={canvas} controller={controller} viewportRef={viewportRef} stageRef={stageRef} />
        </div>
      )}
      {canvas.layout && canvas.zoomedPaneId ? <ZoomBanner canvas={canvas} controller={controller} /> : null}
    </div>
  );
}
