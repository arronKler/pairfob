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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampScroll(delta: number): number {
  return Math.max(-1500, Math.min(1500, Math.round(delta)));
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const tracking = useRef<{ active: boolean; moved: boolean; x: number; y: number }>({
    active: false,
    moved: false,
    x: 0,
    y: 0,
  });
  const scrolling = useRef<{ active: boolean; y: number }>({ active: false, y: 0 });
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
          if (disabled || event.target === scrollRef.current) return;
          padRef.current?.setPointerCapture?.(event.pointerId);
          tracking.current = { active: true, moved: false, x: event.clientX, y: event.clientY };
          updateGlow(event.clientX, event.clientY);
        }}
        onPointerMove={event => {
          if (!tracking.current.active || disabled) return;
          const dx = event.clientX - tracking.current.x;
          const dy = event.clientY - tracking.current.y;
          if (Math.hypot(dx, dy) > 2) tracking.current.moved = true;
          tracking.current.x = event.clientX;
          tracking.current.y = event.clientY;
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
        onPointerUp={() => {
          if (!tracking.current.active) return;
          const { moved } = tracking.current;
          tracking.current.active = false;
          setGlow(null);
          if (!moved && !dragLock && !disabled) sendClick("left");
        }}
        onPointerCancel={() => {
          tracking.current.active = false;
          setGlow(null);
        }}
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
        <div className="rd-tp-sub">{t("desktop.trackpadSub")}</div>

        <div
          ref={scrollRef}
          className="rd-scroll-rail"
          aria-label={t("desktop.scrollRail")}
          onPointerDown={event => {
            event.stopPropagation();
            if (disabled) return;
            scrollRef.current?.setPointerCapture?.(event.pointerId);
            scrolling.current = { active: true, y: event.clientY };
          }}
          onPointerMove={event => {
            if (!scrolling.current.active || disabled) return;
            const dy = event.clientY - scrolling.current.y;
            scrolling.current.y = event.clientY;
            if (dy !== 0) onSend({ kind: "scroll", ...cursor, dx: 0, dy: clampScroll(dy * 2) });
          }}
          onPointerUp={() => { scrolling.current.active = false; }}
          onPointerCancel={() => { scrolling.current.active = false; }}
        >
          {t("desktop.scrollRail")}
        </div>
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
