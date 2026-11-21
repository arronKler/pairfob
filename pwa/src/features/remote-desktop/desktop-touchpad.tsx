import { useRef, useState } from "react";
import { Keyboard, Pointer, ZoomIn, ZoomOut } from "lucide-react";
import { t } from "../../lib/i18n";
import type { DesktopEvent } from "../../lib/protocol/remote-desktop";
import { Button } from "../../shared/ui/primitives";
import type { ScreenPoint } from "./trackpad-aim";

type TouchpadProps = {
  canControl: boolean;
  stalled: boolean;
  zoom: number;
  imeOpen: boolean;
  dragLock: boolean;
  cursor: ScreenPoint;
  onCursorMove: (next: ScreenPoint) => void;
  onSend: (event: DesktopEvent) => boolean;
  onToggleIme: () => void;
  onToggleZoom: () => void;
  onSwitchDirect: () => void;
  onToggleDragLock: () => void;
};

type TrackpadPointer = {
  x: number;
  y: number;
  startX: number;
  startY: number;
  at: number;
};

const TWO_FINGER_PAIR_MS = 120;
const TWO_FINGER_TAP_MS = 320;
const TWO_FINGER_TAP_MOVE_PX = 12;
const TWO_FINGER_SCROLL_DEADZONE_PX = 4;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampScroll(delta: number): number {
  const clamped = Math.max(-1500, Math.min(1500, Math.round(delta)));
  return clamped === 0 ? 0 : clamped;
}

export function DesktopTouchpad({
  canControl,
  stalled,
  zoom,
  imeOpen,
  dragLock,
  cursor,
  onCursorMove,
  onSend,
  onToggleIme,
  onToggleZoom,
  onSwitchDirect,
  onToggleDragLock,
}: TouchpadProps) {
  const padRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef<Map<number, TrackpadPointer>>(new Map());
  const multiTouchRef = useRef(false);
  const singleMovedRef = useRef(false);
  const twoFingerTapRef = useRef<{ eligible: boolean; startedAt: number; maxDelta: number } | null>(null);
  const [glow, setGlow] = useState<{ x: number; y: number } | null>(null);

  const disabled = !canControl || stalled;

  function updateGlow(clientX: number, clientY: number) {
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect) return;
    setGlow({ x: clientX - rect.left, y: clientY - rect.top });
  }

  function sendClick(button: "left" | "right") {
    if (disabled) return;
    onSend({ kind: "down", ...cursor, button });
    onSend({ kind: "up", ...cursor, button });
  }

  function clearPointer(pointerId: number) {
    const pointers = pointersRef.current;
    if (!pointers.has(pointerId)) return;
    pointers.delete(pointerId);
    twoFingerTapRef.current = null;
    if (pointers.size === 0) {
      multiTouchRef.current = false;
      singleMovedRef.current = false;
      setGlow(null);
    }
  }

  return (
    <div className="rd-touch-dock">
      <div className="rd-quick-strip">
        <Button
          className={`rd-qchip${imeOpen ? " is-active" : ""}`}
          disabled={!canControl}
          onClick={onToggleIme}
        >
          <Keyboard size={14} aria-hidden="true" />
          <span>{t("desktop.imeDrawer")}</span>
        </Button>
        <Button
          className={`rd-qchip${zoom > 1 ? " is-active" : ""}`}
          onClick={onToggleZoom}
        >
          {zoom > 1 ? <ZoomOut size={14} aria-hidden="true" /> : <ZoomIn size={14} aria-hidden="true" />}
          <span>{zoom > 1 ? t("desktop.zoomFit") : t("desktop.zoom2x")}</span>
        </Button>
        <Button className="rd-qchip" onClick={onSwitchDirect}>
          <Pointer size={14} aria-hidden="true" />
          <span>{t("desktop.directTap")}</span>
        </Button>
        <Button
          className="rd-qchip"
          disabled={disabled}
          onClick={() => onSend({ kind: "key", code: "Escape", modifiers: 0 })}
        >
          Esc
        </Button>
      </div>

      <div
        ref={padRef}
        className={`rd-trackpad-surface${disabled ? " is-disabled" : ""}`}
        role="application"
        aria-label={t("desktop.trackpad")}
        onPointerDown={event => {
          if (disabled) return;
          padRef.current?.setPointerCapture?.(event.pointerId);
          const now = Date.now();
          const pointers = pointersRef.current;
          pointers.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
            startX: event.clientX,
            startY: event.clientY,
            at: now,
          });
          if (pointers.size === 1 && !multiTouchRef.current) {
            singleMovedRef.current = false;
            twoFingerTapRef.current = null;
            updateGlow(event.clientX, event.clientY);
          } else if (pointers.size === 2) {
            multiTouchRef.current = true;
            setGlow(null);
            const [first, second] = [...pointers.values()];
            const firstAt = Math.min(first.at, second.at);
            const secondAt = Math.max(first.at, second.at);
            const dFirst = Math.hypot(first.x - first.startX, first.y - first.startY);
            const dSecond = Math.hypot(second.x - second.startX, second.y - second.startY);
            const maxDelta = Math.max(dFirst, dSecond);
            twoFingerTapRef.current = {
              eligible: (secondAt - firstAt) <= TWO_FINGER_PAIR_MS && maxDelta < TWO_FINGER_TAP_MOVE_PX,
              startedAt: firstAt,
              maxDelta,
            };
          } else {
            multiTouchRef.current = true;
            setGlow(null);
            twoFingerTapRef.current = null;
          }
        }}
        onPointerMove={event => {
          const pointers = pointersRef.current;
          const prev = pointers.get(event.pointerId);
          if (!prev || disabled) return;
          const dx = event.clientX - prev.x;
          const dy = event.clientY - prev.y;
          const totalMoved = Math.hypot(event.clientX - prev.startX, event.clientY - prev.startY);
          pointers.set(event.pointerId, { ...prev, x: event.clientX, y: event.clientY });

          if (multiTouchRef.current) {
            const tap = twoFingerTapRef.current;
            if (tap) {
              tap.maxDelta = Math.max(tap.maxDelta, totalMoved);
              if (totalMoved >= TWO_FINGER_TAP_MOVE_PX) tap.eligible = false;
            }
            if (pointers.size >= 2) {
              if (tap?.eligible && tap.maxDelta < TWO_FINGER_SCROLL_DEADZONE_PX) return;
              const sx = clampScroll((-dx * 2) / pointers.size);
              const sy = clampScroll((-dy * 2) / pointers.size);
              if (sx !== 0 || sy !== 0) {
                onSend({ kind: "scroll", ...cursor, dx: sx, dy: sy });
              }
            }
            return;
          }

          if (Math.hypot(dx, dy) > 2 || totalMoved > 2) singleMovedRef.current = true;
          const rect = padRef.current?.getBoundingClientRect();
          const scaleX = rect && rect.width > 0 ? 1 / rect.width : 1 / 320;
          const scaleY = rect && rect.height > 0 ? 1 / rect.height : 1 / 200;
          const next = {
            x: clamp01(cursor.x + dx * scaleX),
            y: clamp01(cursor.y + dy * scaleY),
          };
          if (onSend({ kind: "move", ...next })) {
            onCursorMove(next);
          }
          updateGlow(event.clientX, event.clientY);
        }}
        onPointerUp={event => {
          const pointers = pointersRef.current;
          const prev = pointers.get(event.pointerId);
          if (!prev) return;
          pointers.delete(event.pointerId);
          const totalMoved = Math.hypot(event.clientX - prev.startX, event.clientY - prev.startY);
          const tap = twoFingerTapRef.current;
          if (tap) {
            tap.maxDelta = Math.max(tap.maxDelta, totalMoved);
            if (totalMoved >= TWO_FINGER_TAP_MOVE_PX) tap.eligible = false;
          }
          if (pointers.size > 0) return;

          setGlow(null);
          if (multiTouchRef.current) {
            multiTouchRef.current = false;
            singleMovedRef.current = false;
            twoFingerTapRef.current = null;
            const elapsed = Date.now() - (tap?.startedAt ?? 0);
            if (tap && tap.eligible && tap.maxDelta < TWO_FINGER_TAP_MOVE_PX && elapsed <= TWO_FINGER_TAP_MS && !disabled) {
              sendClick("right");
            }
            return;
          }

          const moved = singleMovedRef.current;
          singleMovedRef.current = false;
          if (!moved && !dragLock && !disabled) sendClick("left");
        }}
        onPointerCancel={event => clearPointer(event.pointerId)}
        onLostPointerCapture={event => clearPointer(event.pointerId)}
      >
        {glow && (
          <span
            className="rd-tp-glow"
            aria-hidden="true"
            style={{ left: `${glow.x}px`, top: `${glow.y}px` }}
          />
        )}
        <div className="rd-tp-hint">
          {dragLock ? t("desktop.trackpadDragHint") : t("desktop.trackpadHint")}
        </div>
        <div className="rd-tp-sub">{t("desktop.trackpadTwoFingerSub")}</div>
      </div>

      <div className="rd-tp-buttons">
        <Button className="rd-tp-btn" disabled={disabled} onClick={() => sendClick("left")}>
          {t("desktop.leftClick")}
        </Button>
        <Button
          className={`rd-tp-btn${dragLock ? " is-locked" : ""}`}
          disabled={disabled}
          aria-pressed={dragLock}
          onClick={onToggleDragLock}
        >
          {dragLock ? t("desktop.dragRelease") : t("desktop.dragLock")}
        </Button>
        <Button className="rd-tp-btn" disabled={disabled} onClick={() => sendClick("right")}>
          {t("desktop.rightClick")}
        </Button>
      </div>
    </div>
  );
}
