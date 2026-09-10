import { useDomain } from "../../shared/react/use-domain";
import { preferencesStore } from "./preferences-store";

/** React snapshot for the device-local preferences domain. Owned by the settings feature. */
export function usePreferences() {
  return useDomain(preferencesStore);
}
