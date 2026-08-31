import QrScanner from "qr-scanner";
import { t } from "./i18n.ts";
import { parsePairingURL, type FragmentPairing } from "./pairing-input.ts";

export class PairingScanError extends Error {}

export async function scanPairingCode(expectedOrigin: string): Promise<FragmentPairing | null> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new PairingScanError(t("scan.noCamera"));
  }

  const dialog = document.createElement("dialog");
  dialog.className = "scanner-modal";
  dialog.setAttribute("aria-labelledby", "scanner-title");
  const title = document.createElement("h2");
  title.id = "scanner-title";
  title.textContent = t("scan.title");
  const note = document.createElement("p");
  note.textContent = t("scan.note");
  const viewport = document.createElement("div");
  viewport.className = "scanner-viewport";
  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.muted = true;
  const guide = document.createElement("div");
  guide.className = "scanner-guide";
  guide.setAttribute("aria-hidden", "true");
  viewport.append(video, guide);
  const error = document.createElement("p");
  error.className = "scanner-error";
  error.setAttribute("role", "alert");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-ghost";
  cancel.textContent = t("scan.cancel");
  dialog.append(title, note, viewport, error, cancel);
  document.body.append(dialog);
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  let scanner: QrScanner | null = null;
  return await new Promise<FragmentPairing | null>((resolve, reject) => {
    let settled = false;
    const finish = (value: FragmentPairing | null, failure?: Error) => {
      if (settled) return;
      settled = true;
      scanner?.destroy();
      if (dialog.open) dialog.close();
      dialog.remove();
      returnFocus?.focus();
      if (failure) reject(failure);
      else resolve(value);
    };
    cancel.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    try {
      dialog.showModal();
    } catch {
      finish(null, new PairingScanError(t("scan.noWindow")));
      return;
    }
    scanner = new QrScanner(
      video,
      (result) => {
        const pairing = parsePairingURL(result.data, expectedOrigin);
        if (!pairing) {
          error.textContent = t("scan.wrongSite");
          return;
        }
        finish(pairing);
      },
      { preferredCamera: "environment", returnDetailedScanResult: true, maxScansPerSecond: 8 },
    );
    scanner.start().catch(() => finish(null, new PairingScanError(t("scan.cameraFail"))));
  });
}
