import type { DesktopEvent } from "../../lib/protocol/remote-desktop";
import { pictureBox, type ScreenPoint } from "./trackpad-aim";

type Button = "left" | "right" | "middle";

/** Convert the contained video, including portrait displays, into host coordinates. */
export function screenPoint(rect: DOMRect, width: number, height: number, x: number, y: number, clamp = false): ScreenPoint | null {
  const box = pictureBox(rect.width, rect.height, width, height);
  if (!box) return null;
  const nx = (x - rect.left - box.x) / box.width;
  const ny = (y - rect.top - box.y) / box.height;
  if (!clamp && (nx < 0 || nx > 1 || ny < 0 || ny > 1)) return null;
  return { x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) };
}

export function attachScreenInput(video: HTMLVideoElement, send: (event: DesktopEvent) => boolean, trackpad: boolean,
  aim?: { show(point: ScreenPoint): void; hide(): void }, initial: ScreenPoint = { x: 0.5, y: 0.5 }) {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let cursor = initial;
  let button: Button | null = null;
  let dragTimer: ReturnType<typeof setTimeout> | undefined;
  let moved = false, multi = false;
  const touches = new Map<number, { x: number; y: number }>();
  let origin = { x: 0, y: 0 };
  const point = (e: MouseEvent, clamp = false) => screenPoint(video.getBoundingClientRect(),
    video.videoWidth, video.videoHeight, e.clientX, e.clientY, clamp);
  const release = () => {
    clearTimeout(dragTimer);
    if (button) send({ kind: "up", ...cursor, button });
    button = null;
  };
  const down = (b: Button, predict = false) => {
    if (!send({ kind: "down", ...cursor, button: b })) return;
    button = b;
    if (predict) aim?.show(cursor);
  };
  const scroll = (n: number) => Math.max(-1500, Math.min(1500, Math.round(n)));
  video.addEventListener("contextmenu", e => e.preventDefault(), options);
  video.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch") aim?.hide();
    const pt = point(e);
    if (!pt && !(trackpad && e.pointerType === "touch")) return;
    video.setPointerCapture(e.pointerId);
    if (e.pointerType !== "touch") {
      if (!pt) return;
      video.focus({ preventScroll: true });
      release(); cursor = pt; down(e.button === 2 ? "right" : e.button === 1 ? "middle" : "left"); return;
    }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size > 1) { multi = true; release(); aim?.hide(); return; }
    origin = { x: e.clientX, y: e.clientY }; moved = false; multi = false;
    if (!trackpad && pt) cursor = pt;
    dragTimer = setTimeout(() => down("left", trackpad), 420);
  }, options);
  video.addEventListener("pointermove", e => {
    if (e.pointerType !== "touch") {
      aim?.hide();
      const pt = point(e, !!button); if (pt) { cursor = pt; send({ kind: "move", ...pt }); }
      return;
    }
    const last = touches.get(e.pointerId); if (!last) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    if (multi) {
      if (touches.size >= 2) send({ kind: "scroll", ...cursor, dx: scroll(-dx / touches.size), dy: scroll(-dy / touches.size) });
      return;
    }
    if (Math.hypot(e.clientX-origin.x, e.clientY-origin.y) > 4) { moved = true; clearTimeout(dragTimer); }
    if (trackpad) {
      const rect = video.getBoundingClientRect();
      const box = pictureBox(rect.width, rect.height, video.videoWidth, video.videoHeight);
      if (!box || (!dx && !dy)) return;
      const next = { x: Math.max(0, Math.min(1, cursor.x + dx / box.width)),
        y: Math.max(0, Math.min(1, cursor.y + dy / box.height)) };
      if (send({ kind: "move", ...next })) { cursor = next; aim?.show(next); }
      return;
    } else {
      if (!moved && !button) return;
      if (!button) down("left");
      cursor = point(e, true) ?? cursor;
    }
    send({ kind: "move", ...cursor });
  }, options);
  video.addEventListener("pointerup", e => {
    if (e.pointerType === "touch" && !touches.delete(e.pointerId)) return;
    if (e.pointerType === "touch" && !multi && !moved && !button) down("left", trackpad);
    if (e.pointerType !== "touch" || !trackpad) cursor = point(e, true) ?? cursor;
    release();
  }, options);
  const cancel = () => { touches.clear(); multi = true; release(); aim?.hide(); };
  video.addEventListener("pointercancel", cancel, options);
  video.addEventListener("lostpointercapture", e => { if (touches.has(e.pointerId) || button) cancel(); }, options);
  video.addEventListener("blur", cancel, options);
  video.addEventListener("wheel", e => {
    const pt = point(e); if (!pt) return;
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? video.clientHeight : 1;
    send({ kind: "scroll", ...pt, dx: scroll(e.deltaX * scale), dy: scroll(e.deltaY * scale) });
  }, { ...options, passive: false });
  video.addEventListener("keydown", e => {
    if (e.isComposing || ["Shift","Control","Alt","Meta","Dead","Process"].includes(e.key)) return;
    // Keep a keyboard-only route out of the captured screen.
    if (e.key === "Tab" && e.shiftKey) return;
    e.preventDefault();
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) send({ kind: "text", text: e.key });
    else send({ kind: "key", code: e.code, modifiers: +e.shiftKey + 2*+e.ctrlKey + 4*+e.altKey + 8*+e.metaKey });
  }, options);
  return {
    position: () => cursor,
    rightClick() { send({ kind: "down", ...cursor, button: "right" }); send({ kind: "up", ...cursor, button: "right" }); },
    detach() { cancel(); controller.abort(); },
  };
}
