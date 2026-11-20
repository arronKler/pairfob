import { useCapabilities } from "../operations/hooks";
import { useComputers } from "../computers/hooks";
import { DesktopScreen } from "./desktop-surface";

/**
 * Compatibility export; navigation routes mount `DesktopScreen` and
 * `DesktopSettingsSection` directly.
 */
export function ConnectedDesktop() {
  const host = useComputers().credential;
  const caps = useCapabilities().operationCapabilities;
  return host && caps.view_desktop ? <DesktopScreen key={host.daemonId} /> : null;
}
