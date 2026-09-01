import { t } from "./lib/i18n";
import { fragmentUsableOnOrigin, resolveHandPairing } from "./lib/pairing-input";
import { normalizeCrockford } from "./lib/protocol/bytes";
import { requestPairIntent } from "./lib/pair-intent";
import { pairOverWS, ProtocolError, type PairInput } from "./lib/protocol/client";
import { cancelAddComputer, resumeComputer } from "./computers";
import { saveCredential } from "./lib/credentials";
import { friendlyDeviceLabel, pairErrorField, shouldForgetPairFragment, type PairErrorField } from "./lib/ui-model";
import { render } from "./paint";
import { FRIENDLY_ERROR, app, clearNotice, messageOf, showError, showStatus, state, wsURL } from "./state";
import { track } from "./lib/telemetry";

function rejectLocal(target: PairErrorField, text: string): void {
  state.phase = "connect";
  state.pairManualOpen = true;
  state.pairErrorTarget = target;
  showError(text, true);
  render();
  queueMicrotask(() => (app.querySelector(`[name="${target}"]`) as HTMLInputElement | null)?.focus());
}

/** Reject a v=1 fragment on a protocol=2 origin (and vice versa) as an expired code. */
export function applyOriginPairingPolicy(): boolean {
  const fragment = state.fragment;
  if (!fragment || fragmentUsableOnOrigin(fragment, state.originProtocol)) return false;
  state.fragment = null;
  state.pairCodeDraft = "";
  rejectLocal("code", FRIENDLY_ERROR.unpaired);
  return true;
}

export async function onPairSubmit(event: Event): Promise<void> {
  event.preventDefault();
  const data = new FormData(event.target as HTMLFormElement);
  await beginPairing(String(data.get("code") || ""));
}

export async function beginPairing(rawCode: string): Promise<void> {
  if (state.phase === "pairing") return;
  const scanned = state.fragment;
  state.pairCodeDraft = rawCode;
  state.pairErrorTarget = null;

  if (scanned && !fragmentUsableOnOrigin(scanned, state.originProtocol)) {
    state.fragment = null;
    rejectLocal("code", FRIENDLY_ERROR.unpaired);
    return;
  }

  const resolved = resolveHandPairing(2, rawCode, Boolean(scanned));
  if (!resolved.ok) {
    const length = normalizeCrockford(rawCode).length;
    rejectLocal("code", rawCode ? t("err.pairIncomplete", { n: length }) : FRIENDLY_ERROR.locator_required);
    return;
  }
  state.pairAbort?.abort();
  state.pairAbort = new AbortController();
  const abort = state.pairAbort;
  state.pairAwaitingApproval = false;
  state.phase = "pairing";
  clearNotice();
  track("pwa_pairing_start", { extra: scanned ? "qr" : "manual" });
  render();
  try {
    let relay = wsURL();
    let attach: PairInput = scanned ? { pair_ref: scanned.pairRef } : {};
    if (scanned?.daemonId) {
      relay = wsURL({ daemonId: scanned.daemonId });
      attach = { pair_ref: scanned.pairRef };
    } else {
      const intent = await requestPairIntent(resolved.loc!, fetch, abort.signal);
      if (abort.signal.aborted) throw new ProtocolError("pairing_cancelled", t("err.pairing_cancelled"));
      relay = wsURL({ daemonId: intent.daemonId, pairTicket: intent.pairTicket });
      attach = { pair_ref: intent.pairRef };
    }
    const pair = await pairOverWS(relay, attach, resolved.code, {
      protocol: state.originProtocol,
      expectedDaemonId: scanned?.daemonId,
      expectedFingerprint: scanned?.fingerprint,
      label: friendlyDeviceLabel(navigator.userAgent),
      onAwaitApproval: () => {
        state.pairAwaitingApproval = true;
        showStatus(t("pair.verified"), true);
        render();
      },
      signal: abort.signal,
    });
    state.pairAwaitingApproval = false;
    if (state.pairAbort === abort) state.pairAbort = null;
    state.fragment = null;
    state.pairCodeDraft = "";
    state.pairManualOpen = false;
    state.pairErrorTarget = null;
    await saveCredential(pair);
    state.credential = pair;
    state.addingComputer = false;
    track("pwa_pairing_result", { result: "ok", extra: scanned ? "qr" : "manual" });
    await resumeComputer(pair);
  } catch (error) {
    state.pairAwaitingApproval = false;
    if (state.pairAbort === abort) state.pairAbort = null;
    const code = error instanceof ProtocolError ? error.code : "";
    track("pwa_pairing_result", { result: code || "failed", extra: scanned ? "qr" : "manual" });
    if (shouldForgetPairFragment(code)) state.fragment = null;
    if (code === "pairing_cancelled" && (state.addingComputer || state.computers.length || state.live)) {
      cancelAddComputer();
      showStatus(messageOf(error));
      render();
      return;
    }
    state.pairErrorTarget = pairErrorField(code);
    state.pairManualOpen = code === "pairing_cancelled" ? !scanned : true;
    state.phase = "connect";
    if (code === "pairing_cancelled") showStatus(messageOf(error));
    else showError(messageOf(error), true);
    render();
    if (state.pairErrorTarget) {
      queueMicrotask(() => (app.querySelector(`[name="${state.pairErrorTarget}"]`) as HTMLInputElement | null)?.focus());
    }
  }
}

export function cancelPairing(): void {
  state.pairAwaitingApproval = false;
  state.pairAbort?.abort();
}
