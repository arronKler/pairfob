import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle } from "lucide-react";
import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { useComputers, useLiveSession } from "../computers/hooks";
import { useConnection } from "../connection/hooks";
import { useCapabilities } from "../operations/hooks";
import { DesktopHud } from "./desktop-hud";
import { DesktopIme } from "./desktop-ime";
import { useDesktopSurfaceMode } from "./desktop-input-mode";
import { DesktopPopovers, type DesktopPopoverKind } from "./desktop-popovers";
import { DesktopPreflight } from "./desktop-preflight";
import { setTouchMode } from "./desktop-prefs";
import { useDesktopSession } from "./desktop-session";
import { DesktopTopBar } from "./desktop-topbar";
import { DesktopTouchpad } from "./desktop-touchpad";
import { pictureBox, type ScreenPoint } from "./trackpad-aim";
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

type GesturePointer = {
  x: number;
  y: number;
  startX: number;
  startY: number;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 3.5;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST_PX = 36;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function maxPanForZoom(zoom: number): number {
  return zoom > 1 ? ((zoom - 1) / (2 * zoom)) * 100 : 0;
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
  const canGestureZoom = isLive && (showTouchpad || ds.effectiveMode === "view");

  const [pan, setPan] = useState<ScreenPoint>({ x: 0, y: 0 });
  const [manualPan, setManualPan] = useState(false);
  const [gesturing, setGesturing] = useState(false);

  const gesturePointersRef = useRef<Map<number, GesturePointer>>(new Map());
  const pinchStartRef = useRef<{ dist: number; zoom: number; pan: ScreenPoint; midX: number; midY: number } | null>(null);
  const hadPinchRef = useRef(false);
  const lastTapRef = useRef<{ at: number; x: number; y: number } | null>(null);

  const maxPan = maxPanForZoom(ds.zoom);
  const followTx = ds.zoom > 1 ? clamp((0.5 - ds.cursor.x) * 2 * maxPan, -maxPan, maxPan) : 0;
  const followTy = ds.zoom > 1 ? clamp((0.5 - ds.cursor.y) * 2 * maxPan, -maxPan, maxPan) : 0;
  const zoomTx = ds.zoom > 1 ? (showTouchpad && !manualPan ? followTx : clamp(pan.x, -maxPan, maxPan)) : 0;
  const zoomTy = ds.zoom > 1 ? (showTouchpad && !manualPan ? followTy : clamp(pan.y, -maxPan, maxPan)) : 0;
  const minimapSize = ds.zoom > 1 ? 100 / ds.zoom : 50;
  const minimapLeft = ds.zoom > 1 ? clamp(maxPan - zoomTx, 0, 100 - minimapSize) : 0;
  const minimapTop = ds.zoom > 1 ? clamp(maxPan - zoomTy, 0, 100 - minimapSize) : 0;

  const zoomRef = useRef(ds.zoom);
  zoomRef.current = ds.zoom;
  const panRef = useRef(pan);
  panRef.current = pan;
  const manualPanRef = useRef(manualPan);
  manualPanRef.current = manualPan;
  const activePanRef = useRef<ScreenPoint>({ x: zoomTx, y: zoomTy });
  activePanRef.current = { x: zoomTx, y: zoomTy };

  useEffect(() => {
    if (!canGestureZoom || ds.zoom <= 1) {
      setPan({ x: 0, y: 0 });
      setManualPan(false);
      setGesturing(false);
    }
    if (!canGestureZoom) {
      gesturePointersRef.current.clear();
      pinchStartRef.current = null;
      hadPinchRef.current = false;
      lastTapRef.current = null;
    }
  }, [canGestureZoom, ds.zoom]);

  function resetPan() {
    const zero = { x: 0, y: 0 };
    panRef.current = zero;
    manualPanRef.current = false;
    setPan(zero);
    setManualPan(false);
  }

  function handleToggleZoom() {
    resetPan();
    const next = ds.zoom > 1 ? 1 : 2;
    zoomRef.current = next;
    ds.setZoom(next);
  }

  function togglePopover(kind: DesktopPopoverKind) {
    ds.setActivePopover(prev => (prev === kind ? null : kind));
  }

  function handleOpenAttention() {
    if (!onOpenAttention) return;
    if (isLive) {
      if (ds.dragLock) ds.handleToggleDragLock();
      ds.sendEvent({ kind: "release" });
      ds.setActivePopover(null);
    }
    onOpenAttention();
  }

  function handleCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!canGestureZoom) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const pointers = gesturePointersRef.current;
    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    });
    if (pointers.size === 2) {
      hadPinchRef.current = true;
      lastTapRef.current = null;
      const [first, second] = [...pointers.values()];
      pinchStartRef.current = {
        dist: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
        zoom: zoomRef.current,
        pan: { ...activePanRef.current },
        midX: (first.x + second.x) / 2,
        midY: (first.y + second.y) / 2,
      };
      setGesturing(true);
    }
  }

  function handleCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!canGestureZoom) return;
    const pointers = gesturePointersRef.current;
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    const dx = event.clientX - prev.x;
    const dy = event.clientY - prev.y;
    pointers.set(event.pointerId, { ...prev, x: event.clientX, y: event.clientY });

    const rect = ds.stageRef.current?.getBoundingClientRect();
    const stageW = rect && rect.width > 0 ? rect.width : 390;
    const stageH = rect && rect.height > 0 ? rect.height : 300;

    if (pointers.size >= 2 && pinchStartRef.current) {
      const [first, second] = [...pointers.values()];
      const dist = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const nextZoom = clamp(pinchStartRef.current.zoom * (dist / pinchStartRef.current.dist), MIN_ZOOM, MAX_ZOOM);
      const nextMaxPan = maxPanForZoom(nextZoom);
      const mdx = (first.x + second.x) / 2 - pinchStartRef.current.midX;
      const mdy = (first.y + second.y) / 2 - pinchStartRef.current.midY;
      const nextPan = {
        x: clamp(pinchStartRef.current.pan.x + (mdx / (stageW * nextZoom)) * 100, -nextMaxPan, nextMaxPan),
        y: clamp(pinchStartRef.current.pan.y + (mdy / (stageH * nextZoom)) * 100, -nextMaxPan, nextMaxPan),
      };
      zoomRef.current = nextZoom;
      panRef.current = nextPan;
      manualPanRef.current = true;
      ds.setZoom(nextZoom);
      setManualPan(true);
      setPan(nextPan);
      return;
    }

    if (pointers.size === 1 && !hadPinchRef.current && zoomRef.current > 1) {
      if (Math.hypot(event.clientX - prev.startX, event.clientY - prev.startY) <= 4) return;
      setGesturing(true);
      const curZoom = zoomRef.current;
      const curMaxPan = maxPanForZoom(curZoom);
      const base = manualPanRef.current ? panRef.current : activePanRef.current;
      const nextPan = {
        x: clamp(base.x + (dx / (stageW * curZoom)) * 100, -curMaxPan, curMaxPan),
        y: clamp(base.y + (dy / (stageH * curZoom)) * 100, -curMaxPan, curMaxPan),
      };
      panRef.current = nextPan;
      manualPanRef.current = true;
      setManualPan(true);
      setPan(nextPan);
    }
  }

  function handleCanvasPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const pointers = gesturePointersRef.current;
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    pointers.delete(event.pointerId);

    if (pointers.size < 2 && pinchStartRef.current) {
      pinchStartRef.current = null;
      if (zoomRef.current < 1.08) {
        zoomRef.current = 1;
        ds.setZoom(1);
        resetPan();
      }
    }
    if (pointers.size > 0) return;

    setGesturing(false);
    const wasPinch = hadPinchRef.current;
    hadPinchRef.current = false;
    const totalMoved = Math.hypot(event.clientX - prev.startX, event.clientY - prev.startY);
    if (!canGestureZoom || wasPinch || totalMoved >= 12) return;

    const now = Date.now();
    const last = lastTapRef.current;
    if (last && now - last.at <= DOUBLE_TAP_MS && Math.hypot(event.clientX - last.x, event.clientY - last.y) < DOUBLE_TAP_DIST_PX) {
      lastTapRef.current = null;
      resetPan();
      const next = zoomRef.current > 1 ? 1 : DOUBLE_TAP_ZOOM;
      zoomRef.current = next;
      ds.setZoom(next);
    } else {
      lastTapRef.current = { at: now, x: event.clientX, y: event.clientY };
    }
  }

  function clearCanvasPointer(pointerId: number) {
    const pointers = gesturePointersRef.current;
    if (!pointers.has(pointerId)) return;
    pointers.delete(pointerId);
    if (pointers.size < 2) pinchStartRef.current = null;
    if (pointers.size === 0) {
      hadPinchRef.current = false;
      setGesturing(false);
    }
  }

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
          onOpenAttention={onOpenAttention ? handleOpenAttention : undefined}
          onSwitchMode={ds.handleSwitchMode}
          onTogglePopover={togglePopover}
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
          className={`rd-canvas${gesturing ? " is-gesturing" : ""}`}
          style={{
            ...(ds.zoom > 1 ? { transform: `scale(${ds.zoom}) translate(${zoomTx}%, ${zoomTy}%)` } : {}),
            ...(canGestureZoom ? { touchAction: "none" } : {}),
          }}
          onPointerDown={canGestureZoom ? handleCanvasPointerDown : undefined}
          onPointerMove={canGestureZoom ? handleCanvasPointerMove : undefined}
          onPointerUp={canGestureZoom ? handleCanvasPointerUp : undefined}
          onPointerCancel={canGestureZoom ? event => clearCanvasPointer(event.pointerId) : undefined}
          onLostPointerCapture={canGestureZoom ? event => clearCanvasPointer(event.pointerId) : undefined}
        >
          <video
            ref={ds.videoRef}
            className="rd-video"
            style={{ touchAction: ds.effectiveMode === "control" || canGestureZoom ? "none" : "pan-x pan-y" }}
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
            <span
              className="rd-zoom-minimap-box"
              style={{
                width: `${minimapSize}%`,
                height: `${minimapSize}%`,
                left: `${minimapLeft}%`,
                top: `${minimapTop}%`,
              }}
            />
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
            reasonKind={ds.reasonKind}
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
            attentionCount={attentionCount}
            activePopover={ds.activePopover}
            onBack={onBack}
            onOpenAttention={onOpenAttention ? handleOpenAttention : undefined}
            onTogglePopover={togglePopover}
            onToggleTouchMode={() => setTouchMode(ds.prefs.touchMode === "trackpad" ? "direct" : "trackpad")}
            onRightClick={ds.handleRightClick}
            onToggleIme={() => ds.setImeOpen(prev => !prev)}
            onToggleZoom={handleToggleZoom}
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
          onToggleZoom={handleToggleZoom}
          onSwitchDirect={() => setTouchMode("direct")}
          onToggleDragLock={ds.handleToggleDragLock}
        />
      )}
    </div>
  );
}
