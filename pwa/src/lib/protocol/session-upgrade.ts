import { bytesToHex } from "./bytes.ts";
import { createDirectOffer, parseDirectAnswer } from "./direct-peer.ts";
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
): Promise<PreparedDirectSession> {
  if (relay.kind !== "relay") throw new ProtocolError("conflict", "当前会话已是 P2P");
  const offer = await createDirectOffer(signal);
  try {
    const rawAnswer = await relay.rpc("TransportOffer", {
      attempt_id: offer.attemptId,
      sdp: offer.sdp,
    }, OFFER_RPC_TIMEOUT_MS);
    const answer = parseDirectAnswer(rawAnswer, offer.attemptId);
    const channel = await offer.accept(answer);
    const epoch = await establishSessionEpoch(channel, answer.routeId, pair, protocol);
    return { attemptId: offer.attemptId, channel, epoch, close: () => channel.close() };
  } catch (error) {
    offer.close();
    throw error;
  }
}

export async function commitDirectSession(
  relay: SessionTransport,
  candidate: PreparedDirectSession,
  emit: (event: SessionEvent) => void,
): Promise<{ transport: SessionTransport; rttMs: number }> {
  let commitError: unknown = null;
  try {
    const result = await relay.rpc("TransportCommit", {
      attempt_id: candidate.attemptId,
      route_id: bytesToHex(candidate.epoch.routeId),
    }, COMMIT_RPC_TIMEOUT_MS);
    requireCommitResult(result, candidate);
  } catch (error) {
    commitError = error;
    if (!(error instanceof ProtocolError) || !UNCERTAIN_COMMIT_CODES.has(error.code)) throw error;
  }

  let active = false;
  const direct = new SessionTransport(
    candidate.channel,
    candidate.epoch.routeId,
    candidate.epoch.c2s,
    candidate.epoch.s2c,
    (event) => { if (active) emit(event); },
  );
  const startedAt = performance.now();
  try {
    await direct.rpc("Ping", { t_ms: Date.now() }, DIRECT_PROBE_TIMEOUT_MS);
  } catch (error) {
    direct.close();
    throw commitError ?? error;
  }
  active = true;
  return { transport: direct, rttMs: Math.max(0, performance.now() - startedAt) };
}
