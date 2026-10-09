import { t } from "../../lib/i18n";
import { BackBar, Brand } from "../../shared/ui/primitives";
import { PairCodeSheet } from "./code-sheet";
import { ConnectHeading, ScanActions, type ConnectViewProps } from "./connect-stage";
import { ConnectTypedView } from "./connect-typed-view";
import { ConnectWideView } from "./connect-wide-view";
import { TerminalMiniature } from "./terminal-miniature";

/**
 * Connect/pairing screen. Pure: copy and flags arrive in the view model,
 * mutations are callbacks, and the language control is a slot the page owns.
 *
 * The phone page is four fixed regions — top bar, terminal miniature, title +
 * lede, bottom actions — so idle, connecting, approval and failure change
 * content in place and never move the layout. Typing the code happens in
 * `PairCodeSheet`. A wide viewport gets `ConnectWideView` instead, and a mouse
 * in a narrow window gets `ConnectTypedView`: it has nothing to scan with.
 */
export function ConnectView(props: ConnectViewProps) {
  if (props.view.layout === "wide") return <ConnectWideView {...props} />;
  if (props.view.entry === "code") return <ConnectTypedView {...props} />;
  const { view, language, onBack, onCancel, onScan, onOpenCode, onCloseCode, onInstall, onPaste, onSubmit, onCodeChange } = props;
  return (
    <div className={`page connect-page is-${view.stage}`} aria-busy={view.busy}>
      {view.adding
        ? <BackBar title={view.backTitle} onBack={onBack} />
        : <div className="topbar connect-top"><Brand />{language}</div>}
      <TerminalMiniature stage={view.stage} />
      <ConnectHeading view={view}>
        {view.showInstall ? <> <button type="button" className="connect-install" onClick={onInstall}>{t("connect.install")}</button></> : null}
      </ConnectHeading>
      <ScanActions view={view} onCancel={onCancel} onScan={onScan} onOpenCode={onOpenCode} />
      {view.sheetOpen
        ? <PairCodeSheet view={view} onDismiss={onCloseCode} onPaste={onPaste} onSubmit={onSubmit} onCodeChange={onCodeChange} />
        : null}
    </div>
  );
}
