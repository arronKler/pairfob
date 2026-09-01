import { b64url, hexToBytes } from "./bytes.ts";
import { DataFrameChannel } from "./data-channel.ts";
import { ProtocolError } from "./errors.ts";
import { isRecord } from "./session-message.ts";

const DIRECT_NEGOTIATION_MS = 8_000;
export const MAX_SDP_BYTES = 64 * 1024;
const DATA_CHANNEL_LABEL = "pairfob";
const DATA_CHANNEL_PROTOCOL = "pairfob.v1";

export type DirectICEGathering = "complete" | "partial";
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
  accept(answer: DirectAnswer): Promise<DataFrameChannel>;
  close(): void;
};

function hasICECandidate(peer: RTCPeerConnection): boolean {
  return /(?:^|\r?\n)a=candidate:/.test(peer.localDescription?.sdp ?? "");
}

export function waitForDirectICE(
  peer: RTCPeerConnection,
  signal?: AbortSignal,
  timeoutMs = DIRECT_NEGOTIATION_MS,
): Promise<DirectICEGathering> {
  if (signal?.aborted) return Promise.reject(new DirectError("cancelled", "P2P 协商已取消"));
  return new Promise((resolve, reject) => {
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let sawCandidate = hasICECandidate(peer);
    let settled = false;
    const cleanup = () => {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      peer.removeEventListener("icegatheringstatechange", changed);
      peer.removeEventListener("icecandidate", candidate);
      signal?.removeEventListener("abort", aborted);
    };
    const finish = (result: DirectICEGathering) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: DirectError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finishComplete = () => {
      sawCandidate = sawCandidate || hasICECandidate(peer);
      if (sawCandidate) finish("complete");
      else fail(new DirectError("ice_failed", "P2P 未找到可用 ICE 候选"));
    };
    const changed = () => {
      if (peer.iceGatheringState === "complete") finishComplete();
    };
    const candidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) sawCandidate = true;
      else if (peer.iceGatheringState === "complete") finishComplete();
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
    if (peer.iceGatheringState === "complete") finishComplete();
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
      sdp,
      iceGathering,
      close,
      accept: async (answer) => {
        if (answer.attemptId !== attemptId) throw new DirectError("answer", "P2P attempt_id 不匹配", "bad_message");
        try {
          await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        } catch (error) {
          throw asDirectError(error, "answer", "P2P answer 设置失败");
        }
        await waitForOpen(channel, signal);
        return new DataFrameChannel(channel, peer);
      },
    };
  } catch (error) {
    close();
    throw asDirectError(error, "offer", "P2P offer 生成失败");
  }
}
