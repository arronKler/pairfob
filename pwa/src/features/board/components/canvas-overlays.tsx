import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { TabLayoutView } from "../../../lib/layout";
import { bindBoardKeyboard } from "../canvas/keyboard";
import { endBoardPlacement } from "../interaction-store";
import type { BoardCanvasModel } from "../model/board-view";
import type { BoardCanvasController } from "./canvas-controller";
import { DividerHandles, type ViewportPoint } from "./divider-handles";
import { PlacementLayer } from "./placement-layer";

const HINT_MS = 2200;

/**
 * Everything drawn over the tiles in stage coordinates: divider handles,
 * the drag bubble, placement ghosts and lift/drop marks. Rendered last inside
 * the stage so it shares the camera transform with the tiles. It also binds
 * the desk keys to the focused canvas and shows the short hints a refused
 * action leaves behind (offline, busy, no neighbour, at the 10–90% limit).
 */
export function BoardCanvasOverlays({ canvas, controller, viewportRef, stageRef }: {
  canvas: BoardCanvasModel;
  controller: BoardCanvasController;
  viewportRef: RefObject<HTMLDivElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
}) {
  const [hint, setHint] = useState<{ text: string; point: ViewportPoint } | null>(null);
  const layoutRef = useRef<TabLayoutView | null>(canvas.layout);
  layoutRef.current = canvas.layout;
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const show = (text: string, anchor: HTMLElement | null) => {
      const frame = viewport.getBoundingClientRect();
      const rect = anchor?.getBoundingClientRect();
      setHint({ text, point: rect
        ? { x: rect.left + rect.width / 2 - frame.left, y: rect.top + 12 - frame.top }
        : { x: frame.width / 2, y: frame.height / 2 } });
    };
    return bindBoardKeyboard(viewport, {
      layout: () => layoutRef.current,
      get controller() { return controllerRef.current; },
      hint: show,
      endPlacement: endBoardPlacement,
    });
  }, [viewportRef]);

  const layout = canvas.layout;
  if (!layout) return null;
  const viewport = viewportRef.current;
  return <>
    <DividerHandles layout={layout} signature={canvas.signature} enabled={canvas.canResize} controller={controller}
      viewportRef={viewportRef} stageRef={stageRef} onHint={(text, point) => setHint({ text, point })} />
    <PlacementLayer layout={layout} controller={controller} viewportRef={viewportRef} />
    {hint && viewport ? createPortal(<div className="board-canvas-hint" role="status"
      style={{ left: `${hint.point.x}px`, top: `${hint.point.y}px` }}>{hint.text}</div>, viewport) : null}
  </>;
}
