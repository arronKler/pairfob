import { useLayoutEffect, useRef, useState } from "react";
import { CameraOff, Keyboard } from "lucide-react";
import QrScanner from "qr-scanner";
import { t } from "./i18n.ts";
import { haptic, prefersReducedMotion } from "./dom.ts";
import { parsePairingURL, type FragmentPairing } from "./pairing-input.ts";
import { dialogClass, useDeskForm } from "../shared/ui/overlay/desk-form";
import { presentModal, type ModalController } from "../shared/ui/overlay/modal";
import { useQuietFocus } from "../shared/ui/overlay/quiet-focus";
import { SheetContent } from "../shared/ui/overlay/sheet-content";
import { bindSheetDrag } from "../shared/ui/overlay/sheet-drag";

export class PairingScanError extends Error {}

/** A decoded pairing, the reader asking to type the code instead, or a failure to open. */
type ScanOutcome = { pairing: FragmentPairing } | { typeCode: true } | { failure: unknown };
export type ScanResult = FragmentPairing | "code" | null;
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

/**
 * The engine owns the camera; React owns the dialog and its complete lifetime.
 * The dialog is the shared bottom sheet (a centered modal on desk). A camera
 * that cannot start keeps the sheet open and explains why, with typing the
 * code as the way forward; only a sheet that cannot open at all rejects.
 */
export function PairingScanner({ modal, expectedOrigin, factory = createScanner, unavailable = "" }: {
  modal: ModalController<ScanOutcome>;
  expectedOrigin: string;
  factory?: ScannerFactory;
  /** Known before opening: no camera API at all. */
  unavailable?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const cancel = useRef(() => {});
  const typeCode = useRef(() => {});
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(unavailable);
  const [hit, setHit] = useState(false);
  const deskForm = useDeskForm();
  // This dialog shows itself, so it asks for what the shared lifecycle gives every other one.
  useQuietFocus(modal.dialog);

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
    typeCode.current = () => { retire(); modal.close({ typeCode: true }); };
    const onCancel = (event: Event) => { event.preventDefault(); cancel.current(); };
    const fail = (failure: unknown) => {
      if (retired) return;
      retire();
      modal.close({ failure });
    };
    let disposeDrag: (() => void) | undefined;
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", modal.finish);
    try {
      dialog.showModal();
    } catch {
      // finish unmounts the portal, so synchronous mount errors settle after commit.
      queueMicrotask(() => fail(new PairingScanError(t("scan.noWindow"))));
    }
    if (dialog.open && modal.form.current) {
      disposeDrag = bindSheetDrag({ dialog, form: modal.form.current, scroller: body.current, close: () => cancel.current() });
    }
    if (dialog.open && !unavailable) {
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
        void engine.start().catch(cause => {
          if (retired) return;
          retire();
          setBlocked(cameraMessage(cause));
        });
      } catch (cause) {
        queueMicrotask(() => fail(cause));
      }
    }
    return () => {
      retire();
      disposeDrag?.();
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", modal.finish);
      if (dialog.open) dialog.close();
    };
  }, [modal, expectedOrigin, factory, unavailable]);

  return <dialog ref={modal.dialog} className={dialogClass("modal sheet scanner-modal", deskForm)} aria-labelledby="scanner-title" data-react-modal="">
    <form ref={modal.form} method="dialog" onSubmit={event => event.preventDefault()}>
      <SheetContent title={t("scan.title")} titleId="scanner-title" onDismiss={() => cancel.current()} bodyRef={body}>
        {blocked ? <>
          <div className="scanner-blocked" role="alert">
            <CameraOff size={28} aria-hidden="true" />
            <p className="scanner-blocked-title">{t("scan.blockedTitle")}</p>
            <p className="scanner-blocked-copy">{blocked}</p>
          </div>
          <button type="button" className="btn btn-primary scanner-to-code" onClick={() => typeCode.current()}>
            <Keyboard size={18} aria-hidden="true" />{t("connect.manual")}
          </button>
        </> : <>
          <div className="scanner-viewport">
            <video ref={video} playsInline muted />
            <div className={`scanner-guide${hit ? " is-hit" : ""}`} aria-hidden="true">
              {["tl", "tr", "bl", "br"].map(corner => <span key={corner} className={`scanner-corner scanner-corner-${corner}`} />)}
            </div>
          </div>
          <p className="scanner-note">{t("scan.note")}</p>
          <p className="scanner-error" role="alert">{error}</p>
          <button type="button" className="btn btn-ghost scanner-to-code" onClick={() => typeCode.current()}>{t("scan.toCode")}</button>
        </>}
      </SheetContent>
    </form>
  </dialog>;
}

export async function openPairingScanner(expectedOrigin: string, factory?: ScannerFactory, unavailable = ""): Promise<ScanResult> {
  const modal = presentModal<ScanOutcome>(controller => <PairingScanner modal={controller} expectedOrigin={expectedOrigin}
    factory={factory} unavailable={unavailable} />);
  const outcome = await modal.result;
  if (!outcome) return null;
  if ("failure" in outcome) throw outcome.failure;
  if ("typeCode" in outcome) return "code";
  return outcome.pairing;
}
