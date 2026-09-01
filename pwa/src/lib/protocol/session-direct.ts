import { parseNetworkMode, type NetworkMode } from "../network-mode.ts";
import {
  DIRECT_HEALTH_PING_MS,
  DIRECT_RESTART_MIN_INTERVAL_MS,
  directRetryDelay,
} from "./direct-retry-policy.ts";
import {
  DirectError,
  directFailureDiagnostic,
  type DirectFailureDiagnostic,
  type DirectICEGathering,
} from "./direct-peer.ts";
import { ProtocolError } from "./errors.ts";
import { muxProtocolFromRelayURL } from "./mux.ts";
import type { PairResult } from "./pair-ws.ts";
import { SessionTransport } from "./session-transport.ts";
import type { ReconnectReason, SessionEvent } from "./session-types.ts";
import { commitDirectSession, prepareDirectSession, restartDirectSession } from "./session-upgrade.ts";

export type P2PAttemptObservation = {
  result: "connected" | "failed" | "cancelled";
  extra: DirectICEGathering | DirectFailureDiagnostic;
};

export type DirectSessionHost = {
  pair: PairResult;
  relayWS: string;
  options: { p2p?: boolean };
  stopped: boolean;
  networkAvailable: boolean;
  networkMode: NetworkMode;
  getTransport(): SessionTransport | null;
  setTransport(transport: SessionTransport): void;
  beginSwitch(): void;
  endSwitch(): void;
  switchWait(): Promise<void> | null;
  emit(event: SessionEvent): void;
  observe(observation: P2PAttemptObservation): void;
  onDisconnect(source: SessionTransport, error: ProtocolError): void;
  finishDisconnect(error: ProtocolError): void;
  takeDeferredDisconnect(): ProtocolError | null;
  peekDeferredDisconnect(): ProtocolError | null;
};

/** Direct-upgrade, ICE health, and in-band restart for one reconnecting session. */
export class DirectSessionDriver {
  private directAbort: AbortController | null = null;
  private restartAbort: AbortController | null = null;
  private directAttempt: Promise<void> | null = null;
  private directRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private directRetryAttempt = 0;
  private lastRestartAt = 0;
  private unwatchIce: (() => void) | null = null;

  constructor(private readonly host: DirectSessionHost) {}

  dispose(): void {
    this.directAbort?.abort();
    this.directAbort = null;
    this.restartAbort?.abort();
    this.restartAbort = null;
    this.directAttempt = null;
    this.clearDirectRetry();
    this.unwatchIce?.();
    this.unwatchIce = null;
  }

  resetBackoff(): void {
    this.directRetryAttempt = 0;
    this.clearDirectRetry();
  }

  onRelayReady(transport: SessionTransport): void {
    this.resetBackoff();
    this.startAutomaticDirectUpgrade(transport);
  }

  attachDirect(transport: SessionTransport): void {
    this.unwatchIce?.();
    const channel = transport.directChannel();
    if (!channel) {
      this.unwatchIce = null;
      return;
    }
    this.unwatchIce = channel.onIceUnhealthy(() => {
      if (this.host.getTransport() !== transport) return;
      void this.recoverDirectPath(transport);
    });
  }

  async switchTransport(target: NetworkMode): Promise<void> {
    if (this.host.stopped) throw new ProtocolError("disconnected", "连接已断开");
    const transport = this.host.getTransport();
    if (target === "relay") {
      this.clearDirectRetry();
      this.directAbort?.abort();
      this.restartAbort?.abort();
      if (transport?.kind === "p2p") {
        transport.suspend(new ProtocolError("disconnected", "正在切换到 Relay"));
      }
      return;
    }
    if (!this.host.options.p2p || typeof RTCPeerConnection === "undefined") {
      if (target === "p2p") {
        const error = new DirectError("unsupported", "当前环境不支持 P2P 直连");
        this.host.observe({ result: "failed", extra: error.diagnostic });
        throw error;
      }
      return;
    }
    if (!this.host.networkAvailable || !transport || transport.kind === "p2p") return;
    if (target === "auto") {
      this.startAutomaticDirectUpgrade(transport);
      return;
    }
    this.clearDirectRetry();
    try {
      await this.startDirectUpgrade(transport);
    } catch (error) {
      this.scheduleDirectRetry(transport);
      throw error;
    }
  }

  probe(transport: SessionTransport, reason: ReconnectReason): void {
    if (transport.kind === "p2p") {
      void this.probeDirect(transport, reason);
      return;
    }
    void transport.rpc("Ping", { t_ms: Date.now() }, 8_000).then(
      () => {
        if (this.host.getTransport() === transport && transport.kind === "relay") this.startAutomaticDirectUpgrade(transport);
      },
      (error) => {
        if (this.host.getTransport() === transport && error instanceof ProtocolError && error.code === "timeout") {
          transport.suspend(new ProtocolError("disconnected", "前台探测失败"));
        }
      },
    );
  }

  private async probeDirect(transport: SessionTransport, reason: ReconnectReason): Promise<void> {
    const channel = transport.directChannel();
    if (channel?.iceDisconnected()) {
      await this.recoverDirectPath(transport);
      return;
    }
    if (reason === "path" && channel?.iceHealthy()) await this.maybeRestart(transport);
    if (this.host.getTransport() !== transport) return;
    try {
      await transport.rpc("Ping", { t_ms: Date.now() }, DIRECT_HEALTH_PING_MS);
    } catch (error) {
      if (this.host.getTransport() === transport && error instanceof ProtocolError && error.code === "timeout") {
        transport.suspend(new ProtocolError("disconnected", "前台探测失败"));
      }
    }
  }

  private async recoverDirectPath(transport: SessionTransport): Promise<void> {
    if (this.host.getTransport() !== transport || transport.kind !== "p2p") return;
    const result = await this.maybeRestart(transport);
    if (this.host.getTransport() !== transport) return;
    const channel = transport.directChannel();
    if (result === "ok") return;
    if (result === "skipped" && this.restartAbort) return;
    if (channel?.iceHealthy() || channel?.icePending()) return;
    transport.suspend(new ProtocolError("disconnected", "P2P 路径已失效"));
  }

  private async maybeRestart(transport: SessionTransport): Promise<"ok" | "unsupported" | "failed" | "skipped"> {
    const channel = transport.directChannel();
    if (!channel || this.host.stopped || !this.host.networkAvailable) return "skipped";
    if (parseNetworkMode(this.host.networkMode) === "relay") return "skipped";
    if (this.lastRestartAt !== 0 && Date.now() - this.lastRestartAt < DIRECT_RESTART_MIN_INTERVAL_MS) return "skipped";
    if (this.restartAbort) return "skipped";
    this.lastRestartAt = Date.now();
    const controller = new AbortController();
    this.restartAbort = controller;
    try {
      return await restartDirectSession(transport, channel, controller.signal);
    } finally {
      if (this.restartAbort === controller) this.restartAbort = null;
    }
  }

  private startAutomaticDirectUpgrade(relay: SessionTransport): void {
    if (!this.canAutoUpgrade(relay) || this.directAttempt) return;
    this.clearDirectRetry();
    void this.startDirectUpgrade(relay).then(
      () => { this.directRetryAttempt = 0; },
      () => this.scheduleDirectRetry(relay),
    );
  }

  private canAutoUpgrade(relay: SessionTransport): boolean {
    return this.host.options.p2p === true && this.host.networkMode !== "relay" && typeof RTCPeerConnection !== "undefined" &&
      !this.host.stopped && this.host.networkAvailable && this.host.getTransport() === relay && relay.kind === "relay";
  }

  private startDirectUpgrade(relay: SessionTransport): Promise<void> {
    if (this.directAttempt) return this.directAttempt;
    if (!this.canAutoUpgrade(relay)) return Promise.reject(new DirectError("unavailable", "P2P 直连当前不可用"));
    const controller = new AbortController();
    this.directAbort = controller;
    const attempt = this.runDirectUpgrade(relay, controller);
    this.directAttempt = attempt;
    void attempt.then(
      () => this.finishDirectAttempt(attempt, controller, relay),
      () => this.finishDirectAttempt(attempt, controller, relay),
    );
    return attempt;
  }

  private finishDirectAttempt(attempt: Promise<void>, controller: AbortController, relay: SessionTransport): void {
    if (this.directAttempt === attempt) this.directAttempt = null;
    if (this.directAbort === controller) this.directAbort = null;
    const active = this.host.getTransport();
    if (active && active !== relay && active.kind === "relay") this.startAutomaticDirectUpgrade(active);
  }

  private async runDirectUpgrade(relay: SessionTransport, controller: AbortController): Promise<void> {
    let candidate: Awaited<ReturnType<typeof prepareDirectSession>> | null = null;
    try {
      candidate = await prepareDirectSession(relay, this.host.pair, muxProtocolFromRelayURL(this.host.relayWS), controller.signal);
      const iceGathering = candidate.iceGathering;
      if (this.host.stopped || this.host.getTransport() !== relay || !this.host.networkAvailable) {
        throw new DirectError("cancelled", "P2P 直连尝试已取消");
      }
      this.host.beginSwitch();
      await relay.waitIdle();
      const direct = await commitDirectSession(relay, candidate, (event) => this.host.emit(event));
      candidate = null;
      if (this.host.stopped || this.host.getTransport() !== relay || !this.host.networkAvailable) {
        direct.transport.close();
        throw new DirectError("cancelled", "P2P 直连切换已取消");
      }
      this.host.takeDeferredDisconnect();
      this.host.setTransport(direct.transport);
      direct.transport.onDisconnect((error) => this.host.onDisconnect(direct.transport, error));
      this.attachDirect(direct.transport);
      this.host.emit({ type: "latency", rttMs: direct.rttMs, transport: "p2p" });
      this.host.observe({ result: "connected", extra: iceGathering });
      this.clearDirectRetry();
      relay.close();
    } catch (error) {
      const diagnostic = directFailureDiagnostic(error);
      this.host.observe({
        result: diagnostic === "cancelled" ? "cancelled" : "failed",
        extra: diagnostic,
      });
      const deferred = this.host.peekDeferredDisconnect();
      if (deferred && this.host.getTransport() === relay) {
        this.host.takeDeferredDisconnect();
        this.host.finishDisconnect(deferred);
      }
      throw error;
    } finally {
      candidate?.close();
      if (this.host.switchWait()) this.host.endSwitch();
      const deferred = this.host.peekDeferredDisconnect();
      if (deferred && this.host.getTransport()) {
        this.host.takeDeferredDisconnect();
        this.host.finishDisconnect(deferred);
      }
    }
  }

  private scheduleDirectRetry(relay: SessionTransport): void {
    if (!this.canAutoUpgrade(relay) || this.directRetryTimer !== null) return;
    const delay = directRetryDelay(this.directRetryAttempt++);
    this.directRetryTimer = globalThis.setTimeout(() => {
      this.directRetryTimer = null;
      this.startAutomaticDirectUpgrade(relay);
    }, delay);
  }

  private clearDirectRetry(): void {
    if (this.directRetryTimer !== null) clearTimeout(this.directRetryTimer);
    this.directRetryTimer = null;
  }
}
