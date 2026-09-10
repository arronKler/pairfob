import { useDomain } from "../../shared/react/use-domain";
import { boardStore } from "./layout-store";

/** React snapshot for the board layout/camera domain. Owned by the board feature. */
export function useBoard() {
  return useDomain(boardStore);
}
