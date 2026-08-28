import { describe, expect, test } from "bun:test";
import {
  helloClientBody,
  muxProtocolFromRelayURL,
  muxSubprotocol,
  pairAttachBody,
  pairingWsUsesTicket,
  sessionAttachBody,
} from "./mux.ts";
import { ProtocolError } from "./errors.ts";

describe("mux control JSON", () => {
  test("v1 HELLO and ATTACH stay {v:1, protocol:1} without required pair_ref", () => {
    expect(muxProtocolFromRelayURL("wss://example.test/v1/ws")).toBe(1);
    expect(muxSubprotocol(1)).toBe("pairfob.v1");
    expect(helloClientBody(1)).toEqual({ v: 1, protocol: 1 });
    expect(pairAttachBody(1)).toEqual({ v: 1 });
    expect(pairAttachBody(1, "4f7a2c9e1b0d88aa55cc3311abde7001")).toEqual({
      v: 1,
      pair_ref: "4f7a2c9e1b0d88aa55cc3311abde7001",
    });
    expect(sessionAttachBody(1, "d_0123456789abcdefabcd")).toEqual({
      v: 1,
      daemon_id: "d_0123456789abcdefabcd",
    });
    expect(JSON.stringify(helloClientBody(1))).not.toContain("pair_loc");
  });

  test("v2 HELLO/ATTACH use mux v=2 and require pair_ref", () => {
    expect(muxProtocolFromRelayURL("wss://pairfob.com/v2/ws?role=client&daemon_id=d_1")).toBe(2);
    expect(muxSubprotocol(2)).toBe("pairfob.v2");
    expect(helloClientBody(2)).toEqual({ v: 2, protocol: 2 });
    expect(pairAttachBody(2, "4f7a2c9e1b0d88aa55cc3311abde7001")).toEqual({
      v: 2,
      pair_ref: "4f7a2c9e1b0d88aa55cc3311abde7001",
    });
    expect(() => pairAttachBody(2)).toThrow(ProtocolError);
    expect(sessionAttachBody(2, "d_0123456789abcdefabcd")).toEqual({
      v: 2,
      daemon_id: "d_0123456789abcdefabcd",
    });
    expect(JSON.stringify(pairAttachBody(2, "4f7a2c9e1b0d88aa55cc3311abde7001"))).not.toContain("pair_loc");
    expect(pairingWsUsesTicket("wss://pairfob.com/v2/ws?role=client&pair_ticket=ab")).toBe(true);
    expect(pairingWsUsesTicket("wss://pairfob.com/v2/ws?role=client&daemon_id=d_1")).toBe(false);
  });
});
