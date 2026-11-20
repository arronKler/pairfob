import { AlertTriangle } from "lucide-react";
import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { useComputers, useLiveSession } from "../computers/hooks";
import { useConnection } from "../connection/hooks";
import { useCapabilities } from "../operations/hooks";
import { DesktopHud } from "./desktop-hud";
import { DesktopIme } from "./desktop-ime";
import { useDesktopSurfaceMode } from "./desktop-input-mode";
import { DesktopPopovers } from "./desktop-popovers";
import { DesktopPreflight } from "./desktop-preflight";
import { setTouchMode } from "./desktop-prefs";
import { useDesktopSession } from "./desktop-session";
import { DesktopTopBar } from "./desktop-topbar";
import { DesktopTouchpad } from "./desktop-touchpad";
import { pictureBox } from "./trackpad-aim";
import "./desktop.scss";

export type DesktopScreenProps = {
  onBack?: () => void;
  onOpenSettings?: () => void;
  onRetryDirect?: () => void;
  onToggleRail?: () => void;
  railCollapsed?: boolean;
  attentionCount?: number;
  onOpenAttention?: () => void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function DesktopScreen({
  onBack,
  onOpenSettings,
  onRetryDirect,
  onToggleRail,
  railCollapsed,
  attentionCount,
  onOpenAttention,
}: DesktopScreenProps) {
  const host = useComputers().credential;
  const session = useLiveSession();
  const connectionState = useConnection();
  const caps = useCapabilities().operationCapabilities;
  const surface = useDesktopSurfaceMode();

  const direct = connectionState.sessionTransport === "p2p";
  const canView = caps.view_desktop === true;
  const canControl = caps.control_desktop === true;
  const canAudio = caps.listen_desktop_audio === true;
  const hostName = host ? computerTitle(host) : t("desktop.hostNode");

  const ds = useDesktopSession({ session, direct, canView, canControl, canAudio, surface });

  const isLive = ds.phase === "live";
  const showTopBar = !surface.phoneLandscape;
  const showTouchpad = isLive && surface.phonePortrait && surface.touchUi
    && ds.effectiveMode === "control" && ds.prefs.touchMode === "trackpad";
  const showFloatingHud = isLive && surface.touchUi && !showTouchpad;

  const zoomTx = ds.zoom > 1 ? clamp((0.5 - ds.cursor.x) * (ds.zoom - 1) * 55, -25, 25) : 0;
  const zoomTy = ds.zoom > 1 ? clamp((0.5 - ds.cursor.y) * (ds.zoom - 1) * 55, -25, 25) : 0;
  const minimapLeft = clamp(ds.cursor.x * 100 - 25, 0, 50);
  const minimapTop = clamp(ds.cursor.y * 100 - 25, 0, 50);

  const aimStyle = (() => {
    if (!showTouchpad) return undefined;
    const video = ds.videoRef.current;
    const box = video ? pictureBox(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight) : null;
    if (box) {
      return { left: `${box.x + ds.cursor.x * box.width}px`, top: `${box.y + ds.cursor.y * box.height}px` };
    }
    return { left: `${ds.cursor.x * 100}%`, top: `${ds.cursor.y * 100}%` };
  })();

  const preflightKind = !canView
    ? "unsupported"
    : !direct || !session?.desktop
      ? "relay"
      : ds.phase === "connecting"
        ? "connecting"
        : ds.phase === "reconnecting"
          ? "reconnecting"
          : ds.phase === "disconnected"
            ? "disconnected"
            : null;

  return (
    <div
      ref={ds.surfaceRef}
      className="rd-surface"
      onKeyDown={event => {
        if (event.key === "Escape" && (ds.activePopover || ds.imeOpen)) {
          ds.setActivePopover(null);
          ds.setImeOpen(false);
        }
      }}
    >
      {showTopBar && (
        <DesktopTopBar
          hostName={hostName}
          displayName={ds.displayName}
          live={isLive}
          stalled={ds.stalled}
          rttMs={ds.sample?.rttMS}
          mode={ds.effectiveMode}
          canControl={canControl}
          audioActive={ds.effectiveAudio}
          muted={ds.muted}
          fullscreen={ds.fullscreen}
          canFullscreen={Boolean(ds.surfaceRef.current?.requestFullscreen)}
          phonePortrait={surface.phonePortrait}
          touchUi={surface.touchUi}
          railCollapsed={railCollapsed}
          attentionCount={attentionCount}
          activePopover={ds.activePopover}
          onBack={onBack}
          onToggleRail={onToggleRail}
          onOpenAttention={onOpenAttention}
          onSwitchMode={ds.handleSwitchMode}
          onTogglePopover={kind => ds.setActivePopover(prev => (prev === kind ? null : kind))}
          onToggleMute={() => ds.setMuted(prev => !prev)}
          onToggleFullscreen={ds.handleToggleFullscreen}
          onDisconnect={() => ds.stopStream("disconnected", "", true)}
        />
      )}

      <div
        ref={ds.stageRef}
        className="rd-stage"
        onClick={() => {
          if (ds.activePopover) ds.setActivePopover(null);
        }}
      >
        <div
          className="rd-canvas"
          style={ds.zoom > 1 ? { transform: `scale(${ds.zoom}) translate(${zoomTx}%, ${zoomTy}%)` } : undefined}
        >
          <video
            ref={ds.videoRef}
            className="rd-video"
            style={{ touchAction: ds.effectiveMode === "control" ? "none" : "pan-x pan-y" }}
            muted={!ds.effectiveAudio || ds.muted}
            autoPlay
            playsInline
            disablePictureInPicture
            aria-label={t("desktop.screen")}
            tabIndex={isLive && ds.effectiveMode === "control" ? 0 : -1}
            onPlaying={ds.markPlaying}
          />
          {isLive && ds.effectiveMode === "control" && surface.touchUi && (
            <span
              ref={ds.ringRef}
              className={`rd-aim-ring${ds.dragLock ? " is-dragging" : ""}`}
              aria-hidden="true"
              hidden={!showTouchpad}
              style={aimStyle}
            />
          )}
        </div>

        {isLive && ds.zoom > 1 && (
          <div className="rd-zoom-minimap" aria-hidden="true">
            <span className="rd-zoom-minimap-box" style={{ left: `${minimapLeft}%`, top: `${minimapTop}%` }} />
          </div>
        )}

        {isLive && ds.effectiveMode === "control" && !surface.touchUi && (
          <div className="rd-kb-hint">{t("desktop.kbHint")}</div>
        )}

        {isLive && ds.stalled && (
          <div className="rd-frozen-veil" role="alert" aria-live="assertive">
            <div className="rd-frozen-pill">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{t("desktop.stalledBanner")}</span>
            </div>
          </div>
        )}

        {!isLive && preflightKind && (
          <DesktopPreflight
            kind={preflightKind}
            hostName={hostName}
            connectingStep={ds.connectingStep}
            reconnectAttempt={ds.reconnectAttempt}
            maxReconnectAttempts={ds.maxReconnectAttempts}
            mode={ds.effectiveMode}
            quality={ds.quality}
            error={ds.error}
            onReconnect={() => void ds.startStream(ds.effectiveMode, ds.quality, ds.effectiveAudio)}
            onRetryDirect={onRetryDirect}
            onCancel={() => ds.stopStream("disconnected", "", true)}
            onBack={onBack}
            onOpenSettings={onOpenSettings}
          />
        )}

        {showFloatingHud && (
          <DesktopHud
            stageRef={ds.stageRef}
            mode={ds.effectiveMode}
            canControl={canControl}
            touchMode={ds.prefs.touchMode}
            zoom={ds.zoom}
            imeOpen={ds.imeOpen}
            rttMs={ds.sample?.rttMS}
            showBackAndPower={surface.phoneLandscape}
            onBack={onBack}
            onToggleTouchMode={() => setTouchMode(ds.prefs.touchMode === "trackpad" ? "direct" : "trackpad")}
            onRightClick={ds.handleRightClick}
            onToggleIme={() => ds.setImeOpen(prev => !prev)}
            onToggleZoom={() => ds.setZoom(prev => (prev > 1 ? 1 : 2))}
            onDisconnect={() => ds.stopStream("disconnected", "", true)}
          />
        )}

        <div onClick={event => event.stopPropagation()}>
          <DesktopPopovers
            open={isLive ? ds.activePopover : null}
            sample={ds.sample}
            quality={ds.quality}
            displayName={ds.displayName}
            mode={ds.effectiveMode}
            canControl={canControl}
            audioSupported={canAudio}
            audioEnabled={ds.effectiveAudio}
            onClose={() => ds.setActivePopover(null)}
            onSwitchQuality={ds.handleSwitchQuality}
            onSwitchMode={ds.handleSwitchMode}
            onToggleAudio={ds.handleToggleAudio}
            onSendKey={ds.sendEvent}
          />
        </div>

        {isLive && ds.imeOpen && (
          <DesktopIme
            disabled={ds.effectiveMode !== "control" || ds.stalled}
            onSend={ds.sendEvent}
            onClose={() => ds.setImeOpen(false)}
          />
        )}
      </div>

      {showTouchpad && (
        <DesktopTouchpad
          canControl={ds.effectiveMode === "control"}
          stalled={ds.stalled}
          zoom={ds.zoom}
          imeOpen={ds.imeOpen}
          dragLock={ds.dragLock}
          cursor={ds.cursor}
          onCursorMove={ds.updateCursor}
          onSend={ds.sendEvent}
          onToggleIme={() => ds.setImeOpen(prev => !prev)}
          onToggleZoom={() => ds.setZoom(prev => (prev > 1 ? 1 : 2))}
          onSwitchDirect={() => setTouchMode("direct")}
          onToggleDragLock={ds.handleToggleDragLock}
        />
      )}
    </div>
  );
}
