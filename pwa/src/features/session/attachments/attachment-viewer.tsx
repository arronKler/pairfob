/**
 * Full-screen attachment viewer (session page v2): swipe or use the arrows to
 * move between tray items; the footer offers mark-up (the existing image
 * editor), the quality switch and file information.
 *
 * The large image is an object URL for the editable source that lives only
 * while that item is on screen; the store itself still only ever makes the
 * small thumbnail URL.
 *
 * Opened from a thumbnail, the picture grows out of it while the black ground
 * fades in, and closing sends it back (`viewer-flight`). The viewer is a
 * dialog of its own, so every way out of it (the ×, Escape, the system's back)
 * goes through that exit.
 */
import { ChevronLeft, ChevronRight, FileText, Info, PenLine, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { presentModal, ModalFrame, type ModalController } from "../../../shared/ui/overlay/modal";
import { Button } from "../../../shared/ui/primitives/button";
import { haptic } from "../../../lib/dom";
import { sessionTransport } from "../../connection/connection-store";
import { composeDraft, composeStore } from "../compose-store";
import { attachT, type AttachCopyKey } from "./attach-copy";
import { formatBytes, type AttachmentItem, type AttachmentScope } from "./attach-model";
import { scopeMatches } from "./attachments-context";
import { editImage } from "./attachments-controller";
import { attachmentScopeKey, attachmentsStore, runtimeCheckpoint, runtimeObjectUrl, runtimeSourceFile } from "./attachments-store";
import { changeQuality, subscribeTrayState, visibleItemsSnapshot } from "./attachments-tray-actions";
import { inBody, keepsOriginal } from "./attachments-tray-model";
import { presentImageEditor } from "./image-editor/image-editor";
import { closeViewer, flightEnd, growFromThumbnail, type FlightEnd } from "./viewer-flight";

/** Text files up to this size show their first lines in the viewer. */
const TEXT_PREVIEW_BYTES = 4096;
const TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|x-ndjson|x-yaml|yaml|toml|x-sh))/u;
const TEXT_NAMES = /\.(?:txt|log|md|json|jsonl|ya?ml|toml|csv|tsv|xml|ini|conf|sh|py|ts|tsx|js|jsx|go|rs|java|c|h|cpp|diff|patch)$/iu;
const SWIPE_PX = 48;

/** Stable across renders: an inline subscribe would detach and reattach on every one. */
function subscribeTrayItems(listener: () => void): () => void {
  const stops = [attachmentsStore.subscribe(listener), subscribeTrayState(listener)];
  return () => stops.forEach((stop) => stop());
}

function useItems(key: string): readonly AttachmentItem[] {
  return useSyncExternalStore(subscribeTrayItems, () => visibleItemsSnapshot(key));
}

/** A settled row: nothing is uploading, so its bytes may change. */
function settled(scope: AttachmentScope, item: AttachmentItem): boolean {
  if (runtimeCheckpoint(attachmentScopeKey(scope), item.localId)) return false;
  return (item.status === "queued" && !item.scheduled) || item.status === "committed"
    || item.status === "cancelled" || (item.status === "error" && !item.cancelIntent);
}

/**
 * Object URL for the source image while it is on screen (revoked on change), or
 * the tray thumbnail when there is no source to show or the browser cannot
 * decode it (HEIC outside Safari, a damaged file). `onError` reports the failed
 * decode.
 *
 * The URL is made before the first paint, so the picture the viewer draws is
 * the source from the start. Drawn first as the thumbnail it stood at the
 * thumbnail's few pixels and jumped to its size when the source arrived, and a
 * picture growing out of its thumbnail has to know the size it is growing to.
 */
function useSourceUrl(scope: AttachmentScope, item: AttachmentItem | undefined): { url: string; onError: () => void } {
  const key = attachmentScopeKey(scope);
  const source = item?.kind === "image" ? runtimeSourceFile(key, item.localId) : null;
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    setFailed(false);
    if (!source) { setUrl(""); return; }
    const next = URL.createObjectURL(source);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [source]);
  const thumb = item?.kind === "image" ? runtimeObjectUrl(key, item.localId) : "";
  return { url: failed || !source ? thumb : url, onError: () => setFailed(true) };
}

function useTextPreview(scope: AttachmentScope, item: AttachmentItem | undefined): string {
  const source = item && item.kind !== "image" ? runtimeSourceFile(attachmentScopeKey(scope), item.localId) : null;
  const [text, setText] = useState("");
  useEffect(() => {
    setText("");
    if (!source || !(TEXT_TYPES.test(source.type) || TEXT_NAMES.test(source.name))) return;
    let live = true;
    // A NUL byte means the name lied (a binary log or dump): show the file icon instead.
    void source.slice(0, TEXT_PREVIEW_BYTES).text().then((value) => { if (live && !value.includes("\u0000")) setText(value); }, () => {});
    return () => { live = false; };
  }, [source]);
  return text;
}

type StageKey = "compression" | "hashing" | "persistence" | "begin" | "sending" | "commit" | "status";
const STAGE_ORDER: readonly StageKey[] = ["compression", "hashing", "persistence", "begin", "sending", "commit", "status"];

function transportLabel(transport: "relay" | "p2p"): string {
  return attachT(transport === "p2p" ? "attach.transport.p2p" : "attach.transport.relay");
}

/**
 * Completed compression outcome. Real saved bytes are claimed only when the
 * result actually changed the file; every other reason says the original was
 * kept, and nothing is claimed before a result exists.
 */
export function compressionNote(item: AttachmentItem): string {
  if (item.kind !== "image" || item.compressing || !item.compressionReason) return "";
  if (item.compressionChanged && typeof item.originalBytes === "number" && item.originalBytes > 0) {
    // Floor to whole percent (or one decimal), capped at 99.9: a nonzero
    // remainder must never round up to a claimed "100% saved".
    const raw = Math.max(0, (1 - item.size / item.originalBytes) * 100);
    const floored = Math.min(99.9, Math.floor(raw * 10) / 10);
    const percent = Number.isInteger(floored) ? floored : floored.toFixed(1);
    return attachT("attach.compression.saved", { from: formatBytes(item.originalBytes), to: formatBytes(item.size), percent });
  }
  switch (item.compressionReason) {
    case "preserved": return attachT(item.imageIntent === "detail" ? "attach.compression.detailPreserved" : "attach.compression.kept");
    case "small": return attachT("attach.compression.small");
    case "not-smaller": return attachT("attach.compression.notSmaller");
    case "unsupported": return attachT("attach.compression.unsupported");
    case "failed": return attachT("attach.compression.failed");
    default: return attachT("attach.compression.kept");
  }
}

/** File facts: sizes, compression result, path and the last transfer's stages. */
export function AttachmentInfo({ item, scopeCurrent }: { item: AttachmentItem; scopeCurrent: boolean }) {
  const timings = item.stageTimings ?? {};
  const stages = STAGE_ORDER.filter((stage) =>
    typeof timings[stage] === "number" && Number.isFinite(timings[stage]) && timings[stage]! >= 0);
  // The captured transport is the connection WHEN UPLOAD STARTED, never a
  // claim about the whole transfer; the current one shows only when different.
  const current = scopeCurrent ? sessionTransport() : null;
  const note = compressionNote(item);
  const dims = typeof item.outputWidth === "number" && typeof item.outputHeight === "number"
    && item.outputWidth > 0 && item.outputHeight > 0 ? ` · ${item.outputWidth} × ${item.outputHeight}` : "";
  return <ul className="attach-info">
    <li>{item.kind === "image"
      ? attachT("attach.bytes", { source: formatBytes(item.originalBytes ?? item.size), upload: formatBytes(item.size) })
      : attachT("viewer.size", { size: formatBytes(item.size) })}</li>
    {(note || dims) && <li>{note}{dims}</li>}
    <li className="attach-info-path">{item.path ? attachT("viewer.path", { path: item.path }) : attachT("viewer.notUploaded")}</li>
    {item.errorText && <li className="is-error">{item.errorText}</li>}
    {item.persistenceWarning && <li className="is-warn">{item.persistenceWarning}</li>}
    {stages.map((stage) => <li key={stage}>
      {attachT("attach.stage.ms", { name: attachT(`attach.stage.${stage}` as AttachCopyKey), ms: Math.round((timings[stage] as number) * 10) / 10 })}
    </li>)}
    {item.transferTransport && <li>{attachT("attach.transportStart", { transport: transportLabel(item.transferTransport) })}</li>}
    {current && item.transferTransport && current !== item.transferTransport
      && <li>{attachT("attach.transportCurrent", { transport: transportLabel(current) })}</li>}
  </ul>;
}

function ViewerBody({ modal, scope, start, origin, leaveNow }: {
  modal: ModalController<void>; scope: AttachmentScope; start: number;
  /** The thumbnail the viewer was opened from, when it was on screen. */
  origin: FlightEnd | null;
  /** Close without the exit, for what takes the viewer's place. */
  leaveNow: () => void;
}) {
  const key = attachmentScopeKey(scope);
  const items = useItems(key);
  const draft = useSyncExternalStore(composeStore.subscribe, composeDraft);
  const [index, setIndex] = useState(start);
  const [info, setInfo] = useState(false);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const at = Math.max(0, Math.min(index, items.length - 1));
  const item = items[at];
  const { url, onError: onImageError } = useSourceUrl(scope, item);
  const text = useTextPreview(scope, item);
  const picture = useRef<HTMLImageElement>(null);
  // The picture the viewer opened on takes off once, when it has a size to grow
  // to. Until then it is not drawn (`data-grounded`): shown for a frame at its
  // full size first, it would jump back to the thumbnail to start from.
  const grounded = useRef(origin !== null);
  const takeOff = () => {
    const el = picture.current;
    if (!grounded.current || !origin || !el || !el.complete || !el.naturalWidth) return;
    grounded.current = false;
    growFromThumbnail(el, origin);
    el.removeAttribute("data-grounded");
  };
  useLayoutEffect(takeOff);

  useEffect(() => {
    if (!items.length) modal.dismiss();
  }, [items.length, modal]);

  const go = (step: number) => {
    const next = at + step;
    if (next < 0 || next >= items.length) return;
    haptic(2);
    // Another picture is not the one that was opened.
    grounded.current = false;
    setIndex(next);
  };

  if (!item) return null;
  const body = inBody(item, draft);
  const editable = item.kind === "image" && !body && settled(scope, item);
  const original = keepsOriginal(item);
  const quality = attachT(original ? "tray.quality.original" : "tray.quality.smart");
  return <div className="attach-viewer-body"
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
    }}>
    <div className="attach-viewer-bar">
      <Button className="attach-viewer-icon" aria-label={attachT("viewer.close")} onClick={() => modal.dismiss()}>
        <X size={20} aria-hidden="true" />
      </Button>
      <h2 id={modal.titleId} className="attach-viewer-title">
        <span className="attach-viewer-count">{attachT("viewer.count", { index: at + 1, total: items.length })}</span>
        <span className="attach-viewer-name">{item.name}</span>
      </h2>
      <span aria-hidden="true" />
    </div>
    <div className="attach-viewer-stage"
      onPointerDown={(event) => { swipe.current = { x: event.clientX, y: event.clientY }; }}
      onPointerUp={(event) => {
        const origin = swipe.current;
        swipe.current = null;
        if (!origin) return;
        const dx = event.clientX - origin.x;
        if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(event.clientY - origin.y)) go(dx < 0 ? 1 : -1);
      }}
      onPointerCancel={() => { swipe.current = null; }}>
      {at > 0 && <Button className="attach-viewer-nav is-prev" aria-label={attachT("viewer.prev")} onClick={() => go(-1)}>
        <ChevronLeft size={20} aria-hidden="true" />
      </Button>}
      {item.kind === "image" && url
        ? <img ref={picture} className="attach-viewer-img" data-item={item.localId} data-grounded={grounded.current ? "" : undefined}
          src={url} alt={item.name} draggable={false} onLoad={takeOff} onError={onImageError} />
        : <div className="attach-viewer-file">
          <FileText size={44} aria-hidden="true" />
          {text ? <pre className="attach-viewer-text">{text}</pre>
            : <p>{item.kind === "image" ? "" : attachT("viewer.noPreview")}</p>}
        </div>}
      {at < items.length - 1 && <Button className="attach-viewer-nav is-next" aria-label={attachT("viewer.next")} onClick={() => go(1)}>
        <ChevronRight size={20} aria-hidden="true" />
      </Button>}
    </div>
    {info && <AttachmentInfo item={item} scopeCurrent={scopeMatches(scope)} />}
    <div className="attach-viewer-foot">
      {editable && <Button className="attach-viewer-act" onClick={() => {
        haptic(2);
        // The editor replaces the viewer rather than stacking over it.
        leaveNow();
        void editImage(scope, item.localId, (input) => presentImageEditor(input));
      }}><PenLine size={16} aria-hidden="true" />{attachT("viewer.markup")}</Button>}
      {editable && <Button className="attach-viewer-act" aria-pressed={original}
        onClick={() => {
          haptic(2);
          changeQuality(scope, item.localId, original ? "smart" : "original");
        }}>{attachT("viewer.qualityOn", { quality })}</Button>}
      <Button className="attach-viewer-act" aria-expanded={info} onClick={() => setInfo(!info)}>
        <Info size={16} aria-hidden="true" />{attachT("viewer.info")}
      </Button>
    </div>
  </div>;
}

/**
 * Open the viewer on tray item `index` of `scope`. `from` is the thumbnail it
 * was opened from: the picture grows out of it when it is on screen.
 */
export function presentAttachmentViewer(scope: AttachmentScope, index: number, from: Element | null = null): void {
  const origin = flightEnd(from);
  presentModal<void>((modal) => {
    // Dismissing plays the exit first. Another viewer taking this one's place still closes it at once.
    const viewer: ModalController<void> = { ...modal, dismiss: () => closeViewer(modal.dialog.current, () => modal.dismiss()) };
    return <ModalFrame modal={viewer} title="" className="attach-viewer" heading={<></>}>
      <ViewerBody modal={viewer} scope={scope} start={index} origin={origin} leaveNow={() => modal.dismiss()} />
    </ModalFrame>;
  }, { replaceKey: "attach-viewer" });
}
