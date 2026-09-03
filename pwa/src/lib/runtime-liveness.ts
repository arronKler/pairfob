/**
 * Client-side reachability verdict for the Herdr behind a session.
 *
 * Loss of contact is never process death: a dropped socket, an offline
 * phone, or a failed GetConfig only ever mean "unverifiable". Only a
 * connected session that reports `runtime=offline` proves Herdr exited.
 * There is no fourth verdict; `stale` / `dead` / `unknown` do not exist.
 */

export type RuntimeLiveness = "live" | "unverifiable" | "exited";

export type RuntimeLivenessInput = {
  /** The session transport is established (`state.live?.isConnected()`). */
  connected: boolean;
  /** The phone itself has network (`state.networkOnline`). */
  networkOnline: boolean;
  /** Last known `GetConfig.runtime`; empty means never read or read failed. */
  runtimeKind: string;
};

export function runtimeLiveness(input: RuntimeLivenessInput): RuntimeLiveness {
  if (!input.networkOnline || !input.connected) return "unverifiable";
  if (input.runtimeKind === "herdr" || input.runtimeKind === "fake") return "live";
  if (input.runtimeKind === "offline") return "exited";
  return "unverifiable";
}
