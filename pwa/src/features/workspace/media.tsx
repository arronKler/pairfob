import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { t } from "../../lib/i18n";
import { imageExceedsPixelBudget } from "../../lib/protocol/workspace-media";
import { Button } from "../../shared/ui/primitives";
import { workspaceMediaLoader } from "./store";
import { loadWorkspaceMedia, markMediaCodecFailure, markMediaPixelFailure, mediaPlayerIdentity } from "./media-actions";
import { formatMediaBytes } from "./media-model";
import type { WorkspaceMediaView } from "./media-model";

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

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
  const [zoom, setZoom] = useState(1);
  const pan = useRef({ x: 0, y: 0, zoom: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastDist = useRef(0);

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

  const apply = (nextZoom = pan.current.zoom) => {
    pan.current.zoom = nextZoom;
    image.current?.style.setProperty("transform", `translate(${pan.current.x}px, ${pan.current.y}px) scale(${nextZoom})`);
  };
  const setFit = () => {
    pan.current = { x: 0, y: 0, zoom: 1 };
    setZoom(1);
    apply(1);
  };
  const zoomBy = (factor: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pan.current.zoom * factor));
    pan.current.zoom = next;
    if (next === 1) pan.current = { x: 0, y: 0, zoom: 1 };
    setZoom(next);
    apply(next);
  };

  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1.1 : 0.9); };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
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
  };

  return <div className="workspace-media-player is-image">
    <div className="workspace-media-toolbar">
      <Button className="btn btn-small" onClick={setFit}>{t("workspace.media.fit")}</Button>
      <Button className="btn btn-small" onClick={() => zoomBy(1 / 1.25)}>{t("workspace.media.zoomOut")}</Button>
      <Button className="btn btn-small" onClick={() => zoomBy(1.25)}>{t("workspace.media.zoomIn")}</Button>
      <Button className="btn btn-small" onClick={setFit}>{t("workspace.media.zoomReset")}</Button>
      <Button className="btn btn-small" onClick={() => {
        if (document.fullscreenElement) void document.exitFullscreen?.();
        else void stage.current?.requestFullscreen?.();
      }}>{t("workspace.media.fullscreen")}</Button>
    </div>
    <div
      ref={stage}
      className="workspace-media-stage workspace-media-viewer"
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
