import { useDomain } from "../../shared/react/use-domain";
import { pairingStore } from "./form-store";

/** React snapshot for the pairing handshake form domain. Owned by the pairing feature. */
export function usePairing() {
  return useDomain(pairingStore);
}
