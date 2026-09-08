import { t } from "./i18n.ts";
import type { FragmentPairing } from "./pairing-input.ts";
import { openPairingScanner, PairingScanError } from "./pairing-scanner-view.tsx";

export { PairingScanError } from "./pairing-scanner-view.tsx";

export async function scanPairingCode(expectedOrigin: string): Promise<FragmentPairing | null> {
  if (!navigator.mediaDevices?.getUserMedia) throw new PairingScanError(t("scan.noCamera"));
  return openPairingScanner(expectedOrigin);
}
