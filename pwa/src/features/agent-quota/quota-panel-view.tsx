import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { useArrivals } from "./arrivals";
import type { QuotaPanelModel } from "./model";
import { QuotaCardView } from "./quota-card-view";
import { QuotaAttentionGroup, QuotaOthersGroup } from "./quota-notice-view";

/**
 * The full quota page body, in the order of what the reader has to do about
 * it: accounts that need them, accounts with numbers, then what this computer
 * has no login for. Pure: the caller decided which session's snapshot this is,
 * and where "update" leads.
 */
export function QuotaPanelView({ panel, onUpdate }: { panel: QuotaPanelModel; onUpdate?: () => void }) {
  // A card that joins the page after it was drawn has just been read.
  const arrivals = useArrivals(panel.cards, card => card.id);
  return (
    <section className="quota-panel" aria-busy={panel.busy}>
      <p className="quota-lede">{t("quota.note")}</p>
      {panel.error ? <p className="quota-lede is-error">{panel.error}</p> : null}
      {panel.offline ? <p className="quota-lede">{panel.offlineCopy}</p> : null}
      {panel.legacy ? <p className="quota-lede quota-legacy">{t("quota.legacyNote")}
        {onUpdate ? <Button className="set-action" onClick={onUpdate}>{t("quota.legacyUpdate")}</Button> : null}</p> : null}
      {panel.unknown ? <p className="quota-lede">{t("quota.unknownCount", { n: panel.unknown })}</p> : null}
      {panel.attention.length ? <QuotaAttentionGroup notices={panel.attention} /> : null}
      {arrivals.length ? <>
        <h2 className="set-group-label quota-cards-label"><span>{`${t("quota.group.accounts")} · ${arrivals.length}`}</span>
          {panel.busy || panel.updated ? <span className="set-group-aside" role={panel.busy ? "status" : undefined}>{panel.busy ? t("quota.readingMore") : panel.updated}</span> : null}</h2>
        <div className="quota-cards">
          {arrivals.map(({ item: card, arrive }) => <QuotaCardView key={card.id} card={card} arrive={arrive} />)}
        </div>
      </> : null}
      {panel.pending ? null : <QuotaOthersGroup notices={panel.others} />}
    </section>
  );
}
