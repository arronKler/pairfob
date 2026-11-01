import { parseNetworkMode, type NetworkMode } from "../network-mode.ts";
import { recordConnectionDiagnostic } from "./connection-diagnostics.ts";
import {
  DIRECT_HEALTH_PING_MS,
  FOREGROUND_RECOVERY_MS,
  RELAY_WARMUP_DELAY_MS,
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
import { pathCheckDue, STANDBY_AWAY_MS } from "./reconnect-policy.ts";
import type { PairResult } from "./pair-ws.ts";
import { SessionTransport } from "./session-transport.ts";
import type { ReconnectReason, SessionEvent } from "./session-types.ts";
import { commitDirectSession, prepareDirectSession, restartDirectSession, type DirectRestartResult } from "./session-upgrade.ts";
import type { TransportSwitchLease } from "./transport-switch.ts";

import { pageHidden } from "./page-activity.ts";

export type P2PAttemptObservation = {
  result: "connected" | "failed" | "cancelled";
  extra: DirectICEGathering | DirectFailureDiagnostic;
};

export type FinishedP2PAttemptObservation = {
  result: "connected" | "failed";
  extra: DirectICEGathering | DirectFailureDiagnostic;
};

export type DirectSessionHost = {
  pair: PairResult;
  relayWS: string;
  options: { p2p?: boolean };
  stopped: boolean;
  networkAvailable: boolean;
  networkMode: NetworkMode;
  prepareRelay(): void;
  /**
   * Prepare a relay dial through its first flight and call `ready` once it has
   * verified DeviceHello2 unused. False when the handshake budget has no room.
   */
  standbyRelay(ready: () => void): boolean;
  cancelPreparedRelay(): void;
  spendHello(): void;
  getTransport(): SessionTransport | null;
  setTransport(transport: SessionTransport): void;
  beginSwitch(): TransportSwitchLease;
  ownsSwitch(lease: TransportSwitchLease): boolean;
  endSwitch(lease: TransportSwitchLease): boolean;
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
  private restartAttempt: { transport: SessionTransport; promise: Promise<DirectRestartResult> } | null = null;
  private directAttempt: Promise<void> | null = null;
  private directRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private directRetryAttempt = 0;
  private lastRestartAt = 0;
  private hidden = pageHidden();
  private hiddenAt = this.hidden ? Date.now() : 0;
  /** How long the page was hidden before the foreground now being probed. */
  private awayMs = 0;
  private activityVersion = 0;
  private probeAttempt: { transport: SessionTransport; cancel(): void } | null = null;
  private lastPathCheckAt = 0;
  /** Held while a direct candidate owns the switch; `standby` once a relay was prepared beside it. */
  private commitAttempt: { abandon: AbortController; standby: boolean } | null = null;
  private unwatchIce: (() => void) | null = null;

  constructor(private readonly host: DirectSessionHost) {}

  dispose(): void {
    this.activityVersion++;
    this.probeAttempt?.cancel();
    this.probeAttempt = null;
    this.directAbort?.abort();
    this.directAbort = null;
    this.restartAbort?.abort();
    this.restartAbort = null;
    this.restartAttempt = null;
    this.clearDirectRetry();
    this.unwatchIce?.();
    this.unwatchIce = null;
  }

  setPageHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    // Wall clock: a suspended page's monotonic clock may not advance.
    if (hidden) this.hiddenAt = Date.now();
    else this.awayMs = Math.max(0, Date.now() - this.hiddenAt);
    this.activityVersion++;
    this.probeAttempt?.cancel();
    this.probeAttempt = null;
    if (hidden) this.clearDirectRetry();
  }

  resetBackoff(): void {
    this.directRetryAttempt = 0;
    this.clearDirectRetry();
  }

  onRelayReady(transport: SessionTransport): void {
    // The return that found no transport has just been answered by this dial.
    this.awayMs = 0;
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

  /**
   * The relay dropped while a direct candidate holds the switch. The candidate
   * keeps its chance to answer, and a relay handshake runs beside it: whichever
   * is ready first carries the session, so a candidate that died with the relay
   * costs one handshake instead of its whole Ping deadline.
   */
  relayLostInSwitch(): void {
    const attempt = this.commitAttempt;
    if (!attempt || attempt.standby || this.hidden || pageHidden() || this.host.stopped || !this.host.networkAvailable) return;
    attempt.standby = true;
    if (!this.host.standbyRelay(() => attempt.abandon.abort())) this.host.prepareRelay();
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

  /**
   * A read gave up at its deadline while this transport still looked alive. The
   * heartbeat would not notice for another 25 s. True when a check started.
   */
  checkPath(transport: SessionTransport, live: boolean, checking: boolean): boolean {
    const now = performance.now();
    if (!pathCheckDue(live, checking, this.lastPathCheckAt, now)) return false;
    this.lastPathCheckAt = now;
    return this.probe(transport, "read");
  }

  /** True when this call started a probe: duplicates and hidden pages start none. */
  probe(transport: SessionTransport, reason: ReconnectReason): boolean {
    if (this.hidden || pageHidden() || this.probeAttempt?.transport === transport) return false;
    const version = this.activityVersion;
    let expired = false;
    let unwatchFailure = () => {};
    const current = () => !expired && this.activityVersion === version && !this.hidden && !pageHidden() && this.host.getTransport() === transport;
    const away = this.awayMs;
    this.awayMs = 0;
    let warmup: ReturnType<typeof setTimeout> | undefined;
    const deadline = globalThis.setTimeout(() => {
      if (current()) {
        expired = true;
        this.restartAbort?.abort();
        transport.diagnose("probe_failed", { reason: "recovery_budget_exhausted", code: "timeout" });
        transport.suspend(new ProtocolError("timeout", "前台恢复超时，正在重新连接", { reason: "recovery_budget_exhausted" }));
      }
      cancel();
    }, FOREGROUND_RECOVERY_MS);
    const cancel = () => {
      expired = true;
      unwatchFailure();
      clearTimeout(warmup);
      clearTimeout(deadline);
      if (this.probeAttempt === attempt) this.probeAttempt = null;
    };
    const attempt = { transport, cancel };
    this.probeAttempt = attempt;
    // Publish ownership before notifying UI listeners, which may request another probe.
    this.host.emit({ type: "checking" });
    if (!current()) { cancel(); return false; }
    transport.diagnose("probe_start", { reason });
    // After a long absence the old path may have died without telling this
    // page. A standby handshake runs beside the probe: whichever answers first
    // decides, so a dead path costs one handshake instead of the Ping deadline.
    // A network hint is not a return: there the old path gets its repair first.
    const standby = reason === "probe" && away >= STANDBY_AWAY_MS && this.host.standbyRelay(() => {
      if (!current()) return;
      transport.diagnose("probe_failed", { reason: "standby_ready", code: "timeout" });
      cancel();
      this.restartAbort?.abort();
      // Retire the old path before DeviceHello3 leaves: the computer kicks the
      // previous route as it establishes the new one, and nothing may be
      // listening on it by then.
      transport.suspend(new ProtocolError("timeout", "原连接没有及时应答，已改用新连接", { reason: "standby_ready" }));
    });
    if (!standby) {
      warmup = globalThis.setTimeout(() => {
        if (current()) this.host.prepareRelay();
      }, RELAY_WARMUP_DELAY_MS);
    }
    unwatchFailure = transport.directChannel()?.watchRecoveryFailure?.(() => {
      if (!current()) return;
      transport.diagnose("ice_terminal", { reason: "foreground_transport_failed" });
      transport.diagnose("probe_failed", { reason: "foreground_transport_failed", code: "disconnected" });
      cancel();
      this.restartAbort?.abort();
      transport.suspend(new ProtocolError("disconnected", "P2P 已失效，正在切换到中继", { reason: "foreground_transport_failed" }));
    }) ?? (() => {});
    if (!current()) { cancel(); return false; }
    void this.runProbe(transport, reason, current).finally(cancel);
    return true;
  }

  private async runProbe(transport: SessionTransport, reason: ReconnectReason, current: () => boolean): Promise<void> {
    if (!current()) return;
    try {
      const timeout = DIRECT_HEALTH_PING_MS;
      try {
        await transport.rpc("Ping", { t_ms: Date.now() }, timeout);
      } catch (error) {
        if (!current()) return;
        // A network-change hint or a read that timed out does not prove the
        // existing path is broken the way a failed Ping does. Renegotiate only
        // after the Ping failed, then require a fresh response before enabling
        // input. No user operation is replayed here.
        if (transport.kind !== "p2p" || (reason !== "path" && reason !== "read")) throw error;
        const repaired = await this.maybeRestart(transport);
        if (!current()) return;
        if (repaired !== "ok") throw error;
        await transport.rpc("Ping", { t_ms: Date.now() }, DIRECT_HEALTH_PING_MS);
      }
      if (!current()) return;
      this.host.cancelPreparedRelay();
      transport.diagnose("probe_success", { reason });
      this.host.emit({ type: "connected" });
      if (current() && transport.kind === "relay") this.startAutomaticDirectUpgrade(transport);
    } catch (error) {
      if (current()) {
        const failure = error instanceof ProtocolError ? error : new ProtocolError("disconnected", "前台探测失败");
        const cause = reason === "path" ? "path_probe_failed" : reason === "read" ? "read_probe_failed" : "foreground_probe_failed";
        transport.diagnose("probe_failed", { reason: cause, code: failure.code });
        transport.suspend(new ProtocolError(failure.code, failure.message, { reason: cause, ...failure.diagnostics }));
      }
    }
  }

  private async recoverDirectPath(transport: SessionTransport): Promise<void> {
    if (this.hidden || pageHidden() || this.probeAttempt?.transport === transport || this.host.getTransport() !== transport || transport.kind !== "p2p") return;
    const version = this.activityVersion;
    const result = await this.maybeRestart(transport);
    if (version !== this.activityVersion || this.hidden || pageHidden() || this.host.getTransport() !== transport) return;
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
    // Join the current repair before applying the retry throttle. A failed
    // probe must await its result and confirm readiness, not abandon checking.
    if (this.restartAttempt?.transport === transport) return this.restartAttempt.promise;
    if (this.lastRestartAt !== 0 && Date.now() - this.lastRestartAt < DIRECT_RESTART_MIN_INTERVAL_MS) return "skipped";
    if (this.restartAbort) return "skipped";
    this.lastRestartAt = Date.now();
    const controller = new AbortController();
    this.restartAbort = controller;
    const attempt = { transport, promise: restartDirectSession(transport, channel, controller.signal) };
    this.restartAttempt = attempt;
    try {
      return await attempt.promise;
    } finally {
      if (this.restartAbort === controller) this.restartAbort = null;
      if (this.restartAttempt === attempt) this.restartAttempt = null;
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
    return !this.hidden && !pageHidden() && this.host.options.p2p === true && this.host.networkMode !== "relay" && typeof RTCPeerConnection !== "undefined" &&
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
    let switchLease: TransportSwitchLease | null = null;
    const commit = { abandon: new AbortController(), standby: false };
    const startedAt = performance.now();
    try {
      candidate = await prepareDirectSession(relay, this.host.pair, muxProtocolFromRelayURL(this.host.relayWS), controller.signal,
        () => this.host.spendHello());
      const iceGathering = candidate.iceGathering;
      if (this.host.stopped || this.host.getTransport() !== relay || !this.host.networkAvailable) {
        throw new DirectError("cancelled", "P2P 直连尝试已取消");
      }
      // New requests wait for the switch; those already out are answered on
      // the direct route once the computer has moved the session.
      switchLease = this.host.beginSwitch();
      this.commitAttempt = commit;
      const direct = await commitDirectSession(relay, candidate, (event) => this.host.emit(event), commit.abandon.signal);
      candidate = null;
      // The candidate answered first: the relay prepared beside it is not needed.
      if (commit.standby) this.host.cancelPreparedRelay();
      if (this.host.stopped || this.host.getTransport() !== relay || !this.host.networkAvailable) {
        direct.transport.close();
        throw new DirectError("cancelled", "P2P 直连切换已取消");
      }
      this.host.takeDeferredDisconnect();
      this.host.setTransport(direct.transport);
      direct.transport.onDisconnect((error) => this.host.onDisconnect(direct.transport, error));
      this.attachDirect(direct.transport);
      this.host.emit({ type: "connected" });
      this.host.emit({ type: "latency", rttMs: direct.rttMs, transport: "p2p" });
      this.host.observe({ result: "connected", extra: iceGathering });
      this.clearDirectRetry();
      // If the commit reply was lost, direct Ping still proves the move but
      // requests left on relay may already have run. Never report them refused.
      relay.close("transport_upgrade", new ProtocolError("disconnected", "连接已切换，请求结果未知"));
    } catch (error) {
      const diagnostic = directFailureDiagnostic(error);
      recordConnectionDiagnostic({
        event: "direct_failed", transport: "p2p", reason: diagnostic,
        code: error instanceof ProtocolError ? error.code : undefined, elapsed_ms: performance.now() - startedAt,
      });
      this.host.observe({
        result: diagnostic === "cancelled" ? "cancelled" : "failed",
        extra: diagnostic,
      });
      throw error;
    } finally {
      if (this.commitAttempt === commit) this.commitAttempt = null;
      candidate?.close();
      if (switchLease && this.host.ownsSwitch(switchLease)) {
        const deferred = this.host.peekDeferredDisconnect();
        if (deferred && this.host.getTransport()) {
          this.host.takeDeferredDisconnect();
          this.host.finishDisconnect(deferred);
        }
        this.host.endSwitch(switchLease);
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
