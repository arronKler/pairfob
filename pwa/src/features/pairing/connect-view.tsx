import type { FormEvent, ReactNode, RefObject } from "react";
import { t } from "../../lib/i18n";
import { PAIR_CODE_WITH_LOCATOR_PATTERN } from "../../lib/pairing-input";
import { BackBar, Brand, Button, Feedback } from "../../shared/ui/primitives";
import type { ConnectNotice, ConnectViewModel } from "./model";

/**
 * Connect/pairing form. Pure: copy and flags arrive in the view model, mutations
 * are callbacks, and the language control / visible notice are slots the page
 * still owns.
 */
export function ConnectView({
  view, notice, language, formRef, onBack, onCancel, onScan, onPaste, onSubmit, onToggleManual, onCodeChange,
}: {
  view: ConnectViewModel;
  notice: ConnectNotice | null;
  language: ReactNode;
  formRef: RefObject<HTMLFormElement | null>;
  onBack: () => void;
  onCancel: () => void;
  onScan: () => void;
  onPaste: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggleManual: (open: boolean) => void;
  onCodeChange: (code: string) => void;
}) {
  const fieldError = view.pairCodeInvalid ? notice : null;
  return (
    <div className={view.pageClass}>
      {view.adding ? (
        <BackBar title={view.backTitle} onBack={onBack}>{language}</BackBar>
      ) : (
        <><Brand /><h1 className="prelude-title">{view.title}</h1></>
      )}
      <p className="lede">{view.lede}</p>
      {view.deskHint ? <p className="desk-hint" role="note">{view.deskHint}</p> : null}
      {view.qrNote ? <p className="qr-note">{view.qrNote}</p> : null}
      {view.showGlobalNotice && notice ? <Feedback value={notice} appNotice /> : null}
      <form ref={formRef} className="connect-form" noValidate aria-busy={view.busy}
        onSubmit={view.busy ? undefined : onSubmit}>
        {view.busy ? (
          <>
            <div className="pair-wait">
              <p className="pair-wait-title">{view.waitTitle}</p>
              <p className="pair-wait-copy">{view.waitCopy}</p>
              <PairRail view={view} failure={null} />
            </div>
            <Button className="btn btn-ghost" onClick={onCancel}>{t("cancel")}</Button>
          </>
        ) : (
          <>
            {view.showFailedRail ? <PairRail view={view} failure={view.railNote} /> : null}
            <Button className="btn-scan" onClick={onScan}>{t("connect.scan")}</Button>
            <details className="manual-pair" open={view.manualOpen} onToggle={event => {
              onToggleManual(event.currentTarget.open);
            }}>
              <summary className="manual-pair-summary">{t("connect.manualSummary")}</summary>
              <div className="manual-pair-body">
                <label className="field" htmlFor="pair-code">
                  <div className="field-head">
                    <span className="field-label">{t("connect.pairCode")}</span>
                    <span className={`field-count${view.pairCodeComplete ? " ok" : ""}`} hidden={!view.pairCodeLength}>
                      {view.pairCodeLength ? `${view.pairCodeLength}/14` : ""}
                    </span>
                  </div>
                  <input id="pair-code" name="code" type="text" autoComplete="one-time-code" spellCheck={false}
                    autoCapitalize="characters" autoCorrect="off" inputMode="text" placeholder={t("connect.pairHint")}
                    value={view.pairCodeDraft} disabled={false} maxLength={20} required
                    pattern={PAIR_CODE_WITH_LOCATOR_PATTERN} title={t("connect.pairTitle")}
                    aria-invalid={fieldError ? "true" : undefined}
                    aria-describedby={fieldError ? "pair-feedback" : undefined}
                    onChange={event => onCodeChange(event.currentTarget.value)} />
                  {fieldError ? <Feedback value={fieldError} id="pair-feedback" appNotice /> : null}
                </label>
                <Button className="btn-paste" onClick={onPaste}>{t("connect.paste")}</Button>
                <Button type="submit" className="btn btn-primary btn-connect">{t("connect.submit")}</Button>
              </div>
            </details>
          </>
        )}
      </form>
      <p className="trust">{t("connect.trust")}</p>
      {!view.adding ? language : null}
    </div>
  );
}

function PairRail({ view, failure }: { view: ConnectViewModel; failure: string | null }) {
  return (
    <ol className="pair-rail" aria-label={t("pair.step.railAria")}>
      {view.rail.map(step => (
        <li key={step.key} className={`pair-step is-${step.state}`}
          aria-current={step.state === "active" ? "step" : undefined}>
          <span className="pair-dot" /><span className="pair-step-label">{t(`pair.step.${step.key}`)}</span>
          <span className="sr-only">{t(`pair.state.${step.state}`)}</span>
          {step.state === "failed" && failure ? <p className="pair-step-note">{failure}</p> : null}
        </li>
      ))}
    </ol>
  );
}
