import { ProtocolError } from "./errors.ts";

export type MuxProtocol = 1 | 2;

export const SUBPROTOCOL_V1 = "pairfob.v1";
export const SUBPROTOCOL_V2 = "pairfob.v2";

export function muxSubprotocol(protocol: MuxProtocol): string {
  return protocol === 2 ? SUBPROTOCOL_V2 : SUBPROTOCOL_V1;
}

/** Infer mux version from the Upgrade path. Inner DeviceHello / RPC stay `"v":1`. */
export function muxProtocolFromRelayURL(relayWS: string): MuxProtocol {
  try {
    const path = new URL(relayWS, "ws://localhost").pathname;
    if (path === "/v2/ws") return 2;
  } catch {
    /* fall through to v1 */
  }
  return 1;
}

export function helloClientBody(protocol: MuxProtocol): { v: MuxProtocol; protocol: MuxProtocol } {
  return { v: protocol, protocol };
}

export function pairAttachBody(protocol: MuxProtocol, pairRef?: string): { v: MuxProtocol; pair_ref?: string } {
  if (protocol === 2) {
    if (!pairRef) throw new ProtocolError("invalid_pair_ref", "v2 PAIR_ATTACH 必须带 pair_ref");
    return { v: 2, pair_ref: pairRef };
  }
  return pairRef ? { v: 1, pair_ref: pairRef } : { v: 1 };
}

export function sessionAttachBody(protocol: MuxProtocol, daemonId: string): { v: MuxProtocol; daemon_id: string } {
  return { v: protocol, daemon_id: daemonId };
}

export function pairingWsUsesTicket(relayWS: string): boolean {
  try {
    return new URL(relayWS, "ws://localhost").searchParams.has("pair_ticket");
  } catch {
    return false;
  }
}
