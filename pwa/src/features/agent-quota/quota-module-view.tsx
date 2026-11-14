import { t } from "../../lib/i18n";
import { SetGroup, SetItem, SetNavItem } from "../../shared/ui/primitives";
import type { QuotaModuleModel } from "./model";
import { useArrivals } from "./arrivals";
import { QuotaMeter } from "./quota-meter";

/**
 * The settings quota module: a few accounts, each with the meter that stands
 * for it, then a row into the full page that says how many there are and how
 * many need the reader. Offline and failed reads are one line, never a strip
 * of empty meters.
 */
export function QuotaModuleView({ model, onOpen }: { model: QuotaModuleModel; onOpen: (id?: string) => void }) {
  // A row that joins a module already on screen has just been read: it fades in
  // over the loading row and its bar grows. Rows drawn with the module stand still.
  const rows = useArrivals(model.rows, row => row.id);
  const all = <SetNavItem className="quota-all" label={t("quota.allRow")} onClick={() => onOpen()}
    value={model.total || model.attention ? <>
      {model.total ? t(model.incomplete ? "quota.moduleLoaded" : "quota.moduleTotal", { n: model.total }) : null}
      {model.total && model.attention ? " · " : null}
      {model.attention ? <span className="quota-attention-count">{t("quota.moduleAttention", { n: model.attention })}</span> : null}
    </> : undefined} />;
  return <SetGroup className="quota-module" label={t("quota.title")} aside={model.updated}>
    {model.state === "offline" ? <SetItem className="is-quiet" label={t("quota.offline")} />
      : model.state === "error" ? <><SetItem className="is-quiet" label={t("quota.failed")} />{all}</>
      : model.state === "loading" ? [0, 1, 2].map(index => <SetItem key={index} className="is-skeleton" label={<span className="skel" />}
          sub={<span className="skel skel-short" />} trailing={<span className="quota-meter is-empty"><span className="quota-bar" /></span>} />)
      : <>
          {rows.map(({ item: row, arrive }) => <SetNavItem key={row.id} className={`quota-row${arrive === undefined ? "" : " is-arriving"}`}
            chevron={false} label={row.name} sub={row.sub}
            value={<QuotaMeter meter={row.meter} arrive={arrive} />} onClick={() => onOpen(row.id)} />)}
          {all}
        </>}
  </SetGroup>;
}
