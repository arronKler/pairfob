import { b64url, hexToBytes } from "./bytes.ts";
import { recordConnectionDiagnostic } from "./connection-diagnostics.ts";
import { DataFrameChannel } from "./data-channel.ts";
import { ProtocolError } from "./errors.ts";
import { isRecord } from "./session-message.ts";

const DIRECT_NEGOTIATION_MS = 8_000;
/**
 * Gathering only completes when every interface has heard from STUN or given up
 * on it, which on some phones is the whole negotiation budget. A reflexive
 * address is already enough to offer; this long lets a second interface add its own.
 */
export const DIRECT_ICE_SETTLE_MS = 300;
/** STUN has asked four times by now. Local addresses still connect when the computer can be reached. */
export const DIRECT_ICE_LOCAL_MS = 3_000;
export const MAX_SDP_BYTES = 64 * 1024;
const DATA_CHANNEL_LABEL = "pairfob";
const DATA_CHANNEL_PROTOCOL = "pairfob.v1";

/**
 * Why the offer left: every address gathered, a reflexive one in hand, local
 * ones only after STUN stayed silent, or whatever the full budget produced.
 */
export type DirectICEGathering = "complete" | "reflexive" | "local" | "partial";
export type DirectFailureDiagnostic =
  | "unsupported"
  | "unavailable"
  | "cancelled"
  | "offer"
  | "ice_timeout"
  | "ice_failed"
  | "signal"
  | "answer"
  | "channel_timeout"
  | "channel_failed"
  | "handshake"
  | "commit"
  | "probe"
  | "unknown";

export class DirectError extends ProtocolError {
  constructor(
    public readonly diagnostic: DirectFailureDiagnostic,
    message: string,
    code = "p2p_unavailable",
  ) {
    super(code, message);
    this.name = "DirectError";
  }
}

export function asDirectError(
  error: unknown,
  diagnostic: DirectFailureDiagnostic,
  message: string,
): DirectError {
  if (error instanceof DirectError) return error;
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return new DirectError("cancelled", "P2P 协商已取消");
  }
  return new DirectError(diagnostic, message, error instanceof ProtocolError ? error.code : undefined);
}

export function directFailureDiagnostic(error: unknown): DirectFailureDiagnostic {
  return error instanceof DirectError ? error.diagnostic : "unknown";
}

export type DirectAnswer = {
  attemptId: string;
  routeId: Uint8Array;
  sdp: string;
};

export type DirectOffer = {
  attemptId: string;
  sdp: string;
  iceGathering: DirectICEGathering;
  accept(answer: DirectAnswer, signal?: AbortSignal): Promise<DataFrameChannel>;
  close(): void;
};

function hasICECandidate(peer: RTCPeerConnection): boolean {
  return /(?:^|\r?\n)a=candidate:/.test(peer.localDescription?.sdp ?? "");
}

function hasReflexiveCandidate(peer: RTCPeerConnection): boolean {
  return /(?:^|\r?\n)a=candidate:[^\r\n]* typ srflx(?: |\r?\n|$)/.test(peer.localDescription?.sdp ?? "");
}

export function waitForDirectICE(
  peer: RTCPeerConnection,
  signal?: AbortSignal,
  timeoutMs = DIRECT_NEGOTIATION_MS,
  pace = { settleMs: DIRECT_ICE_SETTLE_MS, localMs: DIRECT_ICE_LOCAL_MS },
): Promise<DirectICEGathering> {
  if (signal?.aborted) return Promise.reject(new DirectError("cancelled", "P2P 协商已取消"));
  const startedAt = performance.now();
  const gathered = (reason: string) =>
    recordConnectionDiagnostic({ event: "ice_gathered", transport: "p2p", reason, elapsed_ms: performance.now() - startedAt });
  return new Promise((resolve, reject) => {
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let localTimer: ReturnType<typeof setTimeout> | null = null;
    let localDue = false;
    let sawCandidate = hasICECandidate(peer);
    let settled = false;
    const cleanup = () => {
      for (const timer of [timeoutTimer, settleTimer, localTimer]) if (timer !== null) clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
      peer.removeEventListener("icecandidate", candidate);
      signal?.removeEventListener("abort", aborted);
    };
    const finish = (result: DirectICEGathering) => {
      if (settled) return;
      settled = true;
      cleanup();
      gathered(result);
      resolve(result);
    };
    const fail = (error: DirectError) => {
      if (settled) return;
      settled = true;
      cleanup();
      gathered(error.diagnostic);
      reject(error);
    };
    const finishComplete = () => {
      sawCandidate = sawCandidate || hasICECandidate(peer);
      if (sawCandidate) finish("complete");
      else fail(new DirectError("ice_failed", "P2P 未找到可用 ICE 候选"));
    };
    const early = () => {
      if (settled) return;
      sawCandidate = sawCandidate || hasICECandidate(peer);
      const reflexive = hasReflexiveCandidate(peer);
      if (localDue && sawCandidate) finish(reflexive ? "reflexive" : "local");
      else if (reflexive && settleTimer === null) {
        settleTimer = globalThis.setTimeout(() => finish("reflexive"), pace.settleMs);
      }
    };
    const changed = () => {
      if (peer.iceGatheringState === "complete") finishComplete();
    };
    const candidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        sawCandidate = true;
        early();
      } else if (peer.iceGatheringState === "complete") finishComplete();
    };
    const aborted = () => {
      fail(new DirectError("cancelled", "P2P 协商已取消"));
    };
    peer.addEventListener("icegatheringstatechange", changed);
    peer.addEventListener("icecandidate", candidate);
    signal?.addEventListener("abort", aborted, { once: true });
    timeoutTimer = globalThis.setTimeout(() => {
      sawCandidate = sawCandidate || hasICECandidate(peer);
      if (peer.iceGatheringState === "complete") finishComplete();
      else if (sawCandidate) finish("partial");
      else fail(new DirectError("ice_timeout", "P2P ICE 候选收集超时"));
    }, timeoutMs);
    localTimer = globalThis.setTimeout(() => {
      localDue = true;
      early();
    }, pace.localMs);
    if (peer.iceGatheringState === "complete") finishComplete();
    else early();
  });
}

function waitForOpen(channel: RTCDataChannel, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DirectError("cancelled", "P2P 协商已取消"));
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener("open", opened);
      channel.removeEventListener("close", failed);
      channel.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new DirectError("channel_failed", "P2P DataChannel 建立失败"));
    };
    const aborted = () => {
      cleanup();
      reject(new DirectError("cancelled", "P2P 协商已取消"));
    };
    const timer = globalThis.setTimeout(() => {
      cleanup();
      reject(new DirectError("channel_timeout", "P2P DataChannel 建立超时"));
    }, DIRECT_NEGOTIATION_MS);
    channel.addEventListener("open", opened, { once: true });
    channel.addEventListener("close", failed, { once: true });
    channel.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export function newDirectAttemptId(): string {
  return `p2p_${b64url(crypto.getRandomValues(new Uint8Array(18)))}`;
}

function validApplicationSDP(sdp: string): boolean {
  return sdp.length > 0 && sdp.length <= MAX_SDP_BYTES && sdp.startsWith("v=0") && sdp.includes("m=application");
}

export function parseDirectAnswer(value: unknown, expectedAttemptId: string): DirectAnswer {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.attempt_id !== expectedAttemptId ||
      typeof value.route_id !== "string" || !/^[0-9a-f]{32}$/.test(value.route_id) ||
      typeof value.sdp !== "string" || !validApplicationSDP(value.sdp)) {
    throw new ProtocolError("bad_message", "P2P answer 格式错误");
  }
  return { attemptId: expectedAttemptId, routeId: hexToBytes(value.route_id), sdp: value.sdp };
}

export function parseDirectRestartAnswer(value: unknown, expectedAttemptId: string): { attemptId: string; sdp: string } {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.attempt_id !== expectedAttemptId ||
      typeof value.sdp !== "string" || !validApplicationSDP(value.sdp)) {
    throw new ProtocolError("bad_message", "P2P restart 响应格式错误");
  }
  return { attemptId: expectedAttemptId, sdp: value.sdp };
}

export async function createDirectRestartOffer(
  peer: RTCPeerConnection,
  signal?: AbortSignal,
): Promise<{ attemptId: string; sdp: string; apply(sdp: string): Promise<void> }> {
  const attemptId = newDirectAttemptId();
  try {
    if (signal?.aborted) throw new DirectError("cancelled", "P2P 协商已取消");
    try {
      const offer = await peer.createOffer({ iceRestart: true });
      await peer.setLocalDescription(offer);
    } catch (error) {
      throw asDirectError(error, "offer", "P2P restart offer 生成失败");
    }
    await waitForDirectICE(peer, signal);
    const sdp = peer.localDescription?.sdp;
    if (!sdp || !validApplicationSDP(sdp)) throw new DirectError("offer", "P2P restart offer 无效");
    return {
      attemptId,
      sdp,
      apply: async (answer) => {
        if (!validApplicationSDP(answer)) throw new DirectError("answer", "P2P restart answer 无效");
        try {
          await peer.setRemoteDescription({ type: "answer", sdp: answer });
        } catch (error) {
          throw asDirectError(error, "answer", "P2P restart answer 设置失败");
        }
      },
    };
  } catch (error) {
    throw asDirectError(error, "offer", "P2P restart offer 生成失败");
  }
}

export async function createDirectOffer(signal?: AbortSignal): Promise<DirectOffer> {
  if (typeof RTCPeerConnection === "undefined") throw new DirectError("unsupported", "当前浏览器不支持 WebRTC");
  const attemptId = newDirectAttemptId();
  let peer: RTCPeerConnection;
  try {
    peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
  } catch (error) {
    throw asDirectError(error, "offer", "P2P 初始化失败");
  }
  let channel: RTCDataChannel;
  try {
    channel = peer.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true, protocol: DATA_CHANNEL_PROTOCOL });
  } catch (error) {
    try { peer.close(); } catch { /* already closed */ }
    throw asDirectError(error, "offer", "P2P 初始化失败");
  }
  const close = () => {
    try { channel.close(); } catch { /* already closed */ }
    try { peer.close(); } catch { /* already closed */ }
  };
  signal?.addEventListener("abort", close, { once: true });
  try {
    if (signal?.aborted) throw new DirectError("cancelled", "P2P 协商已取消");
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
    } catch (error) {
      throw asDirectError(error, "offer", "P2P offer 生成失败");
    }
    const iceGathering = await waitForDirectICE(peer, signal);
    const sdp = peer.localDescription?.sdp;
    if (!sdp || sdp.length > MAX_SDP_BYTES) throw new DirectError("offer", "P2P offer 无效");
    return {
      attemptId,
      get sdp() {
        const current = peer.localDescription?.sdp;
        if (!current || current.length > MAX_SDP_BYTES) throw new DirectError("offer", "P2P offer 无效");
        return current;
      },
      iceGathering,
      close,
      accept: async (answer, acceptSignal = signal) => {
        if (answer.attemptId !== attemptId) throw new DirectError("answer", "P2P attempt_id 不匹配", "bad_message");
        try {
          await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        } catch (error) {
          throw asDirectError(error, "answer", "P2P answer 设置失败");
        }
        await waitForOpen(channel, acceptSignal);
        return new DataFrameChannel(channel, peer);
      },
    };
  } catch (error) {
    close();
    throw asDirectError(error, "offer", "P2P offer 生成失败");
  } finally {
    signal?.removeEventListener("abort", close);
  }
}
