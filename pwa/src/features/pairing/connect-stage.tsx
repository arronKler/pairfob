import { Lock, ScanLine } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { t } from "../../lib/i18n";
import { Button, Spinner } from "../../shared/ui/primitives";
import { PairCodeField } from "./code-field";
import { pastedPairCode, type ConnectViewModel } from "./model";
import { PairCommand } from "./pair-command";
import { keepPhrases } from "./phrases";

/**
 * What the connect layouts show for the current stage: the title and lede, the
 * two steps, and the way in — the scan actions, or the code card where the code
 * is typed on the page — with the trust line. The layouts only place them.
 */

/** The view model, the page's language slot and the mutations, whatever the layout. */
export type ConnectViewProps = {
  view: ConnectViewModel;
  language: ReactNode;
  onBack: () => void;
  onCancel: () => void;
  onScan: () => void;
  onOpenCode: () => void;
  onCloseCode: () => void;
  onInstall: () => void;
  onPaste: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCodeChange: (code: string) => void;
};

/** Title + lede. `children` follow the lede inline (the phone's install link). */
export function ConnectHeading({ view, children }: { view: ConnectViewModel; children?: ReactNode }) {
  return (
    <div className="connect-copy">
      <h1 className="connect-title">{view.stage === "connecting" ? <Spinner className="connect-spinner" /> : null}{view.title}</h1>
      <p className={`connect-lede is-${view.ledeTone}`} aria-live="polite">
        <Lede view={view} />
        {children}
      </p>
    </div>
  );
}

/** The approval lede names the Enter key as a keycap. */
function Lede({ view }: { view: ConnectViewModel }) {
  if (!view.ledeKeycap) return <>{keepPhrases(view.lede)}</>;
  const [before, after = ""] = view.lede.split("{key}").map(keepPhrases);
  return <>{before}<kbd className="connect-key">⏎ Enter</kbd>{after}</>;
}

export function TrustLine() {
  return <p className="trust"><Lock size={11} aria-hidden="true" />{t("connect.trust")}</p>;
}

/** Scan first, the typed code second; a running handshake leaves only Cancel. */
export function ScanActions({ view, onCancel, onScan, onOpenCode }: {
  view: ConnectViewModel;
  onCancel: () => void;
  onScan: () => void;
  onOpenCode: () => void;
}) {
  return (
    <div className="connect-actions">
      {view.busy
        ? <Button className="btn connect-cancel" onClick={onCancel}>{t("cancel")}</Button>
        : <>
          <Button className="btn btn-primary connect-scan" onClick={onScan}><ScanLine size={18} aria-hidden="true" />{t("connect.scan")}</Button>
          <Button className="btn btn-ghost connect-manual" onClick={onOpenCode}>{t("connect.manual")}</Button>
        </>}
      <TrustLine />
    </div>
  );
}

/** The typed layouts' aside for the reader who wanted the phone. */
export function PhoneNote() {
  return <p className="connect-phone-note">{keepPhrases(t("connect.phoneNote"))}</p>;
}

/**
 * What to do on the computer, then how to get in from here. The second step
 * says where the typed code goes on this layout: beside the steps, or under them.
 */
export function ConnectSteps({ view, onInstall }: { view: ConnectViewModel; onInstall: () => void }) {
  const step2 = view.entry === "scan" ? "connect.step2Scan" : view.layout === "wide" ? "connect.step2Code" : "connect.step2CodeBelow";
  return (
    <ol className="connect-steps" aria-label={t("connect.stepsAria")}>
      <li className="connect-step">
        <span className="connect-step-n" aria-hidden="true">1</span>
        <div className="connect-step-body">
          <b>{t("connect.step1")}</b>
          <PairCommand />
        </div>
      </li>
      <li className="connect-step">
        <span className="connect-step-n" aria-hidden="true">2</span>
        <div className="connect-step-body">
          <b>{t(step2)}</b>
          <p className="connect-step-note">
            {t("connect.install")} <button type="button" className="connect-install" onClick={onInstall}>{t("connect.installLink")}</button>
          </p>
        </div>
      </li>
    </ol>
  );
}

/**
 * The typed code as the page's own control: the field, Connect (Cancel while a
 * handshake runs, with the code it is using shown read-only) and the trust line.
 */
export function CodeCard({ view, onCancel, onSubmit, onCodeChange }: {
  view: ConnectViewModel;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCodeChange: (code: string) => void;
}) {
  return (
    <form className="connect-card connect-form" noValidate onSubmit={onSubmit}>
      <PairCodeField view={view} placeholder={t("connect.pairPlaceholder")} readOnly={view.busy} onCodeChange={onCodeChange}
        onPasteText={(text) => {
          const code = pastedPairCode(text);
          if (code) onCodeChange(code);
          return code !== null;
        }} />
      {/* Keyed apart: a reused node would hand the held Enter that submitted straight to Cancel. */}
      {view.busy
        ? <Button key="cancel" className="btn connect-cancel" onClick={onCancel}>{t("cancel")}</Button>
        : <Button key="submit" type="submit" className="btn btn-primary btn-connect">{t("connect.submit")}</Button>}
      <TrustLine />
    </form>
  );
}
