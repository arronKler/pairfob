import { useDomain } from "../../shared/react/use-domain";
import { capabilitiesStore } from "./capabilities-store";

/** React snapshot for the operation capabilities domain. Owned by the operations feature. */
export function useCapabilities() {
  return useDomain(capabilitiesStore);
}
