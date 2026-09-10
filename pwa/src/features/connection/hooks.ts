import { useDomain } from "../../shared/react/use-domain";
import { connectionStore } from "./connection-store";
import { runtimeStore } from "./runtime-store";

/** React snapshots for the connection/runtime domains. Owned by the connection feature. */
export function useConnection() {
  return useDomain(connectionStore);
}

export function useRuntime() {
  return useDomain(runtimeStore);
}
