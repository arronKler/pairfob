import { appRoot } from "../../app/dom-root";
import { commitView } from "../../app/host";
import {
  applyPairingFragment, clearPairingFragment, originProtocol, pairingFragment, phase, setPhase, wsURL,
} from "../connection/connection-store";
import {
  addingComputer, computers, liveSession, setAddingComputer, setCredential,
} from "../computers/catalog-store";
import {
  pairAbortHandle, setPairAbort, setPairAwaitingApproval, setPairCodeDraft, setPairFailure, setPairManualOpen,
} from "./form-store";
import { clearNotice, showError, showStatus } from "../../app/notices-store";
import { batch, type DomainView } from "../../shared/model/domain-store";
import type { ConnectionRecord } from "../connection/connection-store";
import type { ComputersRecord } from "../computers/catalog-store";
import type { PairingRecord } from "./form-store";
import { cancelAddComputer, resumeComputer } from "../../features/computers/actions";
import { FRIENDLY_ERROR, messageOf } from "../../lib/notices";
import { t } from "../../lib/i18n";
import { fragmentUsableOnOrigin, parseCodeAndLocator, parsePairingCode, resolveHandPairing } from "../../lib/pairing-input";
import { requestPairIntent } from "../../lib/pair-intent";
import { PairingScanError, scanPairingCode } from "../../lib/pairing-scanner";
import { normalizeCrockford } from "../../lib/protocol/bytes";
import { pairOverWS, ProtocolError, type PairInput } from "../../lib/protocol/client";
import { friendlyDeviceLabel, pairErrorField, shouldForgetPairFragment, type PairErrorField, type PairStepKey } from "../../lib/ui-model";
import { saveCredential } from "../../lib/credentials";
import { track } from "../../lib/telemetry";
import type { ConnectNotice, ConnectViewInput } from "./model";
import {
  claimPairingAttempt, claimPairingTransport, clearPairingTransport, pairingPageOwner, pairingTransportAbortFor,
  pairingWorkId, retirePairingWork,
} from "./work";

export { retirePairingWork } from "./work";

/**
 * Pairing controller — the feature's one connected adapter.
 *
 * Handshake mutations and reads go through the pairing/connection/computers
 * domain actions and selectors; nothing here reads the compatibility facade.
 * Focus-after-error and landing boundaries commit the composition through the
 * application port (`commitView`); ordinary handshake updates publish their
 * domains and the mounted page repaints through its own subscriptions.
 *
 * `pairingWork` is a generation token owned by a ConnectScreen instance.
 * A late scan/paste/begin after cancel, back or unmount must not start a
 * handshake, overwrite a replacement draft, or steal focus.
 */

function currentWork(): number {
  return pairingWorkId();
}

/**
 * Land an error/cancel for this abort if the attempt still owns the screen.
 * `page` is the ConnectScreen instance captured before any render or
 * notification. Once that page is released its late results must not paint;
 * a still-mounted page only owns landing while its handle is the current
 * attempt, because an awaiting/abort callback may have started a replacement
 * on the same page. Controller-only attempts (no page) keep the legacy
 * abort-handle fallback.
 */
export function pairingErrorStillOwned(work: number, abort: AbortController, page: object | null = null): boolean {
  const handle = pairAbortHandle();
  if (work === currentWork()) return page === null || handle === abort;
  if (page !== null) return pairingPageOwner() === page && handle === abort;
  return phase() === "pairing" && (handle === abort || handle === null);
}

function runIfCurrentWork(work: number, run: () => void): void {
  queueMicrotask(() => {
    if (work !== currentWork()) return;
    run();
  });
}

/**
 * Focus an error field only while `work` still owns the page. Callers capture
 * the initiating work before any notification/render: render can install a
 * replacement page, and re-reading the generation afterwards would authorize
 * the old callback's app-global selector on the new page.
 */
function focusPairField(name: PairErrorField, work: number): void {
  if (!name) return;
  runIfCurrentWork(work, () => {
    (appRoot().querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.focus();
  });
}

function rejectLocal(target: PairErrorField, text: string, work: number): void {
  batch(() => {
    setPhase("connect");
    setPairManualOpen(true);
    setPairFailure(target, "code");
    showError(text, true);
  });
  commitView();
  focusPairField(target, work);
}

/** Reject a v=1 fragment on a protocol=2 origin (and vice versa) as an expired code. */
export function applyOriginPairingPolicy(): boolean {
  const work = currentWork();
  const fragment = pairingFragment();
  if (!fragment || fragmentUsableOnOrigin(fragment, originProtocol())) return false;
  clearPairingFragment();
  setPairCodeDraft("");
  rejectLocal("code", FRIENDLY_ERROR.unpaired, work);
  return true;
}

export async function onPairSubmit(event: Event): Promise<void> {
  event.preventDefault();
  const data = new FormData(event.target as HTMLFormElement);
  await beginPairing(String(data.get("code") || ""));
}

export function setPairCode(code: string): void {
  setPairCodeDraft(code);
}

export function setManualPairOpen(open: boolean): void {
  setPairManualOpen(open);
}

export async function beginPairing(rawCode: string): Promise<void> {
  if (phase() === "pairing") return;
  // A new intent advances the attempt generation before anything captures it:
  // a stale landing from an earlier attempt can never adopt this attempt's
  // screen, even when this intent later fails local validation or is cancelled
  // and leaves the handle null.
  claimPairingAttempt();
  const work = currentWork();
  const page = pairingPageOwner();
  const scanned = pairingFragment();
  setPairCodeDraft(rawCode);
  setPairFailure(null, null);

  if (scanned && !fragmentUsableOnOrigin(scanned, originProtocol())) {
    clearPairingFragment();
    rejectLocal("code", FRIENDLY_ERROR.unpaired, work);
    return;
  }

  const resolved = resolveHandPairing(2, rawCode, Boolean(scanned));
  if (!resolved.ok) {
    const length = normalizeCrockford(rawCode).length;
    rejectLocal("code", rawCode ? t("err.pairIncomplete", { n: length }) : FRIENDLY_ERROR.locator_required, work);
    return;
  }
  pairAbortHandle()?.abort();
  const abort = new AbortController();
  claimPairingTransport(page, abort);
  batch(() => {
    setPairAbort(abort);
    setPairAwaitingApproval(false);
    setPairFailure(null, null);
    setPhase("pairing");
    clearNotice();
  });
  // The phase/handle publication can retire this attempt: cancel, back, unmount
  // or a replacement a subscriber started all advance the generation. Re-check
  // before any transport work so a stale continuation never opens a handshake
  // on the replacement's behalf.
  if (work !== currentWork()) {
    clearPairingTransport(abort);
    return;
  }
  track("pwa_pairing_start", { extra: scanned ? "qr" : "manual" });
  let reached: PairStepKey = "channel";
  try {
    let relay = wsURL();
    let attach: PairInput = scanned ? { pair_ref: scanned.pairRef } : {};
    if (scanned?.daemonId) {
      relay = wsURL({ daemonId: scanned.daemonId });
      attach = { pair_ref: scanned.pairRef };
    } else {
      const intent = await requestPairIntent(resolved.loc!, fetch, abort.signal);
      if (abort.signal.aborted || work !== currentWork()) {
        throw new ProtocolError("pairing_cancelled", t("err.pairing_cancelled"));
      }
      relay = wsURL({ daemonId: intent.daemonId, pairTicket: intent.pairTicket });
      attach = { pair_ref: intent.pairRef };
    }
    const pair = await pairOverWS(relay, attach, resolved.code, {
      protocol: originProtocol(),
      expectedDaemonId: scanned?.daemonId,
      expectedFingerprint: scanned?.fingerprint,
      label: friendlyDeviceLabel(navigator.userAgent),
      onAwaitApproval: () => {
        if (work !== currentWork()) return;
        reached = "verify";
        setPairAwaitingApproval(true);
        showStatus(t("pair.verified"), true);
      },
      signal: abort.signal,
    });
    if (work !== currentWork()) return;
    await saveCredential(pair);
    if (work !== currentWork()) return;
    batch(() => {
      setPairAwaitingApproval(false);
      if (pairAbortHandle() === abort) setPairAbort(null);
      clearPairingFragment();
      setPairCodeDraft("");
      setPairManualOpen(false);
      setPairFailure(null, null);
      setCredential(pair);
      setAddingComputer(false);
    });
    clearPairingTransport(abort);
    track("pwa_pairing_result", { result: "ok", extra: scanned ? "qr" : "manual" });
    await resumeComputer(pair);
  } catch (error) {
    if (!pairingErrorStillOwned(work, abort, page)) return;
    const code = error instanceof ProtocolError ? error.code : "";
    track("pwa_pairing_result", { result: code || "failed", extra: scanned ? "qr" : "manual" });
    if (code === "pairing_cancelled") {
      landCancelledPairing(abort, work);
      return;
    }
    setPairAwaitingApproval(false);
    // A subscriber may have started a replacement during that publication.
    if (pairAbortHandle() !== abort) return;
    const target = pairErrorField(code);
    const forget = shouldForgetPairFragment(code);
    // The abort release publishes as its own transaction: a subscriber reacting
    // to the released handle may start a new intent while the fragment is still
    // usable. Revalidate ownership across that boundary — the attempt
    // generation advances on every new intent (including one that failed local
    // validation or was cancelled back to a null handle), and the pairing phase
    // leaves when another connection takes the screen — so the old attempt no
    // longer owns the landing and must not clear the fragment, change the
    // phase, paint the error or focus over the replacement.
    batch(() => {
      clearPairingTransport(abort);
      setPairAbort(null);
    });
    if (pairingWorkId() !== work || phase() !== "pairing") return;
    batch(() => {
      if (forget) clearPairingFragment();
      setPairFailure(target, target === "code" ? "code" : reached);
      setPairManualOpen(true);
      setPhase("connect");
      showError(messageOf(error), true);
    });
    commitView();
    focusPairField(target, work);
  }
}

/**
 * First-pair returns to connect; add-computer returns to the catalog. The
 * cancelling abort is carried so a replacement attempt's handle is never
 * cleared, and the landing carries the attempt generation it continues: the
 * abort release (awaiting + handle) publishes as one transaction, then
 * ownership is revalidated once — the generation advances on every new intent
 * (even one that failed local validation or cancelled back to a null handle),
 * retirement or page ownership change, and the phase leaves "pairing" when
 * another connection owns the screen — and only then the UI landing (fragment,
 * phase, notice, catalog route) publishes as one transaction. A subscriber
 * that reacts to the released handle keeps its phase, handle and notice; the
 * old landing never clears or paints over it. cancelAddComputer joins the
 * landing batch so its publications are not observable mid-landing.
 */
function landCancelledPairing(abort: AbortController | null, work: number): void {
  if (pairAbortHandle() !== abort) return;
  const scanned = Boolean(pairingFragment());
  const addComputer = addingComputer() || computers().length || liveSession() !== null;
  batch(() => {
    setPairAwaitingApproval(false);
    if (abort) {
      clearPairingTransport(abort);
      setPairAbort(null);
    }
  });
  // Ownership across the abort-release publication: a subscriber reacting to
  // the released handle may have claimed a new intent, retired the work or
  // installed another connection. The old landing then retires without
  // touching the fragment, phase or notice the replacement owns.
  if (pairingWorkId() !== work || phase() !== "pairing") return;
  batch(() => {
    if (shouldForgetPairFragment("pairing_cancelled")) clearPairingFragment();
    if (addComputer) {
      cancelAddComputer();
      showStatus(t("err.pairing_cancelled"));
      return;
    }
    setPairFailure(null, null);
    setPairManualOpen(!scanned);
    setPhase("connect");
    showStatus(t("err.pairing_cancelled"));
  });
  commitView();
}

export function cancelPairing(): void {
  retirePairingWork();
  // Capture the cancelling attempt before any publication: an awaiting
  // subscriber or an abort listener can synchronously start a replacement.
  const abort = pairAbortHandle();
  setPairAwaitingApproval(false);
  abort?.abort();
  // Handshake may already have fulfilled (saveCredential in flight). Abort
  // cannot reject it; land now so the form is not stuck in pairing — but
  // only when the cancelling attempt still owns the screen.
  if (phase() !== "pairing" || pairAbortHandle() !== abort) return;
  landCancelledPairing(abort, currentWork());
}

/**
 * Transport disposal for a released pairing page. Only the handshake this page
 * started is aborted and cleared — a replacement attempt keeps its signal and
 * handle. Retired-page errors then fail `pairingErrorStillOwned` and cannot
 * paint or toast the replacement.
 */
export function disposePairingPageTransport(page: object): void {
  const abort = pairingTransportAbortFor(page);
  if (!abort) return;
  clearPairingTransport(abort);
  abort.abort();
  if (pairAbortHandle() === abort) setPairAbort(null);
}

export async function pastePairCode(): Promise<void> {
  const work = currentWork();
  try {
    const text = await navigator.clipboard.readText();
    if (work !== currentWork()) return;
    const both = parseCodeAndLocator(text);
    const code = both ? `${both.code.slice(0, 4)}-${both.code.slice(4)}-${both.loc}` : parsePairingCode(text);
    setPairManualOpen(true);
    if (!code) {
      setPairFailure("code", "code");
      showError(t("err.noClipboardCode"), true);
      commitView();
      focusPairField("code", work);
      return;
    }
    batch(() => {
      setPairCodeDraft(code);
      setPairFailure(null, null);
      clearNotice();
    });
    commitView();
    runIfCurrentWork(work, () => {
      appRoot().querySelector<HTMLButtonElement>(".btn-connect")?.focus();
    });
  } catch {
    if (work !== currentWork()) return;
    setPairManualOpen(true);
    showStatus(t("err.clipboardDenied"));
    commitView();
    focusPairField("code", work);
  }
}

export async function scanPairCode(): Promise<void> {
  const work = currentWork();
  try {
    const result = await scanPairingCode(location.origin);
    if (!result || work !== currentWork()) return;
    // Adopt the fragment and its draft as one publication. A subscriber to that
    // publication — cancel, back, or a replacement manual input — can retire
    // this scan before it claims a transport or overwrites the replacement's
    // draft; the generation is revalidated across that boundary.
    batch(() => {
      applyPairingFragment(result);
      setPairCodeDraft(result.code);
      setPairManualOpen(false);
    });
    if (work !== currentWork()) return;
    await beginPairing(result.code);
  } catch (error) {
    if (work !== currentWork()) return;
    setPairManualOpen(true);
    showError(error instanceof PairingScanError ? error.message : t("err.scanFailed"));
    commitView();
    focusPairField("code", work);
  }
}

export function focusPairCode(): void {
  focusPairField("code", currentWork());
}

/** Published snapshots the connect form projects; callers subscribe first. */
export type ConnectPageSnapshots = {
  connection: DomainView<ConnectionRecord>;
  computers: DomainView<ComputersRecord, "live">;
  pairing: DomainView<PairingRecord, "pairAbort">;
};

/**
 * Live inputs the connect page projects. The values come from the page's
 * subscribed domain snapshots, so a staged composition hold keeps the form on
 * the same published phase as its frame; action-time canonical readers stay
 * with the click/async handlers, never with JSX.
 */
export function connectPageInput(desk: boolean, notice: ConnectNotice | null, snapshots: ConnectPageSnapshots): ConnectViewInput {
  const { connection, computers: computersSnapshot, pairing } = snapshots;
  return {
    phase: connection.phase,
    addingComputer: computersSnapshot.addingComputer,
    computerCount: computersSnapshot.computers.length,
    fragment: connection.fragment,
    pairCodeDraft: pairing.pairCodeDraft,
    pairManualOpen: pairing.pairManualOpen,
    pairErrorTarget: pairing.pairErrorTarget,
    pairFailedStep: pairing.pairFailedStep,
    pairAwaitingApproval: pairing.pairAwaitingApproval,
    notice,
    desk,
  };
}
