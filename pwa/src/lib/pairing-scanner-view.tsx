import { useLayoutEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";
import { t } from "./i18n.ts";
import { haptic, prefersReducedMotion } from "./dom.ts";
import { parsePairingURL, type FragmentPairing } from "./pairing-input.ts";
import { presentModal, type ModalController } from "./react-modal.tsx";

export class PairingScanError extends Error {}

type ScanOutcome = { pairing: FragmentPairing } | { failure: unknown };
type ScannerEngine = Pick<QrScanner, "start" | "stop" | "destroy">;
export type ScannerFactory = (video: HTMLVideoElement, onDecode: (data: string) => void) => ScannerEngine;

const createScanner: ScannerFactory = (video, onDecode) => new QrScanner(
  video, result => onDecode(result.data),
  { preferredCamera: "environment", returnDetailedScanResult: true, maxScansPerSecond: 8 },
);

function cameraMessage(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return t("scan.cameraDenied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return t("scan.noCamera");
  return t("scan.cameraFail");
}

/** The engine owns the camera; React owns the dialog and its complete lifetime. */
export function PairingScanner({ modal, expectedOrigin, factory = createScanner }: {
  modal: ModalController<ScanOutcome>;
  expectedOrigin: string;
  factory?: ScannerFactory;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const cancel = useRef(() => {});
  const [error, setError] = useState("");
  const [hit, setHit] = useState(false);

  useLayoutEffect(() => {
    const dialog = modal.dialog.current!;
    let engine: ScannerEngine | undefined;
    let retired = false;
    let decoded = false;
    let hitTimer: ReturnType<typeof setTimeout> | undefined;
    const retire = () => {
      if (retired) return;
      retired = true;
      clearTimeout(hitTimer);
      engine?.destroy();
    };
    cancel.current = () => { retire(); modal.dismiss(); };
    const onCancel = (event: Event) => { event.preventDefault(); cancel.current(); };
    const fail = (failure: unknown) => {
      if (retired) return;
      retire();
      modal.close({ failure });
    };
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", modal.finish);
    try {
      dialog.showModal();
    } catch {
      // finish unmounts the portal, so synchronous mount errors settle after commit.
      queueMicrotask(() => fail(new PairingScanError(t("scan.noWindow"))));
    }
    if (dialog.open) {
      try {
        engine = factory(video.current!, data => {
          if (retired || decoded) return;
          const pairing = parsePairingURL(data, expectedOrigin);
          if (!pairing) { setError(t("scan.wrongSite")); return; }
          decoded = true;
          engine?.stop();
          setHit(true);
          haptic(12);
          hitTimer = setTimeout(() => {
            if (retired) return;
            retire();
            modal.close({ pairing });
          }, prefersReducedMotion() ? 0 : 180);
        });
        void engine.start().catch(cause => fail(new PairingScanError(cameraMessage(cause))));
      } catch (cause) {
        queueMicrotask(() => fail(cause));
      }
    }
    return () => {
      retire();
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", modal.finish);
      if (dialog.open) dialog.close();
    };
  }, [modal, expectedOrigin, factory]);

  return <dialog ref={modal.dialog} className="scanner-modal" aria-labelledby="scanner-title" data-react-modal="">
    <h2 id="scanner-title">{t("scan.title")}</h2>
    <p>{t("scan.note")}</p>
    <div className="scanner-viewport">
      <video ref={video} playsInline muted />
      <div className={`scanner-guide${hit ? " is-hit" : ""}`} aria-hidden="true">
        {["tl", "tr", "bl", "br"].map(corner => <span key={corner} className={`scanner-corner scanner-corner-${corner}`} />)}
      </div>
    </div>
    <p className="scanner-error" role="alert">{error}</p>
    <button type="button" className="btn btn-ghost" onClick={() => cancel.current()}>{t("scan.cancel")}</button>
  </dialog>;
}

export async function openPairingScanner(expectedOrigin: string, factory?: ScannerFactory): Promise<FragmentPairing | null> {
  const modal = presentModal<ScanOutcome>(controller => <PairingScanner modal={controller} expectedOrigin={expectedOrigin} factory={factory} />);
  const outcome = await modal.result;
  if (outcome && "failure" in outcome) throw outcome.failure;
  return outcome?.pairing ?? null;
}
