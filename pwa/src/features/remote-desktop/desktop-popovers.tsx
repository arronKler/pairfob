import { X } from "lucide-react";
import { t } from "../../lib/i18n";
import type { DesktopEvent, DesktopQuality } from "../../lib/protocol/remote-desktop";
import { Button } from "../../shared/ui/primitives";
import type { DesktopMetricSample } from "./desktop-metrics";
import type { DesktopMode } from "./desktop-prefs";

export type DesktopPopoverKind = "stats" | "quality" | "shortcuts";

type PopoversProps = {
  open: DesktopPopoverKind | null;
  sample: DesktopMetricSample | null;
  quality: DesktopQuality;
  displayName: string;
  mode: DesktopMode;
  canControl: boolean;
  audioSupported: boolean;
  audioEnabled: boolean;
  onClose: () => void;
  onSwitchQuality: (q: DesktopQuality) => void;
  onSwitchMode: (m: DesktopMode) => void;
  onToggleAudio: () => void;
  onSendKey: (event: Extract<DesktopEvent, { kind: "key" }>) => void;
};

const QUALITY_OPTIONS: ReadonlyArray<{ id: DesktopQuality; labelKey: "desktop.balanced" | "desktop.detail" | "desktop.motion"; descKey: "desktop.balancedDesc" | "desktop.detailDesc" | "desktop.motionDesc" }> = [
  { id: "balanced", labelKey: "desktop.balanced", descKey: "desktop.balancedDesc" },
  { id: "detail", labelKey: "desktop.detail", descKey: "desktop.detailDesc" },
  { id: "motion", labelKey: "desktop.motion", descKey: "desktop.motionDesc" },
];

const SYSTEM_SHORTCUTS: ReadonlyArray<{ keyLabel: string; nameKey: "desktop.key.switchApp" | "desktop.key.spotlight" | "desktop.key.copy" | "desktop.key.paste" | "desktop.key.closeWin" | "desktop.key.lockMac"; code: string; modifiers: number }> = [
  { keyLabel: "⌘Tab", nameKey: "desktop.key.switchApp", code: "Tab", modifiers: 8 },
  { keyLabel: "⌘Space", nameKey: "desktop.key.spotlight", code: "Space", modifiers: 8 },
  { keyLabel: "⌘C", nameKey: "desktop.key.copy", code: "KeyC", modifiers: 8 },
  { keyLabel: "⌘V", nameKey: "desktop.key.paste", code: "KeyV", modifiers: 8 },
  { keyLabel: "⌘W", nameKey: "desktop.key.closeWin", code: "KeyW", modifiers: 8 },
  { keyLabel: "⌃⌘Q", nameKey: "desktop.key.lockMac", code: "KeyQ", modifiers: 10 },
];

function formatMs(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(1)} ms`;
}

export function DesktopPopovers({
  open,
  sample,
  quality,
  displayName,
  mode,
  canControl,
  audioSupported,
  audioEnabled,
  onClose,
  onSwitchQuality,
  onSwitchMode,
  onToggleAudio,
  onSendKey,
}: PopoversProps) {
  if (!open) return null;

  if (open === "stats") {
    const res = sample?.width && sample?.height ? `${sample.width}×${sample.height}` : "—";
    const proto = sample?.protocol ? `P2P ${sample.protocol.toUpperCase()}` : "P2P";
    const rtt = sample?.rttMS !== undefined ? `${Math.round(sample.rttMS)} ms` : "—";
    const fps = sample?.fps !== undefined ? `${Math.round(sample.fps)} fps` : "—";
    const mbps = sample?.receivedMbps !== undefined ? `${sample.receivedMbps.toFixed(2)} Mbps` : "—";
    const dropped = sample?.dropped !== undefined ? String(sample.dropped) : "0";

    return (
      <div className="rd-popover is-left" role="dialog" aria-label={t("desktop.stats")}>
        <div className="rd-pop-head">
          <span>{t("desktop.diagTitle")}</span>
          <Button className="rd-pop-close" onClick={onClose} aria-label={t("desktop.close")}>
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
        <div className="rd-stat-grid">
          <div className="rd-stat-cell">
            <div className="rd-stat-k">{t("desktop.diagTransport")}</div>
            <div className="rd-stat-v is-ok">{proto}</div>
          </div>
          <div className="rd-stat-cell">
            <div className="rd-stat-k">{t("desktop.rtt")}</div>
            <div className="rd-stat-v">{rtt}</div>
          </div>
          <div className="rd-stat-cell">
            <div className="rd-stat-k">{t("desktop.diagRes")}</div>
            <div className="rd-stat-v">{res}</div>
          </div>
          <div className="rd-stat-cell">
            <div className="rd-stat-k">{t("desktop.diagRate")}</div>
            <div className="rd-stat-v">{fps} · {mbps}</div>
          </div>
        </div>
        <div className="rd-timing-row"><span>{t("desktop.encoding")}</span><b>{formatMs(sample?.encodeMS)}</b></div>
        <div className="rd-timing-row"><span>{t("desktop.buffer")}</span><b>{formatMs(sample?.jitterBufferMS)}</b></div>
        <div className="rd-timing-row"><span>{t("desktop.decoding")}</span><b>{formatMs(sample?.decodeMS)}</b></div>
        <div className="rd-timing-row"><span>{t("desktop.presentation")}</span><b>{formatMs(sample?.compositorMS)}</b></div>
        <div className="rd-timing-row"><span>{t("desktop.diagRelay")}</span><b className="is-ok">0 B · {dropped}</b></div>
      </div>
    );
  }

  if (open === "quality") {
    return (
      <div className="rd-popover" role="dialog" aria-label={t("desktop.qualityAudio")}>
        <div className="rd-pop-head">
          <span>{t("desktop.qualityAudio")}</span>
          <Button className="rd-pop-close" onClick={onClose} aria-label={t("desktop.close")}>
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
        <div className="rd-pop-hint">{t("desktop.qualitySwitchNote")}</div>
        <div className="rd-pop-grid-3">
          {QUALITY_OPTIONS.map(option => (
            <Button
              key={option.id}
              className={`rd-pop-option${quality === option.id ? " is-selected" : ""}`}
              onClick={() => onSwitchQuality(option.id)}
              aria-pressed={quality === option.id}
            >
              <span className="rd-pop-opt-title">{t(option.labelKey)}</span>
              <span className="rd-pop-opt-sub">{t(option.descKey)}</span>
            </Button>
          ))}
        </div>

        {canControl && (
          <div className="rd-pop-row">
            <span>{t("desktop.mode")}</span>
            <div className="rd-pop-pair">
              <Button
                className={`rd-pop-chip${mode === "view" ? " is-selected" : ""}`}
                onClick={() => onSwitchMode("view")}
              >
                {t("desktop.modeViewShort")}
              </Button>
              <Button
                className={`rd-pop-chip${mode === "control" ? " is-selected" : ""}`}
                onClick={() => onSwitchMode("control")}
              >
                {t("desktop.modeControlShort")}
              </Button>
            </div>
          </div>
        )}

        {displayName && (
          <div className="rd-pop-display">
            <div className="rd-pop-display-row">
              <span>{t("desktop.displayActive")}</span>
              <b>{displayName}</b>
            </div>
            <div className="rd-pop-hint">{t("desktop.displayNote")}</div>
          </div>
        )}

        <div className="rd-pop-row">
          <span>{t("desktop.audio")}</span>
          {audioSupported ? (
            <Button
              className={`rd-pop-chip${audioEnabled ? " is-selected" : ""}`}
              onClick={onToggleAudio}
              aria-pressed={audioEnabled}
            >
              {audioEnabled ? t("desktop.audioOn") : t("desktop.audioOff")}
            </Button>
          ) : (
            <span className="rd-pop-muted">{t("desktop.audioUnavailable")}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rd-popover rd-popover-shortcuts" role="dialog" aria-label={t("desktop.shortcuts")}>
      <div className="rd-pop-head">
        <span>{t("desktop.shortcuts")}</span>
        <Button className="rd-pop-close" onClick={onClose} aria-label={t("desktop.close")}>
          <X size={14} aria-hidden="true" />
        </Button>
      </div>
      <div className="rd-pop-hint">{t("desktop.shortcutsHint")}</div>
      <div className="rd-pop-grid-2">
        {SYSTEM_SHORTCUTS.map(item => (
          <Button
            key={item.keyLabel}
            className="rd-pop-option is-left"
            onClick={() => {
              onSendKey({ kind: "key", code: item.code, modifiers: item.modifiers });
              onClose();
            }}
          >
            <span className="rd-pop-mono">{item.keyLabel}</span>
            <span className="rd-pop-opt-sub">{t(item.nameKey)}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
