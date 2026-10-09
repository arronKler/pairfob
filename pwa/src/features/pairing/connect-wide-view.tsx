import { BackBar, Brand } from "../../shared/ui/primitives";
import { PairCodeSheet } from "./code-sheet";
import { CodeCard, ConnectHeading, ConnectSteps, PhoneNote, ScanActions, type ConnectViewProps } from "./connect-stage";
import { TerminalMiniature } from "./terminal-miniature";

/**
 * The connect page with room for two columns: what to do on the computer on the
 * left, the way in on the right. Every stage keeps both columns and only swaps
 * copy and the control under the field, as the phone page does.
 *
 * The right column follows the pointer, not the width. A mouse sits at the
 * screen the QR would be on, so there the code field is the page's main control
 * and nothing offers a camera. A touch screen (a landscape tablet) keeps the
 * scan, with the typed code behind it in the sheet.
 */
export function ConnectWideView({
  view, language, onBack, onCancel, onScan, onOpenCode, onCloseCode, onInstall, onPaste, onSubmit, onCodeChange,
}: ConnectViewProps) {
  const typed = view.entry === "code";
  return (
    <div className={`page connect-page is-wide is-${view.stage}`} aria-busy={view.busy}>
      {view.adding
        ? <BackBar title={view.backTitle} onBack={onBack} />
        : <div className="topbar connect-top">{language}</div>}
      <div className="connect-wide">
        <div className="connect-intro">
          {view.adding ? null : <Brand />}
          <ConnectHeading view={view} />
          <ConnectSteps view={view} onInstall={onInstall} />
          {typed ? <PhoneNote /> : null}
        </div>
        {typed
          ? <CodeCard view={view} onCancel={onCancel} onSubmit={onSubmit} onCodeChange={onCodeChange} />
          : <div className="connect-side">
              <TerminalMiniature stage={view.stage} />
              <ScanActions view={view} onCancel={onCancel} onScan={onScan} onOpenCode={onOpenCode} />
            </div>}
      </div>
      {view.sheetOpen
        ? <PairCodeSheet view={view} onDismiss={onCloseCode} onPaste={onPaste} onSubmit={onSubmit} onCodeChange={onCodeChange} />
        : null}
    </div>
  );
}
