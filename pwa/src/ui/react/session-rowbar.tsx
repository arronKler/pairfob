import { t } from "../../lib/i18n";
import { closeRow, copyRow, quoteRow, rowBarContent } from "../session/rowbar";
import { paneModel } from "../session/model";
import { toggleTermSelect } from "../session/term";
import { Button } from "./chrome";

/**
 * Contextual copy/quote bar for `state.paneRow`.
 *
 * DOM: `.row-bar[role=group] > .row-quote + .row-actions > .row-act`. Empty
 * rows are discarded by `discardEmptyPaneRow` in a controller, never during
 * render. Returns null when there is no copyable row.
 */
export function SessionRowBar() {
  const content = rowBarContent(paneModel());
  if (!content) return null;
  const { text, path } = content;
  return (
    <div className="row-bar" role="group" aria-label={t("row.aria")} data-react-session-rowbar="">
      <p className="row-quote">{text}</p>
      <div className="row-actions">
        <Button className="row-act" onClick={() => void copyRow(text, t("row.copiedLine"))}>{t("row.copyLine")}</Button>
        {path ? (
          <Button className="row-act" onClick={() => void copyRow(path, t("row.copiedPath"))}>{t("row.copyPath", { path })}</Button>
        ) : null}
        <Button className="row-act" onClick={() => quoteRow(text)}>{t("row.quote")}</Button>
        <Button className="row-act" onClick={() => toggleTermSelect(true)}>{t("menu.selectText")}</Button>
        <Button className="row-act row-act-ghost" onClick={closeRow}>{t("close")}</Button>
      </div>
    </div>
  );
}
