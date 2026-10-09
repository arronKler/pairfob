import { BackBar, Brand } from "../../shared/ui/primitives";
import { CodeCard, ConnectHeading, ConnectSteps, PhoneNote, type ConnectViewProps } from "./connect-stage";

/**
 * The connect page for a mouse in a window too narrow for two columns: the wide
 * page's left and right stacked into one. The steps come first and the code
 * card under them is the page's one primary control; there is no scan and no
 * sheet, because the QR would be on this very screen. Every stage keeps the
 * same stack and only swaps copy and the control under the field.
 */
export function ConnectTypedView({ view, language, onBack, onCancel, onInstall, onSubmit, onCodeChange }: ConnectViewProps) {
  return (
    <div className={`page connect-page is-stacked is-${view.stage}`} aria-busy={view.busy}>
      {view.adding
        ? <BackBar title={view.backTitle} onBack={onBack} />
        : <div className="topbar connect-top"><Brand />{language}</div>}
      <ConnectHeading view={view} />
      <ConnectSteps view={view} onInstall={onInstall} />
      <CodeCard view={view} onCancel={onCancel} onSubmit={onSubmit} onCodeChange={onCodeChange} />
      <PhoneNote />
    </div>
  );
}
