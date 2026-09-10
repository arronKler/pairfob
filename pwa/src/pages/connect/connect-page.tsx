import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useComputers } from "../../features/computers/hooks";
import { useConnection } from "../../features/connection/hooks";
import { usePairing } from "../../features/pairing/hooks";
import { langRevision, subscribeLang } from "../../lib/i18n";
import { cancelAddComputer } from "../../features/computers/actions";
import {
  connectPageInput, cancelPairing, disposePairingPageTransport, focusPairCode, onPairSubmit, pastePairCode,
  scanPairCode, setManualPairOpen, setPairCode, retirePairingWork,
} from "../../features/pairing/actions";
import { ConnectView } from "../../features/pairing/connect-view";
import { connectViewModel } from "../../features/pairing/model";
import { claimPairingPage, releasePairingPage } from "../../features/pairing/work";
import { LanguageSelect } from "../../features/settings/language";
import { useAppNotice } from "../../app/notice";
import { isDesk } from "../../app/viewport";

/**
 * Connect/pairing page composition.
 *
 * Subscribes to pairing, connection and computers so typed handshake updates
 * reach an already-mounted form without a global paint. The view input is
 * assembled from live records because production still writes the fragment,
 * catalog and some pairing fields through the compatibility facade.
 *
 * The pair-code field is a controlled input whose value comes from the pairing
 * domain. Keystrokes call `setPairCode`, which publishes that domain — the same
 * local-update the previous reducer performed, without the global paint loop.
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

function useConnectView() {
  const pairing = usePairing();
  const connection = useConnection();
  const computers = useComputers();
  useLang();
  const notice = useAppNotice();
  // Project from the subscribed snapshots: a staged phase hold keeps the form's
  // busy state on the same published phase as its frame.
  return { view: connectViewModel(connectPageInput(isDesk(), notice, { connection, computers, pairing })), notice };
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

export function ConnectScreen() {
  const { view, notice } = useConnectView();
  const form = useRef<HTMLFormElement>(null);
  usePairingPageOwner();
  useLayoutEffect(() => {
    if (view.busy) return;
    if (view.manualOpen) form.current?.querySelector<HTMLInputElement>("#pair-code")?.focus({ preventScroll: true });
    else if (isDesk()) form.current?.querySelector<HTMLButtonElement>(".btn-scan")?.focus({ preventScroll: true });
  }, [view.busy, view.manualOpen]);

  return (
    <ConnectView
      view={view}
      notice={notice}
      language={<div className="connect-lang"><LanguageSelect /></div>}
      formRef={form}
      onBack={() => {
        retirePairingWork();
        cancelAddComputer();
      }}
      onCancel={cancelPairing}
      onScan={() => void scanPairCode()}
      onPaste={() => void pastePairCode()}
      onSubmit={event => { void onPairSubmit(event.nativeEvent); }}
      onToggleManual={open => {
        setManualPairOpen(open);
        if (open) focusPairCode();
      }}
      onCodeChange={setPairCode}
    />
  );
}
