import type { QuotaPanelModel } from "./model";
import { QuotaCardView } from "./quota-card-view";

/** The full quota list. Pure: the caller decided which session's snapshot this is. */
export function QuotaPanelView({ panel }: { panel: QuotaPanelModel }) {
  return (
    <section className="quota-panel" aria-busy={panel.busy}>
      {panel.error ? <p className="set-note">{panel.error}</p> : null}
      {panel.offline ? <p className="set-note">{panel.offlineCopy}</p> : null}
      {panel.cards.map(card => <QuotaCardView key={card.provider} card={card} />)}
    </section>
  );
}
