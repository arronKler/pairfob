import { useLayoutEffect, useReducer, useRef } from "react";
import { cancelAddComputer } from "../../computers";
import { t } from "../../lib/i18n";
import { PAIR_CODE_WITH_LOCATOR_PATTERN, parseCodeAndLocator, parsePairingCode } from "../../lib/pairing-input";
import { PairingScanError, scanPairingCode } from "../../lib/pairing-scanner";
import { normalizeCrockford } from "../../lib/protocol/bytes";
import { pairProgress } from "../../lib/ui-model";
import { beginPairing, cancelPairing, onPairSubmit } from "../../pairing";
import { render } from "../../paint";
import { app, clearNotice, showError, showStatus, state } from "../../state";
import { isDesk } from "../../viewport";
import { BackBar, Brand, Button, Feedback, LanguageSelect, useAppNotice } from "./chrome";

function focusPairCode(): void {
  queueMicrotask(() => app.querySelector<HTMLInputElement>("#pair-code")?.focus({ preventScroll: true }));
}

async function pasteFromClipboard(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    const both = parseCodeAndLocator(text);
    const code = both ? `${both.code.slice(0, 4)}-${both.code.slice(4)}-${both.loc}` : parsePairingCode(text);
    state.pairManualOpen = true;
    if (!code) {
      state.pairErrorTarget = "code";
      showError(t("err.noClipboardCode"), true);
      render();
      focusPairCode();
      return;
    }
    state.pairCodeDraft = code;
    state.pairErrorTarget = null;
    clearNotice();
    render();
    app.querySelector<HTMLButtonElement>(".btn-connect")?.focus();
  } catch {
    state.pairManualOpen = true;
    showStatus(t("err.clipboardDenied"));
    render();
    focusPairCode();
  }
}

async function scan(): Promise<void> {
  try {
    const result = await scanPairingCode(location.origin);
    if (!result) return;
    state.fragment = result;
    state.pairCodeDraft = result.code;
    state.pairManualOpen = false;
    await beginPairing(result.code);
  } catch (error) {
    state.pairManualOpen = true;
    showError(error instanceof PairingScanError ? error.message : t("err.scanFailed"));
    render();
    focusPairCode();
  }
}

function PairRail({ failure }: { failure: string | null }) {
  return <ol className="pair-rail" aria-label={t("pair.step.railAria")}>
    {pairProgress({ pairing: state.phase === "pairing", awaitingApproval: state.pairAwaitingApproval,
      failedStep: state.pairFailedStep }).map(step => <li key={step.key} className={`pair-step is-${step.state}`}
      aria-current={step.state === "active" ? "step" : undefined}>
      <span className="pair-dot" /><span className="pair-step-label">{t(`pair.step.${step.key}`)}</span>
      <span className="sr-only">{t(`pair.state.${step.state}`)}</span>
      {step.state === "failed" && failure && <p className="pair-step-note">{failure}</p>}
    </li>)}
  </ol>;
}

function PairField() {
  const [, updateDraft] = useReducer(value => value + 1, 0);
  const length = normalizeCrockford(state.pairCodeDraft).length;
  const notice = useAppNotice();
  const error = state.pairErrorTarget === "code" ? notice : null;
  return <label className="field" htmlFor="pair-code">
    <div className="field-head"><span className="field-label">{t("connect.pairCode")}</span>
      <span className={`field-count${length === 14 ? " ok" : ""}`} hidden={!length}>{length ? `${length}/14` : ""}</span>
    </div>
    <input id="pair-code" name="code" type="text" autoComplete="one-time-code" spellCheck={false}
      autoCapitalize="characters" autoCorrect="off" inputMode="text" placeholder={t("connect.pairHint")}
      value={state.pairCodeDraft} disabled={false} maxLength={20} required pattern={PAIR_CODE_WITH_LOCATOR_PATTERN}
      title={t("connect.pairTitle")} aria-invalid={error ? "true" : undefined} aria-describedby={error ? "pair-feedback" : undefined}
      onChange={event => { state.pairCodeDraft = event.currentTarget.value; updateDraft(); }} />
    {error && <Feedback value={error} id="pair-feedback" appNotice />}
  </label>;
}

function ConnectLanguage() {
  return <div className="connect-lang"><LanguageSelect /></div>;
}

export function ConnectScreen() {
  const form = useRef<HTMLFormElement>(null);
  const busy = state.phase === "pairing";
  const scanned = state.fragment;
  const adding = state.addingComputer || state.computers.length > 0;
  const manualOpen = state.pairManualOpen || state.pairErrorTarget === "code";
  const notice = useAppNotice();
  const railFailure = state.pairFailedStep && state.pairFailedStep !== "code" ? notice : null;
  const railNote = railFailure?.tone === "error" ? railFailure.text : null;
  useLayoutEffect(() => {
    if (busy) return;
    if (manualOpen) form.current?.querySelector<HTMLInputElement>("#pair-code")?.focus({ preventScroll: true });
    else if (isDesk()) form.current?.querySelector<HTMLButtonElement>(".btn-scan")?.focus({ preventScroll: true });
  }, [busy, manualOpen]);

  return <div className={adding ? "page settings-page" : `prelude${busy ? " pairing" : ""}`}>
    {adding ? <BackBar title={state.addingComputer ? t("settings.addComputer") : t("connect.pair")} onBack={cancelAddComputer}>
      <ConnectLanguage />
    </BackBar> : <><Brand /><h1 className="prelude-title">{t("connect.title")}</h1></>}
    <p className="lede">{scanned ? t("connect.ledeScanned") : state.addingComputer ? t("connect.ledeAdd") : t("connect.ledeScan")}</p>
    {isDesk() && !adding && !scanned && !busy && <p className="desk-hint" role="note">{t("connect.deskHint")}</p>}
    {scanned && <p className="qr-note">{t("connect.qrNote")}</p>}
    {!state.pairErrorTarget && !railNote && notice && <Feedback value={notice} appNotice />}
    <form ref={form} className="connect-form" noValidate aria-busy={busy}
      onSubmit={busy ? undefined : event => { void onPairSubmit(event.nativeEvent); }}>
      {busy ? <>
        <div className="pair-wait">
          <p className="pair-wait-title">{state.pairAwaitingApproval ? t("connect.waitEnter") : t("connect.waitTitle")}</p>
          <p className="pair-wait-copy">{state.pairAwaitingApproval ? t("connect.waitEnterCopy") : t("connect.waitCopy")}</p>
          <PairRail failure={null} />
        </div>
        <Button className="btn btn-ghost" onClick={cancelPairing}>{t("cancel")}</Button>
      </> : <>
        {state.pairFailedStep && <PairRail failure={railNote} />}
        <Button className="btn-scan" onClick={() => void scan()}>{t("connect.scan")}</Button>
        <details className="manual-pair" open={manualOpen} onToggle={event => {
          state.pairManualOpen = event.currentTarget.open;
          if (event.currentTarget.open) focusPairCode();
        }}>
          <summary className="manual-pair-summary">{t("connect.manualSummary")}</summary>
          <div className="manual-pair-body">
            <PairField /><Button className="btn-paste" onClick={() => void pasteFromClipboard()}>{t("connect.paste")}</Button>
            <Button type="submit" className="btn btn-primary btn-connect">{t("connect.submit")}</Button>
          </div>
        </details>
      </>}
    </form>
    <p className="trust">{t("connect.trust")}</p>
    {!adding && <ConnectLanguage />}
  </div>;
}
