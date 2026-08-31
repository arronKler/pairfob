import { describe, expect, test } from "bun:test";
import { parseDirectAnswer } from "./direct-peer.ts";
import { ProtocolError } from "./errors.ts";

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
