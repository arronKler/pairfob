import { useRef, useState } from "react";
import { ChevronLeft, GripVertical, Hand, Keyboard, Pointer, Power, SlidersHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import type { DesktopPopoverKind } from "./desktop-popovers";
import type { DesktopMode, DesktopTouchMode } from "./desktop-prefs";

type DesktopHudProps = {
  stageRef: React.RefObject<HTMLDivElement | null>;
  mode: DesktopMode;
  canControl: boolean;
  touchMode: DesktopTouchMode;
  zoom: number;
  imeOpen: boolean;
  rttMs?: number;
  showBackAndPower: boolean;
  attentionCount?: number;
  activePopover?: DesktopPopoverKind | null;
  onBack?: () => void;
  onOpenAttention?: () => void;
  onTogglePopover?: (kind: DesktopPopoverKind) => void;
  onToggleTouchMode: () => void;
  onRightClick: () => void;
  onToggleIme: () => void;
  onToggleZoom: () => void;
  onDisconnect: () => void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function DesktopHud({
  stageRef,
  mode,
  canControl,
  touchMode,
  zoom,
  imeOpen,
  rttMs,
  showBackAndPower,
  attentionCount = 0,
  activePopover = null,
  onBack,
  onOpenAttention,
  onTogglePopover,
  onToggleTouchMode,
  onRightClick,
  onToggleIme,
  onToggleZoom,
  onDisconnect,
}: DesktopHudProps) {
  const [expanded, setExpanded] = useState(true);
  const [pos, setPos] = useState({ x: 50, y: 86 });
  const dragging = useRef(false);

  const grip = (
    <span
      className="rd-fp-grip"
      title={t("desktop.hudGrip")}
      aria-hidden="true"
      onPointerDown={event => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragging.current = true;
      }}
      onPointerMove={event => {
        if (!dragging.current || !stageRef.current) return;
        const rect = stageRef.current.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        setPos({
          x: clamp(((event.clientX - rect.left) / rect.width) * 100, 14, 86),
          y: clamp(((event.clientY - rect.top) / rect.height) * 100, 12, 90),
        });
      }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
    >
      <GripVertical size={13} />
    </span>
  );

  const zoomLabel = zoom > 1 ? `${Number(zoom.toFixed(1))}×` : t("desktop.fit");

  if (!expanded) {
    return (
      <div className="rd-floating-hud" style={{ left: `${pos.x}%`, top: `${pos.y}%` }} onClick={event => event.stopPropagation()}>
        <div className="rd-floating-pill">
          {grip}
          <Button
            className={`rd-fp-btn is-active${showBackAndPower && activePopover === "stats" ? " is-active" : ""}`}
            onClick={() => {
              if (showBackAndPower && onTogglePopover) {
                onTogglePopover("stats");
              } else {
                setExpanded(true);
              }
            }}
            aria-expanded={showBackAndPower && onTogglePopover ? activePopover === "stats" : undefined}
            aria-label={showBackAndPower && onTogglePopover ? t("desktop.stats") : undefined}
          >
            <span className="rd-status-dot" aria-hidden="true" />
            <span>
              {mode === "control" ? t("desktop.modeControlShort") : t("desktop.modeViewShort")}
              {rttMs !== undefined ? ` · ${Math.round(rttMs)}ms` : ""}
            </span>
            {!showBackAndPower && <span className="rd-fp-sub">{t("desktop.hudExpand")}</span>}
          </Button>
          {showBackAndPower && (
            <>
              {attentionCount > 0 && onOpenAttention && (
                <Button
                  className="rd-fp-btn rd-fp-attn"
                  onClick={onOpenAttention}
                  aria-label={t("desktop.attention", { count: attentionCount })}
                >
                  <span className="rd-attn-pill">{t("desktop.attention", { count: attentionCount })}</span>
                </Button>
              )}
              {onTogglePopover && (
                <Button
                  className={`rd-fp-btn${activePopover === "quality" ? " is-active" : ""}`}
                  onClick={() => onTogglePopover("quality")}
                  aria-label={t("desktop.qualityAudio")}
                  aria-expanded={activePopover === "quality"}
                  title={t("desktop.hudSettings")}
                >
                  <SlidersHorizontal size={14} aria-hidden="true" />
                </Button>
              )}
              <Button className="rd-fp-btn" onClick={() => setExpanded(true)}>
                <span className="rd-fp-sub">{t("desktop.hudExpand")}</span>
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rd-floating-hud" style={{ left: `${pos.x}%`, top: `${pos.y}%` }} onClick={event => event.stopPropagation()}>
      <div className="rd-floating-pill" role="toolbar" aria-label={t("desktop.title")}>
        {grip}
        {showBackAndPower && onBack && (
          <>
            <Button className="rd-fp-btn" onClick={onBack} aria-label={t("desktop.back")}>
              <ChevronLeft size={15} aria-hidden="true" />
              <span>{t("desktop.back")}</span>
            </Button>
            <span className="rd-fp-divider" aria-hidden="true" />
          </>
        )}

        {showBackAndPower && onTogglePopover && (
          <Button
            className={`rd-fp-btn rd-fp-stat${activePopover === "stats" ? " is-active" : ""}`}
            onClick={() => onTogglePopover("stats")}
            aria-label={t("desktop.stats")}
            aria-expanded={activePopover === "stats"}
            title={t("desktop.stats")}
          >
            <span className="rd-status-dot" aria-hidden="true" />
            <span>{rttMs !== undefined ? `P2P ${Math.round(rttMs)}ms` : "P2P"}</span>
          </Button>
        )}

        {showBackAndPower && attentionCount > 0 && onOpenAttention && (
          <Button
            className="rd-fp-btn rd-fp-attn"
            onClick={onOpenAttention}
            aria-label={t("desktop.attention", { count: attentionCount })}
          >
            <span className="rd-attn-pill">{t("desktop.attention", { count: attentionCount })}</span>
          </Button>
        )}

        {canControl && mode === "control" && (
          <>
            <Button
              className={`rd-fp-btn${touchMode === "trackpad" ? " is-active" : ""}`}
              onClick={onToggleTouchMode}
              aria-pressed={touchMode === "trackpad"}
            >
              {touchMode === "trackpad" ? <Hand size={14} aria-hidden="true" /> : <Pointer size={14} aria-hidden="true" />}
              <span>{touchMode === "trackpad" ? t("desktop.trackpad") : t("desktop.directTap")}</span>
            </Button>
            <Button className="rd-fp-btn" onClick={onRightClick}>
              {t("desktop.right")}
            </Button>
            <Button
              className={`rd-fp-btn${imeOpen ? " is-active" : ""}`}
              onClick={onToggleIme}
              aria-pressed={imeOpen}
            >
              <Keyboard size={14} aria-hidden="true" />
              <span>{t("desktop.imeDrawer")}</span>
            </Button>
          </>
        )}

        <Button
          className={`rd-fp-btn${zoom > 1 ? " is-active" : ""}`}
          onClick={onToggleZoom}
          aria-pressed={zoom > 1}
        >
          {zoom > 1 ? <ZoomOut size={14} aria-hidden="true" /> : <ZoomIn size={14} aria-hidden="true" />}
          <span>{zoomLabel}</span>
        </Button>

        {showBackAndPower && onTogglePopover && (
          <Button
            className={`rd-fp-btn${activePopover === "quality" ? " is-active" : ""}`}
            onClick={() => onTogglePopover("quality")}
            aria-label={t("desktop.qualityAudio")}
            aria-expanded={activePopover === "quality"}
            title={t("desktop.hudSettings")}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
          </Button>
        )}

        <span className="rd-fp-divider" aria-hidden="true" />

        <Button className="rd-fp-btn" onClick={() => setExpanded(false)}>
          {t("desktop.hudCollapse")}
        </Button>

        {showBackAndPower && (
          <Button className="rd-fp-btn is-danger" onClick={onDisconnect} aria-label={t("desktop.disconnect")}>
            <Power size={15} aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
