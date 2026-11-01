import { afterEach, describe, expect, test } from "bun:test";
import type { LiveSession, PairResult } from "../../../lib/protocol/client";
import { applyOriginConfig, setPhase, setSessionTransport } from "../../connection/connection-store";
import { attachLiveSession, setCredential } from "../../computers/catalog-store";
import { attachmentP2PReady } from "./attachments-context";

function liveRelaySession(checking: boolean): void {
  setPhase("live");
  setSessionTransport("relay");
  setCredential({ daemonId: "d1" } as unknown as PairResult);
  attachLiveSession({ isConnected: () => true, isChecking: () => checking } as unknown as LiveSession);
}

afterEach(() => {
  attachLiveSession(null);
  setCredential(null);
  setPhase("connect");
  applyOriginConfig({ protocol: "pairfob.v2", p2p: false } as never);
});

describe("attachmentP2PReady on a relay session", () => {
  test("is ready when P2P is not enabled for the origin", () => {
    applyOriginConfig({ protocol: "pairfob.v2", p2p: false } as never);
    liveRelaySession(false);
    expect(attachmentP2PReady()).toBe(true);
  });

  test("is not ready while the session is checking", () => {
    applyOriginConfig({ protocol: "pairfob.v2", p2p: false } as never);
    liveRelaySession(true);
    expect(attachmentP2PReady()).toBe(false);
  });

  test("is not ready when P2P is enabled but the transport is relay", () => {
    applyOriginConfig({ protocol: "pairfob.v2", p2p: true } as never);
    liveRelaySession(false);
    expect(attachmentP2PReady()).toBe(false);
  });
});
