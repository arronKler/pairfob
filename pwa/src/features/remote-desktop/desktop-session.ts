import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { ProtocolError } from "../../lib/protocol/errors";
import type { DesktopEvent, DesktopQuality } from "../../lib/protocol/remote-desktop";
import type { LiveSession } from "../../lib/protocol/session-types";
import { DesktopConnection } from "./connection";
import type { DesktopSurfaceMode } from "./desktop-input-mode";
import type { DesktopMetricSample } from "./desktop-metrics";
import type { DesktopPopoverKind } from "./desktop-popovers";
import { useDesktopPrefs, type DesktopMode } from "./desktop-prefs";
import { isAutoRetryableDesktopError, parseDesktopReason, type DesktopReasonKind } from "./desktop-reason";
import { setDesktopLive } from "./desktop-status";
import { attachScreenInput } from "./screen-input";
import { trackpadAim, type ScreenPoint } from "./trackpad-aim";

export { isAutoRetryableDesktopError, parseDesktopReason, type DesktopReasonKind } from "./desktop-reason";

export type StreamPhase = "preflight" | "connecting" | "live" | "reconnecting" | "disconnected";

const AUTO_RECONNECT_DELAYS_MS = [800, 1500, 2500, 4000] as const;
export const MAX_AUTO_RECONNECT_ATTEMPTS = AUTO_RECONNECT_DELAYS_MS.length;

type WakeLockSentinelLike = {
  released?: boolean;
  release(): Promise<void>;
};

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request(type: "screen"): Promise<WakeLockSentinelLike>;
  };
};

type UseDesktopSessionArgs = {
  session: LiveSession | null;
  direct: boolean;
  canView: boolean;
  canControl: boolean;
  canAudio: boolean;
  surface: DesktopSurfaceMode;
};

export function useDesktopSession({
  session,
  direct,
  canView,
  canControl,
  canAudio,
  surface,
}: UseDesktopSessionArgs) {
  const prefs = useDesktopPrefs();
  const canStart = Boolean(direct && canView && session?.desktop);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const connRef = useRef<DesktopConnection | null>(null);
  const inputRef = useRef<ReturnType<typeof attachScreenInput> | null>(null);
  const attemptRef = useRef(0);
  const manualStopRef = useRef(false);
  const resumeOnVisibleRef = useRef(false);
  const autoRetryCountRef = useRef(0);
  const reconnectTimerRef = useRef(0);
  const streamGrantedControlRef = useRef(false);
  const cursorRef = useRef<ScreenPoint>({ x: 0.5, y: 0.5 });

  const [phase, setPhase] = useState<StreamPhase>("preflight");
  const [connectingStep, setConnectingStep] = useState<"p2p" | "media">("p2p");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [error, setError] = useState("");
  const [reasonKind, setReasonKind] = useState<DesktopReasonKind | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<DesktopMode>(() => (canControl ? prefs.defaultMode : "view"));
  const [quality, setQuality] = useState<DesktopQuality>(prefs.defaultQuality);
  const [audioEnabled, setAudioEnabled] = useState<boolean>(() => canAudio && prefs.defaultAudio);
  const [muted, setMuted] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [stalled, setStalled] = useState(false);
  const [dragLock, setDragLock] = useState(false);
  const [imeOpen, setImeOpen] = useState(false);
  const [activePopover, setActivePopover] = useState<DesktopPopoverKind | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [cursor, setCursor] = useState<ScreenPoint>({ x: 0.5, y: 0.5 });
  const [sample, setSample] = useState<DesktopMetricSample | null>(null);

  const effectiveMode: DesktopMode = canControl ? mode : "view";
  const effectiveAudio = canAudio && audioEnabled;

  const latestRef = useRef({ canStart, effectiveMode, quality, effectiveAudio, phase, error, reasonKind });
  latestRef.current = { canStart, effectiveMode, quality, effectiveAudio, phase, error, reasonKind };

  const clearReconnectTimer = useCallback(() => {
    if (!reconnectTimerRef.current) return;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = 0;
  }, []);

  const sendEvent = useCallback((event: DesktopEvent): boolean => {
    return connRef.current?.send(event) === true;
  }, []);

  const releaseDragLock = useCallback(() => {
    setDragLock(prev => {
      if (prev) connRef.current?.send({ kind: "up", ...cursorRef.current, button: "left" });
      return false;
    });
  }, []);

  const stopStream = useCallback((nextPhase: StreamPhase, nextError = "", manual = false) => {
    attemptRef.current += 1;
    clearReconnectTimer();
    manualStopRef.current = manual;
    streamGrantedControlRef.current = false;
    if (manual) {
      resumeOnVisibleRef.current = false;
      autoRetryCountRef.current = 0;
      setReconnectAttempt(0);
    }
    releaseDragLock();
    const active = connRef.current;
    connRef.current = null;
    active?.close();
    setPhase(nextPhase);
    setError(nextError);
    setReasonKind(null);
    setDisplayName("");
    setStalled(false);
    setZoom(1);
    setImeOpen(false);
    setActivePopover(null);
    setSample(null);
  }, [clearReconnectTimer, releaseDragLock]);

  const startStreamRef = useRef<(
    nextMode: DesktopMode,
    nextQuality: DesktopQuality,
    nextAudio: boolean,
    preserveRetry?: boolean,
  ) => Promise<void>>(async () => {});

  const startStream = useCallback(async (
    nextMode: DesktopMode,
    nextQuality: DesktopQuality,
    nextAudio: boolean,
    preserveRetry = false,
  ) => {
    clearReconnectTimer();
    if (!direct || !canView || !session?.desktop || !videoRef.current) {
      setPhase("preflight");
      return;
    }
    const previous = connRef.current;
    connRef.current = null;
    previous?.close();

    const token = ++attemptRef.current;
    manualStopRef.current = false;
    resumeOnVisibleRef.current = false;
    streamGrantedControlRef.current = false;
    if (!preserveRetry) {
      autoRetryCountRef.current = 0;
      setReconnectAttempt(0);
    }
    cursorRef.current = { x: 0.5, y: 0.5 };
    setCursor({ x: 0.5, y: 0.5 });
    setError("");
    setReasonKind(null);
    setStalled(false);
    setDragLock(false);
    setDisplayName("");
    setConnectingStep("p2p");
    setPhase(preserveRetry ? "reconnecting" : "connecting");

    let live: DesktopConnection | undefined;
    const fail = (message: string, code?: string) => {
      if (attemptRef.current !== token) return;
      connRef.current = null;
      streamGrantedControlRef.current = false;
      releaseDragLock();
      setStalled(false);
      setZoom(1);
      setImeOpen(false);
      setActivePopover(null);

      const parsed = parseDesktopReason(message, code);
      const cleanMessage = parsed.cleanMessage || message;

      if (manualStopRef.current) {
        setReasonKind(null);
        setPhase("disconnected");
        setError(cleanMessage);
        return;
      }
      if (document.hidden) {
        resumeOnVisibleRef.current = true;
        setReasonKind(parsed.kind);
        setPhase("disconnected");
        setError(cleanMessage);
        return;
      }
      if (!latestRef.current.canStart) {
        setReasonKind(null);
        setPhase("preflight");
        setError("");
        return;
      }
      const retryable = isAutoRetryableDesktopError(message, code);
      if (retryable && autoRetryCountRef.current < MAX_AUTO_RECONNECT_ATTEMPTS) {
        const nextAttempt = autoRetryCountRef.current + 1;
        autoRetryCountRef.current = nextAttempt;
        const delayMs = AUTO_RECONNECT_DELAYS_MS[nextAttempt - 1] ?? 4000;
        setReconnectAttempt(nextAttempt);
        setReasonKind(parsed.kind);
        setError(cleanMessage);
        setPhase("reconnecting");
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = 0;
          if (attemptRef.current !== token || manualStopRef.current) return;
          if (document.hidden) {
            resumeOnVisibleRef.current = true;
            return;
          }
          const cur = latestRef.current;
          if (!cur.canStart) return;
          void startStreamRef.current(cur.effectiveMode, cur.quality, cur.effectiveAudio, true);
        }, delayMs);
        return;
      }

      autoRetryCountRef.current = 0;
      setReconnectAttempt(0);
      setReasonKind(parsed.kind);
      setPhase("disconnected");
      setError(cleanMessage);
    };

    try {
      live = new DesktopConnection(session.desktop(), videoRef.current, fail, nextStalled => {
        if (attemptRef.current !== token) return;
        setStalled(nextStalled);
        if (nextStalled) releaseDragLock();
      });
      connRef.current = live;
      const allowControl = nextMode === "control" && canControl;
      const allowAudio = nextAudio && canAudio;
      streamGrantedControlRef.current = allowControl;
      await live.start(allowControl, allowAudio, nextQuality, name => {
        if (attemptRef.current !== token) return;
        setDisplayName(name);
        setConnectingStep("media");
      });
    } catch (err) {
      if (attemptRef.current !== token) return;
      live?.close();
      const code = err instanceof ProtocolError ? err.code : undefined;
      fail(err instanceof Error ? err.message : t("desktop.ended"), code);
    }
  }, [clearReconnectTimer, direct, canView, canControl, canAudio, session, releaseDragLock]);

  startStreamRef.current = startStream;

  useEffect(() => {
    setDesktopLive(phase === "live");
  }, [phase]);

  useEffect(() => () => {
    setDesktopLive(false);
    clearReconnectTimer();
    streamGrantedControlRef.current = false;
    attemptRef.current += 1;
    connRef.current?.close();
    connRef.current = null;
  }, [clearReconnectTimer]);

  useEffect(() => {
    manualStopRef.current = false;
    autoRetryCountRef.current = 0;
    streamGrantedControlRef.current = false;
    setReconnectAttempt(0);
    clearReconnectTimer();
    setPhase("preflight");
    setError("");
    setReasonKind(null);
    return () => {
      if (connRef.current) stopStream("preflight");
    };
  }, [session, direct, clearReconnectTimer, stopStream]);

  useEffect(() => {
    if (!canStart) {
      if (connRef.current || phase === "live" || phase === "connecting" || phase === "reconnecting") {
        stopStream("preflight");
      } else if (phase !== "disconnected") {
        setPhase("preflight");
      }
      return;
    }
    if (document.hidden) {
      if (!manualStopRef.current) resumeOnVisibleRef.current = true;
      return;
    }
    if (phase === "preflight" && !manualStopRef.current && !connRef.current) {
      const nextMode = canControl ? prefs.defaultMode : "view";
      const nextAudio = canAudio && prefs.defaultAudio;
      setMode(nextMode);
      setQuality(prefs.defaultQuality);
      setAudioEnabled(nextAudio);
      void startStream(nextMode, prefs.defaultQuality, nextAudio);
    }
  }, [canStart, canControl, canAudio, phase, prefs.defaultMode, prefs.defaultQuality, prefs.defaultAudio, startStream, stopStream]);

  useEffect(() => {
    function releaseInputsOnBlur() {
      releaseDragLock();
      connRef.current?.send({ kind: "release" });
    }
    function pauseForBackground() {
      if (manualStopRef.current) return;
      const cur = latestRef.current;
      const wasActive = Boolean(connRef.current || reconnectTimerRef.current || cur.phase === "live" || cur.phase === "connecting" || cur.phase === "reconnecting");
      if (!wasActive) return;
      resumeOnVisibleRef.current = true;
      stopStream("disconnected", t("desktop.ended"), false);
    }
    function resumeFromBackground() {
      if (document.hidden || manualStopRef.current) return;
      if (!resumeOnVisibleRef.current) return;
      const cur = latestRef.current;
      if (!cur.canStart) return;
      resumeOnVisibleRef.current = false;
      void startStreamRef.current(cur.effectiveMode, cur.quality, cur.effectiveAudio, false);
    }
    function onVisibility() {
      if (document.hidden) pauseForBackground();
      else resumeFromBackground();
    }
    function onOnline() {
      if (document.hidden || manualStopRef.current) return;
      const cur = latestRef.current;
      if (!cur.canStart) return;
      if (
        cur.phase === "reconnecting"
        || (cur.phase === "disconnected" && cur.reasonKind === null && isAutoRetryableDesktopError(cur.error))
      ) {
        void startStreamRef.current(cur.effectiveMode, cur.quality, cur.effectiveAudio, false);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", pauseForBackground);
    window.addEventListener("pageshow", resumeFromBackground);
    window.addEventListener("online", onOnline);
    window.addEventListener("blur", releaseInputsOnBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", pauseForBackground);
      window.removeEventListener("pageshow", resumeFromBackground);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("blur", releaseInputsOnBlur);
    };
  }, [releaseDragLock, stopStream]);

  useEffect(() => {
    if (phase !== "live") return;
    let active = true;
    let sentinel: WakeLockSentinelLike | null = null;

    async function acquireWakeLock() {
      if (!active || document.hidden || (sentinel && !sentinel.released)) return;
      const wakeLock = (navigator as NavigatorWithWakeLock).wakeLock;
      if (!wakeLock?.request) return;
      try {
        const next = await wakeLock.request("screen");
        if (!active || document.hidden) {
          void next.release().catch(() => {});
          return;
        }
        sentinel = next;
      } catch {
        /* Wake Lock unsupported or denied */
      }
    }

    function releaseWakeLock() {
      const cur = sentinel;
      sentinel = null;
      if (cur && !cur.released) {
        void cur.release().catch(() => {});
      }
    }

    function onVisibility() {
      if (document.hidden) releaseWakeLock();
      else void acquireWakeLock();
    }

    void acquireWakeLock();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
      releaseWakeLock();
    };
  }, [phase]);

  useEffect(() => {
    const onFullscreen = () => {
      setFullscreen(document.fullscreenElement === surfaceRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (phase !== "live" || effectiveMode !== "control" || stalled || !video) return;
    const splitTouchpad = surface.phonePortrait && prefs.touchMode === "trackpad" && surface.touchUi;
    if (splitTouchpad) return;

    const useTrackpad = surface.touchUi && prefs.touchMode === "trackpad";
    const aim = useTrackpad && ringRef.current ? trackpadAim(video, ringRef.current) : undefined;
    const handler = attachScreenInput(video, sendEvent, useTrackpad, aim, cursorRef.current);
    inputRef.current = handler;
    return () => {
      const pos = handler.position();
      cursorRef.current = pos;
      setCursor(pos);
      handler.detach();
      aim?.dispose();
      inputRef.current = null;
    };
  }, [phase, effectiveMode, stalled, surface.phonePortrait, surface.touchUi, prefs.touchMode, sendEvent]);

  useEffect(() => {
    if (phase !== "live" || !connRef.current) return;
    let cancelled = false;
    let timer = 0;
    const intervalMs = activePopover === "stats" ? 1000 : 2000;
    async function pollStats() {
      if (!connRef.current) return;
      try {
        const next = await connRef.current.statistics();
        if (!cancelled && next) setSample(next);
      } catch {
        /* ignore stats read errors */
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void pollStats(), intervalMs);
      }
    }
    void pollStats();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase, activePopover]);

  function handleSwitchMode(nextMode: DesktopMode) {
    if (nextMode === "control" && !canControl) return;
    if (nextMode === effectiveMode) return;
    setActivePopover(null);
    if (phase === "live" && streamGrantedControlRef.current) {
      releaseDragLock();
      connRef.current?.send({ kind: "release" });
      setMode(nextMode);
      return;
    }
    setMode(nextMode);
    if (phase === "live" || phase === "connecting") {
      void startStream(nextMode, quality, effectiveAudio);
    }
  }

  function handleSwitchQuality(nextQuality: DesktopQuality) {
    if (nextQuality === quality) return;
    setQuality(nextQuality);
    if (phase === "live" || phase === "connecting") {
      void startStream(effectiveMode, nextQuality, effectiveAudio);
    }
  }

  function handleToggleAudio() {
    if (!canAudio) return;
    const nextAudio = !effectiveAudio;
    setAudioEnabled(nextAudio);
    setMuted(false);
    if (phase === "live" || phase === "connecting") {
      void startStream(effectiveMode, quality, nextAudio);
    }
  }

  function handleToggleDragLock() {
    if (effectiveMode !== "control" || stalled) return;
    if (dragLock) {
      releaseDragLock();
    } else if (sendEvent({ kind: "down", ...cursorRef.current, button: "left" })) {
      setDragLock(true);
    }
  }

  function handleToggleFullscreen() {
    const el = surfaceRef.current;
    if (!el?.requestFullscreen) return;
    void (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()).catch(() => {});
  }

  function handleRightClick() {
    if (inputRef.current) {
      inputRef.current.rightClick();
      return;
    }
    sendEvent({ kind: "down", ...cursorRef.current, button: "right" });
    sendEvent({ kind: "up", ...cursorRef.current, button: "right" });
  }

  function updateCursor(next: ScreenPoint) {
    cursorRef.current = next;
    setCursor(next);
  }

  function markPlaying() {
    if (!connRef.current) return;
    autoRetryCountRef.current = 0;
    resumeOnVisibleRef.current = false;
    setReconnectAttempt(0);
    setError("");
    setReasonKind(null);
    setPhase("live");
    if (effectiveAudio && videoRef.current?.muted) setMuted(true);
  }

  return {
    prefs,
    surfaceRef,
    stageRef,
    videoRef,
    ringRef,
    phase,
    connectingStep,
    reconnectAttempt,
    maxReconnectAttempts: MAX_AUTO_RECONNECT_ATTEMPTS,
    error,
    reasonKind,
    displayName,
    effectiveMode,
    quality,
    effectiveAudio,
    muted,
    setMuted,
    zoom,
    setZoom,
    stalled,
    dragLock,
    imeOpen,
    setImeOpen,
    activePopover,
    setActivePopover,
    fullscreen,
    cursor,
    sample,
    sendEvent,
    stopStream,
    startStream,
    handleSwitchMode,
    handleSwitchQuality,
    handleToggleAudio,
    handleToggleDragLock,
    handleToggleFullscreen,
    handleRightClick,
    updateCursor,
    markPlaying,
  };
}
