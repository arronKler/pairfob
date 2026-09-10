import { useDomain } from "../../shared/react/use-domain";
import { computersStore } from "./catalog-store";

/** React snapshot for the paired-computer catalog domain. Owned by the computers feature. */
export function useComputers() {
  return useDomain(computersStore);
}
