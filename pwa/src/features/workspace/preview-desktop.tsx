import { Scan, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { actualSizeZoom, DOUBLE_PRESS_MS, DOUBLE_PRESS_PX, MAX_ZOOM, MIN_ZOOM, PRESS_MS, PRESS_SLOP_PX, useToolbarStops, zoomReadout } from "./media";
import { PREVIEW_DESKTOP_WIDTH } from "./preview-controls";

/** The tallest document drawn on the zoom surface; a longer one keeps its own scroll. */
const PREVIEW_PAGE_MAX_HEIGHT = 16000;
/**
 * The page is drawn as a PC draws it on a PC's screen: 1280 wide and at least
 * this tall, so a page that fills its viewport is a screen and not a strip, and
 * one that is longer is the whole document.
 */
const PREVIEW_DESKTOP_HEIGHT = 800;

/**
 * An HTML page laid out as a PC lays it out, read as one surface larger than
 * its stage: the width is the page's own (1280), the document's full height is
 * the page's own, and the reader fits it, zooms it, drags it and double-presses
 * it exactly as they read a picture (`media.tsx`). The surface covers the frame,
 * so the page is read here and operated in the stage's own width: this view
 * never sends a press into the untrusted document.
 */
export function DesktopPreview({ hidden, pageHeight, children }: {
  hidden: boolean;
  /** The document's own height as it reports it; 0 until it does. */
  pageHeight: number;
  children: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const view = useRef({ x: 0, y: 0, zoom: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastDist = useRef(0);
  const press = useRef<{ id: number; x: number; y: number; at: number } | null>(null);
  const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);
  const measured = useRef(false);

  const fit = size.width > 0 ? size.width / PREVIEW_DESKTOP_WIDTH : 0;
  // A PC screen's own shape, and the whole document when it is longer. A page
  // shorter than its screen keeps the screen's height, so the surface never
  // becomes one stage-shaped sheet of the page's background.
  const reported = Math.min(Math.max(0, pageHeight), PREVIEW_PAGE_MAX_HEIGHT);
  const worldHeight = Math.max(1, PREVIEW_DESKTOP_HEIGHT, reported);

  const reach = () => {
    if (!fit) return { x: 0, y: 0 };
    const scale = fit * view.current.zoom;
    return {
      x: Math.max(0, (PREVIEW_DESKTOP_WIDTH * scale - size.width) / 2),
      y: Math.max(0, (worldHeight * scale - size.height) / 2),
    };
  };
  const clampView = () => {
    const room = reach();
    view.current.x = Math.min(room.x, Math.max(-room.x, view.current.x));
    view.current.y = Math.min(room.y, Math.max(-room.y, view.current.y));
  };
  const paint = () => {
    const node = world.current;
    if (node) node.style.transform = `translate(${view.current.x}px, ${view.current.y}px) scale(${fit * view.current.zoom})`;
  };
  /** The page from its top, as wide as the stage: what a reader starts with and comes back to. */
  const setFit = () => {
    view.current = { x: 0, y: 0, zoom: MIN_ZOOM };
    view.current.y = reach().y;
    setZoom(MIN_ZOOM);
    paint();
  };
  /** One pixel of the page for one pixel of the screen, about the press or the stage's centre. */
  const zoomTo = (next: number, at?: { x: number; y: number }) => {
    const host = stage.current;
    if (!fit || !host) return;
    if (next <= MIN_ZOOM) { setFit(); return; }
    const target = Math.min(next, Math.max(MAX_ZOOM, actualSizeZoom(fit)));
    if (Math.abs(target - view.current.zoom) < 1e-4) return;
    const box = host.getBoundingClientRect();
    const before = fit * view.current.zoom;
    const after = fit * target;
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const px = at?.x ?? cx;
    const py = at?.y ?? cy;
    // The page point under the anchor stays under it as the surface grows.
    const wx = (px - cx - view.current.x) / before;
    const wy = (py - cy - view.current.y) / before;
    view.current.zoom = target;
    view.current.x = px - cx - wx * after;
    view.current.y = py - cy - wy * after;
    clampView();
    setZoom(target);
    paint();
  };
  const toggleAt = (x: number, y: number) => {
    if (view.current.zoom === MIN_ZOOM) zoomTo(actualSizeZoom(fit), { x, y });
    else setFit();
  };

  // The stage's own box is the room; a hidden stage is measured again when
  // its layer comes back, so the fit follows the pane.
  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    sized?.observe(node);
    return () => { sized?.disconnect(); };
  }, [hidden]);

  // A new stage or a taller document keeps the page readable: the first measure
  // starts at the top, and a page still at its fit stays there as it grows.
  useLayoutEffect(() => {
    if (!fit) return;
    if (!measured.current || view.current.zoom === MIN_ZOOM) {
      measured.current = true;
      view.current = { x: 0, y: 0, zoom: MIN_ZOOM };
      view.current.y = reach().y;
      setZoom(MIN_ZOOM);
    } else clampView();
    paint();
  }, [fit, worldHeight, size.width, size.height]);

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // A page's wheel scrolls it; the control key makes it the zoom a browser gives it.
      if (event.ctrlKey || event.metaKey) {
        zoomTo(view.current.zoom * (event.deltaY < 0 ? 1.1 : 0.9), { x: event.clientX, y: event.clientY });
        return;
      }
      view.current.x -= event.deltaX;
      view.current.y -= event.deltaY;
      clampView();
      paint();
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [fit, worldHeight, size.width, size.height]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a pointer already gone, or no capture */ }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // Only a lone press of the main button can be a tap; a second finger makes it a pinch.
    press.current = pointers.current.size === 1 && event.button === 0
      ? { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp } : null;
    if (!press.current) lastTap.current = null;
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(event.pointerId);
    if (!prev) return;
    event.preventDefault();
    if (pointers.current.size === 2) {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...pointers.current.values()];
      const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (lastDist.current) zoomTo(view.current.zoom * (dist / lastDist.current),
        { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
      lastDist.current = dist;
      return;
    }
    view.current.x += event.clientX - prev.x;
    view.current.y += event.clientY - prev.y;
    clampView();
    paint();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) lastDist.current = 0;
    const down = press.current;
    press.current = null;
    if (!down || down.id !== event.pointerId || event.type !== "pointerup") return;
    const tapped = event.timeStamp - down.at <= PRESS_MS
      && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= PRESS_SLOP_PX;
    if (!tapped) {
      lastTap.current = null;
      return;
    }
    const before = lastTap.current;
    const doubled = before !== null && event.timeStamp - before.at <= DOUBLE_PRESS_MS
      && Math.hypot(event.clientX - before.x, event.clientY - before.y) <= DOUBLE_PRESS_PX;
    // A mouse and a finger double-press alike, so both are read here and not from `dblclick`, which a finger rarely sends.
    lastTap.current = doubled ? null : { x: event.clientX, y: event.clientY, at: event.timeStamp };
    if (doubled) toggleAt(event.clientX, event.clientY);
  };

  const actual = actualSizeZoom(fit);
  const atActual = fit > 0 && Math.abs(zoom - actual) < 1e-4;
  const tools = useToolbarStops(toolbar);
  return <div className="workspace-html-desktop" hidden={hidden}>
    <div ref={toolbar} className="workspace-media-toolbar workspace-html-desktop-tools" role="toolbar"
      aria-label={t("preview.zoomTools")} onFocus={tools.onFocus} onKeyDown={tools.onKeyDown}>
      <Button className="icon-btn" aria-label={t("workspace.media.zoomOut")} title={t("workspace.media.zoomOut")}
        disabled={zoom <= MIN_ZOOM} onClick={() => zoomTo(zoom / 1.25)}><ZoomOut size={18} aria-hidden="true" /></Button>
      <output className="workspace-media-scale">{zoomReadout(zoom, fit)}</output>
      <Button className="icon-btn" aria-label={t("workspace.media.zoomIn")} title={t("workspace.media.zoomIn")}
        disabled={zoom >= Math.max(MAX_ZOOM, actual)} onClick={() => zoomTo(zoom * 1.25)}><ZoomIn size={18} aria-hidden="true" /></Button>
      <span className="workspace-media-toolbar-rule" aria-hidden="true" />
      <Button className="icon-btn" aria-label={t("workspace.media.fit")} title={t("workspace.media.fit")}
        aria-pressed={zoom === MIN_ZOOM} onClick={setFit}><Scan size={18} aria-hidden="true" /></Button>
      <Button className="icon-btn workspace-media-actual" aria-label={t("workspace.media.actualSize")}
        title={t("workspace.media.actualSize")} aria-pressed={atActual} onClick={() => zoomTo(actual)}>1:1</Button>
      <span className="workspace-html-desktop-note">
        <span className="workspace-html-desktop-note-short">{t("preview.desktopViewOnlyShort")}</span>
        <span className="workspace-html-desktop-note-long">{t("preview.desktopViewOnly")}</span>
      </span>
    </div>
    <div ref={stage} className="workspace-html-desktop-stage">
      <div ref={world} className="workspace-html-desktop-page"
        style={{ width: `${PREVIEW_DESKTOP_WIDTH}px`, height: `${worldHeight}px` }}>{children}</div>
      <div className="workspace-html-desktop-gestures" data-zoomed={zoom > MIN_ZOOM ? "" : undefined}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} />
    </div>
  </div>;
}
