import { bytesToHex } from "./bytes.ts";
import { DataFrameChannel } from "./data-channel.ts";
import {
  DirectError,
  asDirectError,
  createDirectOffer,
  createDirectRestartOffer,
  parseDirectAnswer,
  parseDirectRestartAnswer,
  type DirectICEGathering,
  type DirectOffer,
} from "./direct-peer.ts";
import { DIRECT_RESTART_TIMEOUT_MS } from "./direct-retry-policy.ts";
import { ProtocolError } from "./errors.ts";
import type { FrameChannel } from "./frame-channel.ts";
import { establishSessionEpoch, type SessionEpoch } from "./session-handshake.ts";
import { isRecord } from "./session-message.ts";
import { SessionTransport } from "./session-transport.ts";
import type { MuxProtocol } from "./mux.ts";
import type { PairResult } from "./pair-ws.ts";
import type { SessionEvent } from "./session-types.ts";

const OFFER_RPC_TIMEOUT_MS = 12_000;
const COMMIT_RPC_TIMEOUT_MS = 8_000;
const DIRECT_PROBE_TIMEOUT_MS = 3_000;
const UNCERTAIN_COMMIT_CODES = new Set(["timeout", "disconnected", "heartbeat_timeout", "daemon_replaced"]);

export type PreparedDirectSession = {
  attemptId: string;
  iceGathering: DirectICEGathering;
  channel: FrameChannel;
  epoch: SessionEpoch;
  close(): void;
};

function requireCommitResult(value: unknown, candidate: PreparedDirectSession): void {
  const routeId = bytesToHex(candidate.epoch.routeId);
  if (!isRecord(value) || Object.keys(value).length !== 3 ||
      value.attempt_id !== candidate.attemptId || value.route_id !== routeId || value.transport !== "webrtc") {
    throw new ProtocolError("bad_message", "P2P commit 响应格式错误");
  }
}

export async function prepareDirectSession(
  relay: SessionTransport,
  pair: PairResult,
  protocol: MuxProtocol,
  signal?: AbortSignal,
  onHello?: () => void,
  takePreparedOffer?: () => Promise<DirectOffer> | undefined,
): Promise<PreparedDirectSession> {
  if (relay.kind !== "relay") throw new ProtocolError("conflict", "当前会话已是 P2P");
  const offer = await (takePreparedOffer?.() ?? createDirectOffer(signal));
  try {
    if (signal?.aborted) throw new DirectError("cancelled", "P2P 协商已取消");
    let rawAnswer: unknown;
    try {
      rawAnswer = await relay.rpc("TransportOffer", {
        attempt_id: offer.attemptId,
        sdp: offer.sdp,
      }, OFFER_RPC_TIMEOUT_MS);
    } catch (error) {
      if (signal?.aborted) {
        throw new DirectError("cancelled", "P2P 协商已取消", error instanceof ProtocolError ? error.code : undefined);
      }
      throw asDirectError(error, "signal", "P2P offer 协商失败");
    }
    let answer;
    try {
      answer = parseDirectAnswer(rawAnswer, offer.attemptId);
    } catch (error) {
      throw asDirectError(error, "answer", "P2P answer 格式错误");
    }
    const channel = await offer.accept(answer, signal);
    let epoch: SessionEpoch;
    try {
      onHello?.();
      epoch = await establishSessionEpoch(channel, answer.routeId, pair, protocol);
    } catch (error) {
      channel.close();
      throw asDirectError(error, "handshake", "P2P 安全握手失败");
    }
    return {
      attemptId: offer.attemptId,
      iceGathering: offer.iceGathering,
      channel,
      epoch,
      close: () => channel.close(),
    };
  } catch (error) {
    offer.close();
    throw error;
  }
}

/**
 * `abandon` gives the candidate up while it is still proving itself: the relay
 * dropped under the commit and its replacement was ready first.
 */
export async function commitDirectSession(
  relay: SessionTransport,
  candidate: PreparedDirectSession,
  emit: (event: SessionEvent) => void,
  abandon?: AbortSignal,
): Promise<{ transport: SessionTransport; rttMs: number }> {
  let commitError: unknown = null;
  try {
    const result = await relay.rpc("TransportCommit", {
      attempt_id: candidate.attemptId,
      route_id: bytesToHex(candidate.epoch.routeId),
    }, COMMIT_RPC_TIMEOUT_MS);
    requireCommitResult(result, candidate);
  } catch (error) {
    const directError = asDirectError(error, "commit", "P2P commit 失败");
    commitError = directError;
    if (!(error instanceof ProtocolError) || !UNCERTAIN_COMMIT_CODES.has(error.code)) throw directError;
  }

  let active = false;
  // Every relay answer sent before the commit reply has arrived; the computer
  // sends the rest on the direct route. Unconfirmed, they stay with the relay.
  const carried = commitError ? undefined : relay.carryOut();
  const direct = new SessionTransport(
    candidate.channel,
    candidate.epoch.routeId,
    candidate.epoch.c2s,
    candidate.epoch.s2c,
    (event) => { if (active) emit(event); },
    [],
    carried,
  );
  const startedAt = performance.now();
  // Carried requests reached the computer, which now answers on this route:
  // closing it leaves their outcome unknown, not refused.
  const unanswered = new ProtocolError("disconnected", "P2P 直连切换未完成，请求结果未知");
  const abandoned = () => direct.close("standby_ready", unanswered);
  abandon?.addEventListener("abort", abandoned, { once: true });
  try {
    if (abandon?.aborted) abandoned();
    await direct.rpc("Ping", { t_ms: Date.now() }, DIRECT_PROBE_TIMEOUT_MS);
    // Given up in the same turn as its answer: the closed transport must not be handed on.
    if (abandon?.aborted) throw new ProtocolError("closed", "会话已关闭");
  } catch (error) {
    direct.close(undefined, unanswered);
    if (abandon?.aborted) throw new DirectError("cancelled", "P2P 直连切换已取消");
    throw commitError ?? asDirectError(error, "probe", "P2P 连通性验证失败");
  } finally {
    abandon?.removeEventListener("abort", abandoned);
  }
  active = true;
  return { transport: direct, rttMs: Math.max(0, performance.now() - startedAt) };
}

export type DirectRestartResult = "ok" | "unsupported" | "failed";

/** Renegotiate ICE on the live DataChannel. Does not change route or AEAD. */
export async function restartDirectSession(
  transport: SessionTransport,
  channel: DataFrameChannel,
  signal?: AbortSignal,
): Promise<DirectRestartResult> {
  if (transport.kind !== "p2p") return "failed";
  channel.pauseIceWatch();
  try {
    const offer = await createDirectRestartOffer(channel.peerConnection(), signal);
    let raw: unknown;
    try {
      raw = await transport.rpc("TransportRestart", {
        attempt_id: offer.attemptId,
        sdp: offer.sdp,
      }, DIRECT_RESTART_TIMEOUT_MS);
    } catch (error) {
      if (signal?.aborted) return "failed";
      if (error instanceof ProtocolError && (error.code === "unknown_op" || error.code === "unsupported")) {
        return "unsupported";
      }
      return "failed";
    }
    let answer: { sdp: string };
    try {
      answer = parseDirectRestartAnswer(raw, offer.attemptId);
    } catch {
      return "failed";
    }
    await offer.apply(answer.sdp);
    return "ok";
  } catch {
    return "failed";
  } finally {
    channel.resumeIceWatch();
  }
}
