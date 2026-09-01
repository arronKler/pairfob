export const NETWORK_MODE_OPTIONS = ["auto", "p2p", "relay"] as const;
export const NETWORK_MODE_KEY = "pairfob:networkMode";

export type NetworkMode = (typeof NETWORK_MODE_OPTIONS)[number];

/** Preference for how the phone reaches the computer. The live path may still be Relay while P2P is attempted. */
export function parseNetworkMode(raw: string | null | undefined, fallback: NetworkMode = "auto"): NetworkMode {
  return NETWORK_MODE_OPTIONS.includes(raw as NetworkMode) ? raw as NetworkMode : fallback;
}

export function loadNetworkMode(): NetworkMode {
  try {
    return parseNetworkMode(localStorage.getItem(NETWORK_MODE_KEY));
  } catch {
    return "auto";
  }
}

export function persistNetworkMode(mode: NetworkMode): void {
  try {
    localStorage.setItem(NETWORK_MODE_KEY, mode);
  } catch {
    /* storage blocked; the choice just does not persist */
  }
}
