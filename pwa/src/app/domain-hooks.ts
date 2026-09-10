import { useDomain } from "../shared/react/use-domain";
import { navigationStore } from "./navigation-store";
import { noticesStore } from "./notices-store";

/**
 * React snapshots for the App-owned coordination domains: which screen is shown
 * and the one scoped toast. These two domains are App composition/coordination
 * state, so their hooks live in the App rather than in a feature.
 */
export function useNavigation() {
  return useDomain(navigationStore);
}

export function useNotices() {
  return useDomain(noticesStore);
}
