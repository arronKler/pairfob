import { describe, expect, test } from "bun:test";
import {
  DirectError,
  directFailureDiagnostic,
  parseDirectAnswer,
  parseDirectRestartAnswer,
  waitForDirectICE,
} from "./direct-peer.ts";
import { ProtocolError } from "./errors.ts";

class FakeICEPeer {
  iceGatheringState: RTCIceGatheringState = "gathering";
  localDescription: RTCSessionDescription | null;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(sdp = "v=0\r\n") {
    this.localDescription = { type: "offer", sdp, toJSON: () => ({ type: "offer", sdp }) };
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  complete(): void {
    this.iceGatheringState = "complete";
    for (const listener of this.listeners.get("icegatheringstatechange") ?? []) {
      listener({ type: "icegatheringstatechange" } as Event);
    }
  }
}

describe("direct peer answer boundary", () => {
  const attemptId = "p2p_0123456789abcdef";
  const valid = {
    attempt_id: attemptId,
    route_id: "00112233445566778899aabbccddeeff",
    sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
  };

  test("accepts the exact attempt, route, and application SDP", () => {
    const answer = parseDirectAnswer(valid, attemptId);
    expect(answer.attemptId).toBe(attemptId);
    expect(answer.routeId.length).toBe(16);
    expect(answer.sdp).toBe(valid.sdp);
  });

  test("rejects substituted or ambiguous answers", () => {
    for (const value of [
      { ...valid, attempt_id: "p2p_abcdef0123456789" },
      { ...valid, route_id: valid.route_id.toUpperCase() },
      { ...valid, route_id: "00" },
      { ...valid, sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" },
      { ...valid, extra: true },
    ]) {
      try {
        parseDirectAnswer(value, attemptId);
        throw new Error("accepted invalid answer");
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
      }
    }
  });
});

describe("direct restart answer boundary", () => {
  const attemptId = "p2p_0123456789abcdef";
  const valid = {
    attempt_id: attemptId,
    sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
  };

  test("accepts attempt and application SDP without a new route", () => {
    expect(parseDirectRestartAnswer(valid, attemptId)).toEqual({ attemptId, sdp: valid.sdp });
  });

  test("rejects a restart answer that still carries a route_id", () => {
    expect(() => parseDirectRestartAnswer({ ...valid, route_id: "00112233445566778899aabbccddeeff" }, attemptId)).toThrow(ProtocolError);
  });
});

describe("direct ICE gathering", () => {
  test("uses already gathered candidates when STUN gathering does not finish", async () => {
    const peer = new FakeICEPeer("v=0\r\na=candidate:1 1 UDP 1 192.0.2.1 5000 typ host\r\n");
    await expect(waitForDirectICE(peer as unknown as RTCPeerConnection, undefined, 5)).resolves.toBe("partial");
  });

  test("prefers a completed candidate set", async () => {
    const peer = new FakeICEPeer("v=0\r\na=candidate:1 1 UDP 1 192.0.2.1 5000 typ host\r\n");
    const waiting = waitForDirectICE(peer as unknown as RTCPeerConnection, undefined, 50);
    peer.complete();
    await expect(waiting).resolves.toBe("complete");
  });

  test("reports a bounded diagnostic when no candidate appears", async () => {
    const peer = new FakeICEPeer();
    const error = await waitForDirectICE(peer as unknown as RTCPeerConnection, undefined, 5).catch((caught) => caught);
    expect(error).toBeInstanceOf(DirectError);
    expect(directFailureDiagnostic(error)).toBe("ice_timeout");
  });

  test("rejects a completed gather that has no usable candidate", async () => {
    const peer = new FakeICEPeer();
    const waiting = waitForDirectICE(peer as unknown as RTCPeerConnection, undefined, 50);
    peer.complete();
    const error = await waiting.catch((caught) => caught);
    expect(directFailureDiagnostic(error)).toBe("ice_failed");
  });
});
