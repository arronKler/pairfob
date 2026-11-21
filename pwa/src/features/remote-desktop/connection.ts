import { waitForDirectICE } from "../../lib/protocol/direct-peer";
import { ProtocolError } from "../../lib/protocol/errors";
import { DesktopInputQueue } from "./input-queue";
import type { DesktopEvent, DesktopQuality, DesktopRPC } from "../../lib/protocol/remote-desktop";
import { t } from "../../lib/i18n";

import { DesktopFrameHealth } from "./frame-health";
import { DesktopMetrics } from "./desktop-metrics";

const ICE_DISCONNECT_GRACE_MS = 3500;
const MAX_TRANSIENT_PING_FAILURES = 2;

export class DesktopConnection {
  private peer: RTCPeerConnection;
  private stopped = false;
  private requested = false;
  private heartbeat = 0;
  private opening = 0;
  private disconnectGrace = 0;
  private input: DesktopInputQueue;
  private checkingFrames = false;
  private health = new DesktopFrameHealth(performance.now());
  private readonly metrics = new DesktopMetrics();
  private encodeMS?: number;
  private lastMeasuredStamp?: number;
  private measuredAt = -Infinity;
  private control = false;
  private paused = false;
  private frameCallback = 0;
  private frameCount = 0;
  private pinging = false;
  private consecutivePingFailures = 0;
  private stalled = false;
  private hasPresented = false;
  private inputFailure?: { message: string; code?: string };
  private abort = new AbortController();

  constructor(
    private rpc: DesktopRPC,
    private video: HTMLVideoElement,
    private failed: (message: string, code?: string) => void,
    private onStallChange?: (stalled: boolean) => void,
  ) {
    this.input = new DesktopInputQueue(
      event => rpc.input(event).catch(err => {
        if (err instanceof ProtocolError && (err.code === "kicked" || err.code === "conflict" || err.message.includes("[reason:"))) {
          this.inputFailure = { message: err.message, code: err.code };
        } else if (err instanceof ProtocolError) {
          this.inputFailure = { message: t("desktop.ended"), code: err.code };
        }
        throw err;
      }),
      () => {
        const failure = this.inputFailure;
        this.inputFailure = undefined;
        this.fail(failure?.message ?? t("desktop.ended"), failure?.code);
      },
    );
    this.peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
    const stream = new MediaStream();
    this.video.srcObject = stream;
    this.peer.ontrack = ({ track }) => {
      stream.addTrack(track);
      track.onended = () => this.fail(t("desktop.ended"));
    };
    this.peer.onconnectionstatechange = () => {
      const state = this.peer.connectionState;
      if (state === "connected") {
        this.clearDisconnectGrace();
        this.syncStall(performance.now());
        return;
      }
      if (state === "disconnected") {
        // Mobile Wi-Fi/5G handoffs often dip through transient "disconnected" before
        // recovering. Pause input and allow a brief grace window before tearing down.
        this.pauseInput();
        if (this.hasPresented) this.setStalled(true);
        if (!this.disconnectGrace) {
          this.disconnectGrace = window.setTimeout(() => {
            this.disconnectGrace = 0;
            if (!this.stopped && this.peer.connectionState === "disconnected") {
              this.fail(t("desktop.ended"), "disconnected");
            }
          }, ICE_DISCONNECT_GRACE_MS);
        }
        return;
      }
      if (state === "failed" || state === "closed") {
        this.fail(t("desktop.ended"), state);
      }
    };
  }

  async start(control: boolean, audio: boolean, quality: DesktopQuality, approved: (name: string) => void) {
    this.peer.addTransceiver("video", { direction: "recvonly" });
    if (audio) this.peer.addTransceiver("audio", { direction: "recvonly" });
    await this.peer.setLocalDescription(await this.peer.createOffer());
    await waitForDirectICE(this.peer, this.abort.signal, 4500);
    if (this.stopped) return;
    const offer = this.peer.localDescription;
    if (!offer || !offer.sdp.includes("a=candidate:")) throw new Error(t("desktop.direct"));
    this.requested = true;
    const result = await this.rpc.open(offer.sdp, control, audio, quality);
    if (this.stopped) return;
    await this.peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
    if (this.stopped) return;
    approved(result.display);
    this.control = control;
    this.health = new DesktopFrameHealth(performance.now());
    const frame: VideoFrameRequestCallback = (now, metadata) => {
      if (this.stopped) return;
      this.hasPresented = true;
      this.health.presented(now, metadata.rtpTimestamp);
      this.setStalled(false);
      this.metrics.frame(now, metadata);
      this.frameCallback = this.video.requestVideoFrameCallback(frame);
    };
    if (typeof this.video.requestVideoFrameCallback === "function") this.frameCallback = this.video.requestVideoFrameCallback(frame);
    this.opening = window.setTimeout(() => {
      if (!this.video.videoWidth) this.fail(t("desktop.noVideo"));
    }, 15000);
    this.heartbeat = window.setInterval(() => {
      this.sampleDecodedFrames();
      const now = performance.now();
      if (this.health.expired(now)) return this.fail(t("desktop.noVideo"));
      this.syncStall(now);
      if (this.pinging) return;
      this.pinging = true;
      void this.rpc.ping(this.health.observe, this.health.requestKeyframe(now)).then(state => {
        if (this.stopped) return;
        this.consecutivePingFailures = 0;
        this.health.observed(state, now);
        if (state && state.rtp_time !== this.lastMeasuredStamp) {
          this.lastMeasuredStamp = state.rtp_time;
          this.measuredAt = now;
          this.encodeMS = state.encode_ms;
        }
        this.syncStall(performance.now());
      }).catch(err => {
        if (this.stopped) return;
        const code = err instanceof ProtocolError ? err.code : undefined;
        const preserveMessage = err instanceof ProtocolError && (code === "kicked" || err.message.includes("[reason:"));
        const message = preserveMessage ? err.message : t("desktop.ended");
        const definitive = code === "kicked" || code === "conflict" || code === "forbidden" || code === "disconnected" || code === "unsupported";
        this.consecutivePingFailures += 1;
        if (definitive || this.consecutivePingFailures >= MAX_TRANSIENT_PING_FAILURES) {
          this.fail(message, code);
        }
      }).finally(() => { this.pinging = false; });
    }, 1000);
    try {
      await this.video.play();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotAllowedError" && audio)) throw error;
      this.video.muted = true;
      await this.video.play();
    }
  }

  private sampleDecodedFrames() {
    if (this.health.observe) return;
    // Older receivers can report decoded frames even without video frame callbacks.
    const note = (count: number | undefined) => {
      if (!this.stopped && count !== undefined && count > this.frameCount) {
        this.frameCount = count;
        this.hasPresented = true;
        this.health.playbackProgress(performance.now());
        this.setStalled(false);
      }
    };
    const quality = this.video.getVideoPlaybackQuality?.();
    if (quality && quality.totalVideoFrames > 0) {
      note(quality.totalVideoFrames - quality.droppedVideoFrames);
      return;
    }
    if (this.checkingFrames) return;
    this.checkingFrames = true;
    void this.peer.getStats().then(report => {
      report.forEach(stat => {
        if (stat.type === "inbound-rtp" && (stat.kind === "video" || stat.mediaType === "video")) note(stat.framesDecoded);
      });
    }).catch(() => {}).finally(() => { this.checkingFrames = false; });
  }

  async statistics() {
    const report = await this.peer.getStats();
    const encodeMS = performance.now() - this.measuredAt < 2000 ? this.encodeMS : undefined;
    return this.metrics.sample(report, this.video, encodeMS);
  }

  private setStalled(next: boolean) {
    if (this.stalled === next) return;
    this.stalled = next;
    this.onStallChange?.(next);
  }

  private syncStall(now: number) {
    if (!this.health.allowsInput(now)) {
      this.pauseInput();
      if (this.hasPresented) this.setStalled(true);
      return;
    }
    this.setStalled(false);
  }

  private pauseInput() {
    if (!this.control || this.paused) return;
    this.paused = true;
    this.input.release();
  }

  send(event: DesktopEvent) {
    if (this.stopped || !this.control) return false;
    const now = performance.now();
    if (!this.health.allowsInput(now)) this.sampleDecodedFrames();
    if (!this.video.videoWidth || this.video.readyState < 2 || !this.health.allowsInput(now)) {
      this.pauseInput();
      if (this.hasPresented && !this.health.allowsInput(now)) this.setStalled(true);
      return false;
    }
    this.paused = false;
    this.setStalled(false);
    return this.input.send(event);
  }

  private clearDisconnectGrace() {
    if (!this.disconnectGrace) return;
    clearTimeout(this.disconnectGrace);
    this.disconnectGrace = 0;
  }

  private fail(message: string, code?: string) {
    if (this.stopped) return;
    this.close();
    this.failed(message, code);
  }

  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.setStalled(false);
    this.abort.abort();
    clearInterval(this.heartbeat);
    clearTimeout(this.opening);
    this.clearDisconnectGrace();
    if (this.frameCallback) this.video.cancelVideoFrameCallback(this.frameCallback);
    this.input.close();
    if (this.requested) void this.rpc.close().catch(() => {});
    this.peer.close();
    this.video.srcObject = null;
  }
}
