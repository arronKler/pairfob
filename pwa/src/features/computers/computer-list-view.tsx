import { Monitor, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { t } from "../../lib/i18n";
import { BackBar, Brand, Button, SelectionRow, SetAction, SetGroup, SetItem, SetTag, Spinner, TopbarActions } from "../../shared/ui/primitives";
import { keepPhrases } from "../../lib/keep-phrases";
import type { ComputersViewModel } from "./model";

/**
 * The computer picker list. Pure: every string and the back target arrive in the
 * view model, mutations are callbacks the caller owns, and chrome the page still
 * hosts (`AppNotice`, daemon-update help) arrives as slots.
 *
 * The add hint names a command; it wraps in even lines and the command stays
 * whole on one of them (`keepPhrases`).
 *
 * Inside the app (a back bar) it is one icon list: the current computer is
 * tagged, the others carry a Connect action, and Forget waits behind Edit so
 * the list is not narrowed by a column of destructive links. The standalone
 * picker (no session yet) keeps its selectable rows.
 */
export function ComputerListView({ view, onSwitch, onForget, onAdd, onBack, notice, footer }: {
  view: ComputersViewModel;
  onSwitch: (daemonId: string) => void | Promise<void>;
  onForget: (daemonId: string) => void;
  onAdd: () => void;
  onBack: () => void;
  notice?: ReactNode;
  footer?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  if (!view.withBack) {
    return (
      <>
        <Brand />
        <h1 className="prelude-title">{view.heading?.title}</h1>
        <p className="lede">{view.heading?.lede}</p>
        {notice}
        <div className="computer-list">
          {view.rows.map(row => (
            <div className="computer-row" key={row.daemonId}>
              <SelectionRow selected={row.current} onClick={() => onSwitch(row.daemonId)}
                title={row.title} description={row.meta}
                badge={row.currentPill ? <span className="pill pill-live">{row.currentPill}</span> : null} />
              <Button className="computer-forget" aria-label={row.forgetAria} onClick={() => onForget(row.daemonId)}>{row.forgetLabel}</Button>
            </div>
          ))}
        </div>
        <SelectionRow className="computer-add" onClick={onAdd} title={view.addLabel} description={keepPhrases(view.addHint)}
          leading={<span className="add-mark" aria-hidden="true"><Plus size={18} /></span>} />
        {footer}
      </>
    );
  }
  return (
    <>
      <BackBar title={view.backTitle} onBack={onBack}>
        {view.rows.length ? <TopbarActions>
          <Button className="topbar-create computers-edit" aria-pressed={editing} onClick={() => setEditing(!editing)}>
            {t(editing ? "set.done" : "set.edit")}
          </Button>
        </TopbarActions> : null}
      </BackBar>
      {notice}
      <SetGroup className="computer-set" icons>
        {view.rows.map(row => (
          <SetItem key={row.daemonId} className="computer-item"
            leading={<span className="set-icon" aria-hidden="true"><Monitor size={17} /></span>}
            label={row.title} sub={pending === row.daemonId ? t("set.connecting") : row.meta}
            trailing={editing
              ? <SetAction tone="danger" className="computer-forget-action" aria-label={row.forgetAria} onClick={() => onForget(row.daemonId)}>{row.forgetLabel}</SetAction>
              : pending === row.daemonId ? <Spinner />
              : row.current ? <SetTag tone="ok">{row.currentPill}</SetTag>
              : <SetAction disabled={pending !== null} onClick={() => {
                  setPending(row.daemonId);
                  void Promise.resolve(onSwitch(row.daemonId)).finally(() => setPending(null));
                }}>{t("set.connect")}</SetAction>} />
        ))}
      </SetGroup>
      <SetGroup className="computer-add-group" icons note={keepPhrases(view.addHint)}>
        <Button className="set-item set-nav computer-add-item" onClick={onAdd}>
          <span className="set-icon is-accent" aria-hidden="true"><Plus size={17} /></span>
          <span className="set-item-text"><span className="set-item-label">{view.addLabel}</span></span>
        </Button>
      </SetGroup>
      {footer}
    </>
  );
}
