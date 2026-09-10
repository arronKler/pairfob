import { Fragment } from "react";
import type { QuotaCardModel } from "./model";

/**
 * One provider's quota card. Pure: the model already resolved every string, the
 * stale adjustment and which notes apply, so this only lays them out.
 */
export function QuotaCardView({ card }: { card: QuotaCardModel }) {
  return (
    <div className="set-card quota-card">
      <div className="set-row">
        <strong className="set-key">{card.title}</strong>
        <span className="set-value">{card.plan}</span>
      </div>
      <div className="set-row set-row-stack">
        <p className="set-note">{card.statusCopy}</p>
        {card.windows.map(window => window.kind === "unlimited" ? (
          <span key={window.key} className="quota-window-label">{window.labelText}</span>
        ) : (
          <Fragment key={window.key}>
            <span className="quota-window-label">{window.labelText}</span>
            {window.showWindowName ? <small className="set-note">{window.windowName}</small> : null}
            <progress className="quota-progress" max={100} value={window.remaining} aria-label={window.progressAria} />
            <small className="set-note">{window.resetCopy}</small>
          </Fragment>
        ))}
        {card.help ? <p className="set-note">{card.help}</p> : null}
        {card.helpDetail ? <p className="set-note">{card.helpDetail}</p> : null}
        {card.helpCommand ? <code className="quota-command">{card.helpCommand}</code> : null}
        {card.observed ? <small className="set-note">{card.observed}</small> : null}
        {card.notes.map((note, index) => <p key={index} className="set-note">{note}</p>)}
        {card.command ? <code className="quota-command">{card.command}</code> : null}
      </div>
    </div>
  );
}
