import { useLayoutEffect, useRef, useSyncExternalStore, type ComponentType } from "react";
import { useDashboard } from "../../dashboard/hooks";
import { useSession } from "../hooks";
import { agentFromDashboardSnapshot } from "../agents";
import { sessionOwner } from "../identity";
import { t } from "../../../lib/i18n";
import { armSwipeHint } from "./pane-swipe";
import { paneModel, type PaneModel } from "./pane-model";
import { toggleTermSelect } from "./term";
import { finishSessionPaint, type SessionHandlers } from "./view";
import { sessionUIRevision, subscribeSessionUI } from "./ui-revision";
import { morphingPane, queuedKind, shareOpening } from "../../../app/transition";
import { AppNotice } from "../../../app/notice";
import { Button } from "../../../shared/ui/primitives";
import { SessionChrome } from "./session-chrome";
import { SessionTerminal } from "./session-terminal";
import { SessionRowBar } from "./session-rowbar";
import { SessionDock } from "./session-dock";

type SessionParts = {
  Terminal: ComponentType<{ model: PaneModel }>;
  RowBar: ComponentType<{ model: PaneModel }>;
  Dock: ComponentType<{ includeBack: boolean }>;
};

const defaultParts: SessionParts = {
  Terminal: () => <SessionTerminal />,
  RowBar: () => <SessionRowBar />,
  Dock: SessionDock,
};
type SessionPaneProps = {
  includeBack: boolean;
  handlers: SessionHandlers;
  scroll: { top: number; left: number; bottom: boolean };
  parts?: SessionParts;
};

/** A new pane/view owns fresh bindings; ordinary output retains the field and terminal. */
export function SessionPane(props: SessionPaneProps) {
  return <SessionPaneView key={sessionOwner().key} {...props} />;
}

function SessionPaneView({ includeBack, handlers, scroll, parts = defaultParts }: SessionPaneProps) {
  useSyncExternalStore(subscribeSessionUI, sessionUIRevision);
  const session = useSession();
  const dashboard = useDashboard();
  const selected = agentFromDashboardSnapshot(dashboard, session.paneId);
  const root = useRef<HTMLDivElement>(null);
  const model = paneModel();
  const shown = useRef(model);
  if (!session.termSelect) shown.current = model;
  const { Terminal, RowBar, Dock } = parts;

  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    if (includeBack) armSwipeHint(host);
    finishSessionPaint(scroll);
  }, [includeBack, session.termSelect]);
  useLayoutEffect(() => {
    if (queuedKind() === "expand" && morphingPane() === session.paneId && root.current) shareOpening(root.current);
  });

  return <div ref={root} className="pane-root" data-react-guided-pane="">
    <SessionChrome selected={selected} includeBack={includeBack} handlers={handlers} />
    {!selected ? <p className="empty-sub">{t("err.paneGone")}</p> : <>
      <AppNotice />
      <Terminal model={shown.current} />
      <div className="session-extras"><RowBar model={shown.current} /></div>
      {session.termSelect ? <div className="select-bar">
        <p className="select-hint">{t("term.selectHint")}</p>
        <Button className="btn btn-small" onClick={() => toggleTermSelect(false)}>{t("term.done")}</Button>
      </div> : <Dock includeBack={includeBack} />}
    </>}
  </div>;
}
