import {
  ChevronLeft,
  Eye,
  Keyboard,
  Maximize2,
  Minimize2,
  MousePointer2,
  PanelLeft,
  Power,
  SlidersHorizontal,
  Volume2,
  VolumeX,
} from "lucide-react";
import { t } from "../../lib/i18n";
import { Button, SegmentedControl, SegmentedOption } from "../../shared/ui/primitives";
import type { DesktopMode } from "./desktop-prefs";
import type { DesktopPopoverKind } from "./desktop-popovers";

type DesktopTopBarProps = {
  hostName: string;
  displayName: string;
  live: boolean;
  stalled: boolean;
  rttMs?: number;
  mode: DesktopMode;
  canControl: boolean;
  audioActive: boolean;
  muted: boolean;
  fullscreen: boolean;
  canFullscreen: boolean;
  phonePortrait: boolean;
  touchUi: boolean;
  railCollapsed?: boolean;
  attentionCount?: number;
  activePopover: DesktopPopoverKind | null;
  onBack?: () => void;
  onToggleRail?: () => void;
  onOpenAttention?: () => void;
  onSwitchMode: (next: DesktopMode) => void;
  onTogglePopover: (kind: DesktopPopoverKind) => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onDisconnect: () => void;
};

export function DesktopTopBar({
  hostName,
  displayName,
  live,
  stalled,
  rttMs,
  mode,
  canControl,
  audioActive,
  muted,
  fullscreen,
  canFullscreen,
  phonePortrait,
  touchUi,
  railCollapsed,
  attentionCount = 0,
  activePopover,
  onBack,
  onToggleRail,
  onOpenAttention,
  onSwitchMode,
  onTogglePopover,
  onToggleMute,
  onToggleFullscreen,
  onDisconnect,
}: DesktopTopBarProps) {
  const showAttention = live && attentionCount > 0 && (phonePortrait || railCollapsed || fullscreen);
  const chipTitle = phonePortrait ? (displayName || hostName) : (displayName ? `${hostName} · ${displayName}` : hostName);
  const metricText = stalled
    ? t("desktop.stalledChip")
    : rttMs !== undefined
      ? `P2P ${Math.round(rttMs)}ms`
      : "P2P";

  return (
    <header className={`rd-topbar${fullscreen ? " is-floating" : ""}${phonePortrait ? " is-compact" : ""}`}>
      {phonePortrait ? (
        live && onBack ? (
          <Button className="rd-tb-btn rd-tb-back is-icon" onClick={onBack} aria-label={t("desktop.back")}>
            <ChevronLeft size={20} aria-hidden="true" />
          </Button>
        ) : (
          <span className="rd-tb-title">{t("desktop.title")}</span>
        )
      ) : (
        onToggleRail && (
          <Button
            className="rd-tb-btn"
            onClick={onToggleRail}
            aria-label={t("desktop.toggleRail")}
            title={t("desktop.toggleRail")}
          >
            <PanelLeft size={16} aria-hidden="true" />
          </Button>
        )
      )}

      {(!phonePortrait || live) && (
        <Button
          className={`rd-host-chip${phonePortrait ? " is-compact" : ""}${activePopover === "stats" ? " is-active" : ""}`}
          onClick={() => onTogglePopover("stats")}
          aria-expanded={activePopover === "stats"}
          title={t("desktop.stats")}
        >
          {phonePortrait ? (
            <span className={`rd-metric-pill${stalled ? " is-warn" : ""}`}>
              <span className={`rd-status-dot${live ? "" : " is-idle"}`} aria-hidden="true" />
              <span>{metricText}</span>
            </span>
          ) : (
            <>
              <span className={`rd-status-dot${live ? "" : " is-idle"}`} aria-hidden="true" />
              <span className="rd-host-chip-name">{chipTitle}</span>
              {live && (
                <span className={`rd-metric-pill${stalled ? " is-warn" : ""}`}>{metricText}</span>
              )}
            </>
          )}
        </Button>
      )}

      {live && !phonePortrait && canControl && (
        <SegmentedControl className="rd-mode-seg" aria-label={t("desktop.mode")}>
          <SegmentedOption selected={mode === "view"} onClick={() => onSwitchMode("view")}>
            {t("desktop.modeViewShort")}
          </SegmentedOption>
          <SegmentedOption selected={mode === "control"} onClick={() => onSwitchMode("control")}>
            {t("desktop.modeControlShort")}
          </SegmentedOption>
        </SegmentedControl>
      )}

      <div className="rd-tb-spacer" />

      {showAttention && onOpenAttention && (
        <Button className="rd-tb-hit rd-attn-btn" onClick={onOpenAttention} aria-label={t("desktop.attention", { count: attentionCount })}>
          <span className="rd-attn-pill">{t("desktop.attention", { count: attentionCount })}</span>
        </Button>
      )}

      {live && (
        <>
          {phonePortrait && canControl && (
            <Button
              className={`rd-tb-hit rd-mode-btn${mode === "control" ? " is-active" : ""}`}
              onClick={() => onSwitchMode(mode === "control" ? "view" : "control")}
              aria-label={mode === "control" ? t("desktop.modeControlShort") : t("desktop.modeViewShort")}
            >
              <span className={`rd-mode-pill${mode === "control" ? " is-active" : ""}`}>
                {mode === "control" ? <MousePointer2 size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
                <span>{mode === "control" ? t("desktop.modeControlCompact") : t("desktop.modeViewCompact")}</span>
              </span>
            </Button>
          )}

          {!phonePortrait && !touchUi && mode === "control" && canControl && (
            <Button
              className={`rd-tb-btn${activePopover === "shortcuts" ? " is-active" : ""}`}
              onClick={() => onTogglePopover("shortcuts")}
              aria-expanded={activePopover === "shortcuts"}
            >
              <Keyboard size={15} aria-hidden="true" />
              <span>{t("desktop.shortcuts")}</span>
            </Button>
          )}

          {!phonePortrait && !touchUi && audioActive && (
            <Button
              className={`rd-tb-btn${muted ? "" : " is-active"}`}
              onClick={onToggleMute}
              aria-label={t("desktop.mute")}
              aria-pressed={muted}
              title={t("desktop.mute")}
            >
              {muted ? <VolumeX size={15} aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}
            </Button>
          )}

          <Button
            className={`rd-tb-btn${phonePortrait ? " is-icon" : ""}${activePopover === "quality" ? " is-active" : ""}`}
            onClick={() => onTogglePopover("quality")}
            aria-expanded={activePopover === "quality"}
            aria-label={t("desktop.qualityAudio")}
            title={t("desktop.qualityAudio")}
          >
            <SlidersHorizontal size={phonePortrait ? 17 : 15} aria-hidden="true" />
          </Button>

          {!phonePortrait && canFullscreen && (
            <Button
              className="rd-tb-btn"
              onClick={onToggleFullscreen}
              aria-label={t("desktop.full")}
              title={t("desktop.full")}
            >
              {fullscreen ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
            </Button>
          )}

          <Button
            className={`rd-tb-btn is-danger${phonePortrait ? " is-icon" : ""}`}
            onClick={onDisconnect}
            aria-label={t("desktop.disconnect")}
            title={t("desktop.disconnect")}
          >
            <Power size={phonePortrait ? 17 : 15} aria-hidden="true" />
            {!phonePortrait && <span>{t("desktop.disconnect")}</span>}
          </Button>
        </>
      )}
    </header>
  );
}
