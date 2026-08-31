import { b64url, hexToBytes } from "./bytes.ts";
import { DataFrameChannel } from "./data-channel.ts";
import { ProtocolError } from "./errors.ts";
import { isRecord } from "./session-message.ts";

const DIRECT_NEGOTIATION_MS = 8_000;
const MAX_SDP_BYTES = 64 * 1024;
const DATA_CHANNEL_LABEL = "pairfob";
const DATA_CHANNEL_PROTOCOL = "pairfob.v1";

export type DirectAnswer = {
  attemptId: string;
  routeId: Uint8Array;
  sdp: string;
};

export type DirectOffer = {
  attemptId: string;
  sdp: string;
  accept(answer: DirectAnswer): Promise<DataFrameChannel>;
  close(): void;
};

function p2pError(message: string): ProtocolError {
  return new ProtocolError("p2p_unavailable", message);
}

function waitForICE(peer: RTCPeerConnection, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(p2pError("P2P 协商已取消"));
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
      signal?.removeEventListener("abort", aborted);
    };
    const changed = () => {
      if (peer.iceGatheringState !== "complete") return;
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(p2pError("P2P 协商已取消"));
    };
    const timer = globalThis.setTimeout(() => {
      cleanup();
      reject(p2pError("P2P ICE 候选收集超时"));
    }, DIRECT_NEGOTIATION_MS);
    peer.addEventListener("icegatheringstatechange", changed);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function waitForOpen(channel: RTCDataChannel, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(p2pError("P2P 协商已取消"));
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
      reject(p2pError("P2P DataChannel 建立失败"));
    };
    const aborted = () => {
      cleanup();
      reject(p2pError("P2P 协商已取消"));
    };
    const timer = globalThis.setTimeout(() => {
      cleanup();
      reject(p2pError("P2P DataChannel 建立超时"));
    }, DIRECT_NEGOTIATION_MS);
    channel.addEventListener("open", opened, { once: true });
    channel.addEventListener("close", failed, { once: true });
    channel.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export function parseDirectAnswer(value: unknown, expectedAttemptId: string): DirectAnswer {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.attempt_id !== expectedAttemptId ||
      typeof value.route_id !== "string" || !/^[0-9a-f]{32}$/.test(value.route_id) ||
      typeof value.sdp !== "string" || value.sdp.length === 0 || value.sdp.length > MAX_SDP_BYTES ||
      !value.sdp.startsWith("v=0") || !value.sdp.includes("m=application")) {
    throw new ProtocolError("bad_message", "P2P answer 格式错误");
  }
  return { attemptId: expectedAttemptId, routeId: hexToBytes(value.route_id), sdp: value.sdp };
}

export async function createDirectOffer(signal?: AbortSignal): Promise<DirectOffer> {
  if (typeof RTCPeerConnection === "undefined") throw p2pError("当前浏览器不支持 WebRTC");
  const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
  const channel = peer.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true, protocol: DATA_CHANNEL_PROTOCOL });
  const attemptId = `p2p_${b64url(crypto.getRandomValues(new Uint8Array(18)))}`;
  const close = () => {
    try { channel.close(); } catch { /* already closed */ }
    try { peer.close(); } catch { /* already closed */ }
  };
  try {
    if (signal?.aborted) throw p2pError("P2P 协商已取消");
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForICE(peer, signal);
    const sdp = peer.localDescription?.sdp;
    if (!sdp || sdp.length > MAX_SDP_BYTES) throw p2pError("P2P offer 无效");
    return {
      attemptId,
      sdp,
      close,
      accept: async (answer) => {
        if (answer.attemptId !== attemptId) throw new ProtocolError("bad_message", "P2P attempt_id 不匹配");
        await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        await waitForOpen(channel, signal);
        return new DataFrameChannel(channel, peer);
      },
    };
  } catch (error) {
    close();
    throw error instanceof ProtocolError ? error : p2pError(String(error));
  }
}
