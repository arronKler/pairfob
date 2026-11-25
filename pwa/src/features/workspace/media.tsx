import { Maximize, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { t } from "../../lib/i18n";
import { imageExceedsPixelBudget } from "../../lib/protocol/workspace-media";
import { Button } from "../../shared/ui/primitives";
import { workspaceMediaLoader } from "./store";
import { loadWorkspaceMedia, markMediaCodecFailure, markMediaPixelFailure, mediaPlayerIdentity } from "./media-actions";
import { formatMediaBytes } from "./media-model";
import type { WorkspaceMediaView } from "./media-model";

/** Zoom is counted from the picture fitted to its stage: 1 is the fit, and never less. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** Two presses this close in time and place are one double press. */
export const DOUBLE_PRESS_MS = 320;
export const DOUBLE_PRESS_PX = 32;
/** A press that travelled further, or lasted longer, was a drag or a hold. */
export const PRESS_SLOP_PX = 10;
export const PRESS_MS = 350;

/** How large the fitted picture is drawn against its own pixels; 0 until it can be measured. */
function fitScale(node: HTMLImageElement | null): number {
  if (!node || !node.naturalWidth || !node.naturalHeight) return 0;
  // The box may be wider or taller than the picture it contains: the tighter side is the scale.
  const scale = Math.min(node.offsetWidth / node.naturalWidth, node.offsetHeight / node.naturalHeight);
  return Number.isFinite(scale) && scale > 0 ? scale : 0;
}

/** The zoom at which one pixel of the picture is one pixel of the page; the fit itself for a picture that small. */
export function actualSizeZoom(fit: number): number {
  return fit > 0 ? Math.max(MIN_ZOOM, 1 / fit) : MIN_ZOOM;
}

/** What the readout says: the picture's real scale, or that it is fitted while that cannot be known. */
export function zoomReadout(zoom: number, fit: number): string {
  if (fit > 0) return `${Math.round(zoom * fit * 100)}%`;
  return zoom === MIN_ZOOM ? t("workspace.media.fit") : `×${zoom.toFixed(1)}`;
}

/**
 * A toolbar is one Tab stop: Left and Right, Home and End move along its
 * controls, and the one the reader was last on is where Tab comes back to. A
 * control that goes out of use under the reader (zoom out, at the fit) hands
 * the keyboard to its neighbour, not to the page.
 */
export function useToolbarStops(bar: RefObject<HTMLElement | null>): {
  onFocus(event: FocusEvent<HTMLElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
} {
  const stop = useRef<HTMLElement | null>(null);
  const usable = (): HTMLButtonElement[] => [...(bar.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
  useLayoutEffect(() => {
    const all = usable();
    const held = document.activeElement instanceof HTMLButtonElement && bar.current?.contains(document.activeElement) ? document.activeElement : null;
    const kept = stop.current && all.includes(stop.current as HTMLButtonElement) ? stop.current : all[0] ?? null;
    for (const control of bar.current?.querySelectorAll<HTMLButtonElement>("button") ?? []) control.tabIndex = control === kept ? 0 : -1;
    stop.current = kept;
    if (held?.disabled) kept?.focus();
  });
  return {
    onFocus(event) {
      if (!(event.target instanceof HTMLButtonElement) || event.target === stop.current) return;
      if (stop.current) stop.current.tabIndex = -1;
      event.target.tabIndex = 0;
      stop.current = event.target;
    },
    onKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const all = usable();
      const at = all.indexOf(event.target as HTMLButtonElement);
      const to = event.key === "ArrowRight" ? Math.min(at + 1, all.length - 1)
        : event.key === "ArrowLeft" ? Math.max(at - 1, 0)
        : event.key === "Home" ? 0
        : event.key === "End" ? all.length - 1
        : -1;
      if (at < 0 || to < 0) return;
      event.preventDefault();
      all[to]?.focus();
    },
  };
}

/** A page that can show one of its elements full screen. An iPhone cannot; the control is not offered there. */
function fullscreenOffered(): boolean {
  return typeof document !== "undefined" && Boolean(document.fullscreenEnabled);
}

function formatSize(size: number): string {
  return formatMediaBytes(size);
}

function oversizeCopy(media: WorkspaceMediaView): string {
  const size = formatSize(media.size);
  const cap = formatSize(media.cap);
  if (media.role === "image") return t("workspace.media.oversizeImage", { size, cap });
  if (media.role === "video") return t("workspace.media.oversizeVideo", { size, cap });
  if (media.role === "audio") return t("workspace.media.oversizeAudio", { size, cap });
  return t("workspace.media.oversizeFile", { size, cap });
}

function loadLabel(media: WorkspaceMediaView): string {
  const size = formatSize(media.size || 0);
  if (media.role === "video") return t("workspace.media.loadVideo", { size });
  if (media.role === "audio") return t("workspace.media.loadAudio", { size });
  return t("workspace.media.loadFile", { size });
}

function capCopy(media: WorkspaceMediaView): string {
  return media.role === "image" ? t("workspace.media.capImage") : t("workspace.media.capMedia");
}

// Detach a media element owned by THIS mount: pause and drop the src/children so
// it stops using the blob. URL revocation is owned by the workspace loader/store,
// never by the view — the element is cleaned before that URL is revoked.
function cleanupElement(node: HTMLImageElement | HTMLVideoElement | HTMLAudioElement | null): void {
  if (!node) return;
  if (node.tagName === "VIDEO" || node.tagName === "AUDIO") {
    const av = node as HTMLVideoElement;
    av.pause();
    av.removeAttribute("src");
    if ("srcObject" in av) (av as unknown as { srcObject: MediaStream | null }).srcObject = null;
    while (av.firstChild) av.removeChild(av.firstChild);
    void av.load?.();
    return;
  }
  (node as HTMLImageElement).removeAttribute("src");
}

function DownloadLink({ media }: { media: WorkspaceMediaView }) {
  if (!media.url) return null;
  return <a className="btn btn-small workspace-media-download" href={media.url} download={media.path.split("/").pop() || "download"}>
    {t("workspace.media.download")}
  </a>;
}

function ImagePlayer({ url, identity, alt }: { url: string; identity: string; alt: string }) {
  // Capture the ACTUAL mounted <img> into a plain ref that is never cleared by a
  // null callback on unmount, so cleanup (passive or loader-dispose) can detach
  // it. React clearing the hook ref is exactly why reading image.current inside a
  // passive cleanup missed the element (R1).
  const image = useRef<HTMLImageElement | null>(null);
  const ownedImage = useRef<HTMLImageElement | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFitScale] = useState(0);
  const fitNow = useRef(0);
  const pan = useRef({ x: 0, y: 0, zoom: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastDist = useRef(0);
  /** The press under way, while it can still be a tap; and the tap before it, while a second can still follow. */
  const press = useRef<{ id: number; x: number; y: number; at: number } | null>(null);
  const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);

  // Owned cleanup: this mount owns the element. Detach (pause + clear src/load)
  // must run before the loader revokes the URL (registered lease) and on unmount.
  // Setup re-attaches the CURRENT url on the owned element, so a StrictMode
  // cleanup->setup remount (same live resource) restores an image whose src the
  // prior cleanup detached; a newer resource key re-runs setup against its url.
  useEffect(() => {
    const node = ownedImage.current;
    if (node) node.src = url;
    const detach = () => cleanupElement(ownedImage.current);
    const removeCleanup = workspaceMediaLoader().retainPlayerCleanup(detach);
    return () => {
      removeCleanup();
      detach();
    };
  }, [url]);

  /**
   * A zoomed picture stays over its stage: it pans as far as its own edge, and
   * not at all along a side it does not overflow. Left alone until the picture
   * can be measured.
   */
  const hold = () => {
    const node = image.current;
    const host = stage.current;
    if (!node || !host || !node.offsetWidth || !node.offsetHeight) return;
    const reach = (drawn: number, room: number) => Math.max(0, (drawn - room) / 2);
    const x = reach(node.offsetWidth * pan.current.zoom, host.clientWidth);
    const y = reach(node.offsetHeight * pan.current.zoom, host.clientHeight);
    pan.current.x = Math.min(x, Math.max(-x, pan.current.x));
    pan.current.y = Math.min(y, Math.max(-y, pan.current.y));
  };
  const apply = (nextZoom = pan.current.zoom) => {
    pan.current.zoom = nextZoom;
    hold();
    image.current?.style.setProperty("transform", `translate(${pan.current.x}px, ${pan.current.y}px) scale(${nextZoom})`);
  };
  const setFit = () => {
    pan.current = { x: 0, y: 0, zoom: 1 };
    setZoom(1);
    apply(1);
  };
  /** 100% is always within reach, however far past the usual limit a large picture puts it. */
  const maxZoom = () => Math.max(MAX_ZOOM, actualSizeZoom(fitNow.current));
  const zoomBy = (factor: number) => {
    const next = Math.min(maxZoom(), Math.max(MIN_ZOOM, pan.current.zoom * factor));
    pan.current.zoom = next;
    if (next === 1) pan.current = { x: 0, y: 0, zoom: 1 };
    setZoom(next);
    apply(next);
  };
  /** One pixel for one pixel, about the stage's centre or the point the reader pressed. */
  const setActual = (at?: { x: number; y: number }) => {
    const next = actualSizeZoom(fitNow.current);
    const box = at ? stage.current?.getBoundingClientRect() : null;
    // The fitted picture is centred on the stage: what was under the press stays under it.
    const from = box && at ? { x: at.x - (box.left + box.width / 2), y: at.y - (box.top + box.height / 2) } : { x: 0, y: 0 };
    pan.current = next === 1 ? { x: 0, y: 0, zoom: 1 } : { x: from.x * (1 - next), y: from.y * (1 - next), zoom: next };
    setZoom(next);
    apply(next);
  };
  /** A double press: from the fit to the picture's own size where it was pressed, and from anywhere else back to the fit. */
  const toggleAt = (x: number, y: number) => {
    if (pan.current.zoom === 1) setActual({ x, y });
    else setFit();
  };

  // The fitted size follows the stage: the readout and 100% are measured against it.
  useEffect(() => {
    const measure = () => {
      const next = fitScale(image.current);
      fitNow.current = next;
      setFitScale(next);
    };
    measure();
    const node = image.current;
    node?.addEventListener("load", measure);
    const sized = typeof ResizeObserver === "undefined" || !stage.current ? null : new ResizeObserver(measure);
    if (stage.current) sized?.observe(stage.current);
    return () => {
      node?.removeEventListener("load", measure);
      sized?.disconnect();
    };
  }, [url]);

  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1.1 : 0.9); };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a pointer that is already gone, or a DOM without capture */ }
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
    event.stopPropagation();
    if (pointers.current.size === 2) {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...pointers.current.values()];
      const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (lastDist.current) zoomBy(dist / lastDist.current);
      lastDist.current = dist;
      return;
    }
    if (pan.current.zoom > 1) {
      pan.current.x += event.clientX - prev.x;
      pan.current.y += event.clientY - prev.y;
      apply();
    }
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

  const actualZoom = actualSizeZoom(fit);
  const tools = useToolbarStops(toolbar);
  return <div className="workspace-media-player is-image">
    <div ref={toolbar} className="workspace-media-toolbar" role="toolbar" aria-label={t("workspace.media.zoomTools")}
      onFocus={tools.onFocus} onKeyDown={tools.onKeyDown}>
      <Button className="icon-btn" aria-label={t("workspace.media.zoomOut")} title={t("workspace.media.zoomOut")}
        disabled={zoom <= MIN_ZOOM} onClick={() => zoomBy(1 / 1.25)}><ZoomOut size={18} aria-hidden="true" /></Button>
      <output className="workspace-media-scale">{zoomReadout(zoom, fit)}</output>
      <Button className="icon-btn" aria-label={t("workspace.media.zoomIn")} title={t("workspace.media.zoomIn")}
        disabled={zoom >= Math.max(MAX_ZOOM, actualZoom)} onClick={() => zoomBy(1.25)}><ZoomIn size={18} aria-hidden="true" /></Button>
      <span className="workspace-media-toolbar-rule" aria-hidden="true" />
      <Button className="icon-btn" aria-label={t("workspace.media.fit")} title={t("workspace.media.fit")}
        aria-pressed={zoom === MIN_ZOOM} onClick={setFit}><Scan size={18} aria-hidden="true" /></Button>
      <Button className="icon-btn workspace-media-actual" aria-label={t("workspace.media.actualSize")} title={t("workspace.media.actualSize")}
        aria-pressed={fit > 0 && zoom === actualZoom} onClick={() => setActual()}>1:1</Button>
      {fullscreenOffered() && <Button className="icon-btn workspace-media-fullscreen" aria-label={t("workspace.media.fullscreen")}
        title={t("workspace.media.fullscreen")} onClick={() => {
          if (document.fullscreenElement) void document.exitFullscreen?.();
          else void stage.current?.requestFullscreen?.();
        }}><Maximize size={18} aria-hidden="true" /></Button>}
    </div>
    <div
      ref={stage}
      className="workspace-media-stage workspace-media-viewer"
      data-zoomed={zoom > MIN_ZOOM ? "" : undefined}
      data-enlarges={zoom === MIN_ZOOM && actualZoom > MIN_ZOOM ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <img
        ref={(node) => { image.current = node; if (node) ownedImage.current = node; }}
        className="workspace-media-image"
        alt={alt}
        src={url}
        draggable={false}
        data-zoom={zoom}
        onLoad={(event) => {
          const node = event.currentTarget;
          if (imageExceedsPixelBudget(node.naturalWidth, node.naturalHeight)) {
            markMediaPixelFailure(node.naturalWidth, node.naturalHeight, identity);
          }
        }}
        onError={() => markMediaCodecFailure(identity)}
      />
    </div>
  </div>;
}

function AVPlayer({ kind, url, mime, identity }: { kind: "video" | "audio"; url: string; mime: string; identity: string }) {
  // Capture the ACTUAL mounted element (never a cleared hook ref): React clears
  // the ref before passive cleanup, so reading it there misses the node (R1).
  const nodeRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const ownedNode = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  // Owned cleanup: register a per-resource cleanup with the loader (runs pause +
  // src-detach synchronously BEFORE the loader revokes the URL on retirement) and
  // also detach on unmount. Never clears a newer resource's URL; idempotent under
  // StrictMode/remount/double dispose.
  useEffect(() => {
    const node = ownedNode.current as HTMLVideoElement | HTMLAudioElement | null;
    if (node) node.src = url;
    const detach = () => cleanupElement(ownedNode.current);
    const removeCleanup = workspaceMediaLoader().retainPlayerCleanup(detach);
    return () => {
      removeCleanup();
      detach();
    };
  }, [kind, url]);
  return <div className={`workspace-media-player is-${kind}`}>
    <div className="workspace-media-stage">
      {kind === "audio"
        ? <audio ref={(node) => { nodeRef.current = node; if (node) ownedNode.current = node; }} className="workspace-media-audio" src={url} controls preload="metadata" onError={() => markMediaCodecFailure(identity)} />
        : <video ref={(node) => { nodeRef.current = node; if (node) ownedNode.current = node; }} className="workspace-media-video" src={url} controls preload="metadata" playsInline onError={() => markMediaCodecFailure(identity)} />}
    </div>
    {kind === "video" && <p className="workspace-media-note">{t("workspace.media.nativeCodec")}</p>}
  </div>;
}

function Progress({ media }: { media: WorkspaceMediaView }) {
  const total = media.size || 1;
  const percent = Math.min(100, Math.round((media.loaded / total) * 100));
  return <div className="workspace-media-progress">
    <p>{t("workspace.media.loading", { loaded: formatSize(media.loaded), total: formatSize(media.size) })}</p>
    <p className="workspace-media-percent">{t("workspace.media.progress", { percent })}</p>
    <div className="workspace-media-bar"><span className="workspace-media-bar-fill" style={{ width: `${percent}%` }} /></div>
  </div>;
}

function onLoadAction(media: WorkspaceMediaView): void {
  void loadWorkspaceMedia(media.path);
}

function Prompt({ media }: { media: WorkspaceMediaView }) {
  return <div className="workspace-media-prompt">
    <p>{loadLabel(media)}</p>
    {(media.role === "video" || media.role === "audio") &&
      <p className="workspace-media-note">{t("workspace.media.nativeCodec")}</p>}
    <Button className="btn btn-primary" disabled={media.status === "loading"} onClick={() => onLoadAction(media)}>
      {loadLabel(media)}
    </Button>
    <p className="workspace-media-cap">{capCopy(media)}</p>
  </div>;
}

function Failure({ media }: { media: WorkspaceMediaView }) {
  const text = media.error || (media.status === "oversize" ? oversizeCopy(media) : t("workspace.media.network"));
  return <div className="workspace-media-failure" role="alert">
    <p>{text}</p>
    {media.status !== "oversize" &&
      <Button className="btn btn-small" onClick={() => onLoadAction(media)}>{t("workspace.media.reload")}</Button>}
    <p className="workspace-media-cap">{capCopy(media)}</p>
  </div>;
}

export function SvgHint({ media }: { media: WorkspaceMediaView }) {
  return <div className="workspace-media-svg">
    <p className="workspace-media-note">{t("workspace.media.svgHint")}</p>
    {Boolean(media.size) && media.size <= media.cap &&
      <Button className="btn btn-small" onClick={() => onLoadAction(media)}>
        {t("workspace.media.downloadFile", { size: formatSize(media.size) })}
      </Button>}
    <p className="workspace-media-cap">{t("workspace.media.capMedia")}</p>
  </div>;
}

export function isWorkspaceMediaRole(role: string): boolean {
  return role === "image" || role === "video" || role === "audio" || role === "download" || role === "svg";
}

/** Owned media surface: reads the immutable workspace media view; player element
 * lifetimes are owned by the per-mount refs above; URL revocation is owned by the
 * loader. */
export function WorkspaceMedia({ media }: { media: WorkspaceMediaView }) {
  const identity = mediaPlayerIdentity();
  if (!media.path) return <div className="workspace-media" />;
  if (media.status === "loading") return <div className="workspace-media"><Progress media={media} /></div>;
  if (media.status === "oversize" || media.status === "error" || media.status === "codec") {
    return <div className="workspace-media">
      <Failure media={media} />
      {media.status === "codec" && <DownloadLink media={media} />}
    </div>;
  }
  if (media.status === "ready" && media.url) {
    if (media.role === "image") {
      return <div className="workspace-media"><ImagePlayer key={identity} url={media.url} identity={identity} alt={media.path} /></div>;
    }
    if (media.role === "video" || media.role === "audio") {
      return <div className="workspace-media">
        <AVPlayer key={identity} kind={media.role} url={media.url} mime={media.mime} identity={identity} />
      </div>;
    }
    return <div className="workspace-media">
      <p className="workspace-empty">{t("workspace.binary")}</p>
      <DownloadLink media={media} />
    </div>;
  }
  if (media.role === "svg") return <div className="workspace-media"><SvgHint media={media} /></div>;
  if (media.role === "video" || media.role === "audio" || media.role === "download") {
    return <div className="workspace-media"><Prompt media={media} /></div>;
  }
  return <div className="workspace-media" />;
}
