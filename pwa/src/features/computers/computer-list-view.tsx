import type { ReactNode } from "react";
import { BackBar, Brand, Button, Chevron } from "../../shared/ui/primitives";
import type { ComputersViewModel } from "./model";

/**
 * The computer picker list. Pure: every string and the back target arrive in the
 * view model, mutations are callbacks the caller owns, and chrome the page still
 * hosts (`AppNotice`, daemon-update help) arrives as slots.
 */
export function ComputerListView({ view, onSwitch, onForget, onAdd, onBack, notice, footer }: {
  view: ComputersViewModel;
  onSwitch: (daemonId: string) => void;
  onForget: (daemonId: string) => void;
  onAdd: () => void;
  onBack: () => void;
  notice?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <>
      {view.withBack ? (
        <BackBar title={view.backTitle} onBack={onBack} />
      ) : (
        <>
          <Brand />
          <h1 className="prelude-title">{view.heading?.title}</h1>
          <p className="lede">{view.heading?.lede}</p>
        </>
      )}
      {notice}
      <div className="computer-list">
        {view.rows.map(row => (
          <div className="computer-row" key={row.daemonId}>
            <Button className={`switch-item${row.current ? " on" : ""}`} onClick={() => onSwitch(row.daemonId)}>
              <span className="switch-main">
                <span className="switch-head">
                  <span className="switch-name">{row.title}</span>
                  {row.currentPill ? <span className="pill pill-live">{row.currentPill}</span> : null}
                </span>
                <span className="switch-meta">{row.meta}</span>
              </span>
              <Chevron />
            </Button>
            <Button className="computer-forget" aria-label={row.forgetAria} onClick={() => onForget(row.daemonId)}>{row.forgetLabel}</Button>
          </div>
        ))}
      </div>
      <Button className="switch-item computer-add" onClick={onAdd}>
        <span className="add-mark" aria-hidden="true" />
        <span className="switch-main">
          <span className="switch-head">
            <span className="switch-name">{view.addLabel}</span>
          </span>
          <span className="switch-meta">{view.addHint}</span>
        </span>
        <Chevron />
      </Button>
      {footer}
    </>
  );
}
