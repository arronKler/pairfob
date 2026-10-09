import { Globe } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useComputers } from "../../features/computers/hooks";
import { useConnection } from "../../features/connection/hooks";
import { usePairing } from "../../features/pairing/hooks";
import { cancelAddComputer } from "../../features/computers/actions";
import {
  connectPageInput, cancelPairing, disposePairingPageTransport, onPairSubmit, pastePairCode,
  scanPairCode, setManualPairOpen, setPairCode, retirePairingWork,
} from "../../features/pairing/actions";
import { ConnectView } from "../../features/pairing/connect-view";
import { connectViewModel } from "../../features/pairing/model";
import { claimPairingPage, releasePairingPage } from "../../features/pairing/work";
import { LanguageSelect } from "../../features/settings/language";
import { useAppNotice } from "../../app/notice";
import { pointerFine } from "../../app/input-mode";
import { isRoomy, ROOMY_QUERY } from "../../app/viewport";
import { appRoot } from "../../app/dom-root";
import { langRevision, subscribeLang, t } from "../../lib/i18n";
import { showHelp } from "../../shared/ui/overlay";

/**
 * Connect/pairing page composition.
 *
 * Subscribes to pairing, connection and computers so typed handshake updates
 * reach an already-mounted form without a global paint. The view input is
 * assembled from the subscribed domain snapshots, keeping staged composition
 * changes aligned with the published frame.
 *
 * The pair-code field is a controlled input whose value comes from the pairing
 * domain. Keystrokes call `setPairCode`, which publishes that domain — the same
 * local update drives the subscribed form.
 * Caret/IME stay on the node because the form is not remounted.
 *
 * Scanner/paste teardown: this screen instance owns pairing work. Unmount
 * releases that owner synchronously (no shared timer) and disposes the
 * handshake transport the retired page started, so a late camera or clipboard
 * reply cannot handshake or overwrite a replacement and the stale transport
 * cannot settle into the new page. StrictMode replays the same instance and
 * restores its generation; a different ConnectScreen cannot inherit either.
 */

/** Re-render mounted copy on the i18n revision (advances on every applied language action). */
function useLang(): void {
  useSyncExternalStore(subscribeLang, langRevision);
}

/**
 * A device fact that follows its media query. Nothing else repaints this page
 * when the window crosses the breakpoint or a trackpad joins a tablet; the value
 * still comes from the fact's own reader.
 */
function useMediaFact(query: string, read: () => boolean): boolean {
  const subscribe = useCallback((notify: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
  }, [query]);
  return useSyncExternalStore(subscribe, read);
}

function useConnectView() {
  const pairing = usePairing();
  const connection = useConnection();
  const computers = useComputers();
  useLang();
  const notice = useAppNotice();
  // Width decides the layout and the pointer decides the way in: a landscape
  // tablet is wide and still scans; a mouse types the code at any width.
  const device = {
    wide: useMediaFact(ROOMY_QUERY, isRoomy),
    finePointer: useMediaFact("(hover: hover) and (pointer: fine)", pointerFine),
  };
  // Project from the subscribed snapshots: a staged phase hold keeps the form's
  // busy state on the same published phase as its frame.
  return { view: connectViewModel(connectPageInput(device, notice, { connection, computers, pairing })) };
}

function usePairingPageOwner(): void {
  const owner = useRef<object | null>(null);
  if (owner.current === null) owner.current = {};
  useLayoutEffect(() => {
    const page = owner.current!;
    claimPairingPage(page);
    return () => {
      releasePairingPage(page);
      disposePairingPageTransport(page);
    };
  }, []);
}

const INSTALL_COMMAND = "curl -fsSL https://pairfob.com/install.sh | sh";

/** "Not installed yet?": the install command and the Herdr plugin route. */
function showPairfobInstall(): void {
  showHelp(t("connect.installTitle"), [
    t("connect.installReq"),
    { before: t("connect.installRunBefore"), code: INSTALL_COMMAND, after: t("connect.installRunAfter") },
    t("connect.installPlugin"),
  ]);
}

export function ConnectScreen() {
  const { view } = useConnectView();
  usePairingPageOwner();
  // Where the code is typed on the page, the keyboard lands on its field: on
  // load, and again when a handshake hands the page back. A touch screen gets
  // no focus it did not ask for; the code sheet focuses its own field.
  const typed = view.entry === "code";
  useLayoutEffect(() => {
    if (view.busy || !typed) return;
    appRoot().querySelector<HTMLInputElement>("#pair-code")?.focus({ preventScroll: true });
  }, [view.busy, typed]);

  return (
    <ConnectView
      view={view}
      language={<label className="connect-lang"><Globe size={16} aria-hidden="true" /><LanguageSelect /></label>}
      onBack={() => {
        retirePairingWork();
        cancelAddComputer();
      }}
      onCancel={cancelPairing}
      onScan={() => void scanPairCode()}
      onOpenCode={() => setManualPairOpen(true)}
      onCloseCode={() => setManualPairOpen(false)}
      onInstall={showPairfobInstall}
      onPaste={() => void pastePairCode()}
      onSubmit={event => { void onPairSubmit(event.nativeEvent); }}
      onCodeChange={setPairCode}
    />
  );
}
