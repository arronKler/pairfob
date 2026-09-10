import { useDomain } from "../../shared/react/use-domain";
import { dashboardStore } from "./catalog-store";

/** React snapshot for the dashboard/herd catalog domain. Owned by the dashboard feature. */
export function useDashboard() {
  return useDomain(dashboardStore);
}
