import { useLayoutEffect, useRef, useSyncExternalStore, type ComponentType } from "react";
import { t } from "../../lib/i18n";
import { selectedAgent, state } from "../../state";
import { armSwipeHint } from "../pane-swipe";
import { paneModel, type PaneModel } from "../session/model";
import { toggleTermSelect } from "../session/term";
import { finishSessionPaint, type SessionHandlers } from "../session/view";
import { currentViewIncarnation } from "../../compose-drafts";
import { sessionUIRevision, subscribeSessionUI } from "../session/ui-revision";
import { morphingPane, queuedKind, shareOpening } from "../transition";
import { AppNotice, Button } from "./chrome";
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
const sessions = new WeakMap<object, number>();
let nextSession = 0;
type SessionPaneProps = {
  includeBack: boolean;
  handlers: SessionHandlers;
  scroll: { top: number; left: number; bottom: boolean };
  parts?: SessionParts;
};

/** A new pane/view owns fresh bindings; ordinary output retains the field and terminal. */
export function SessionPane(props: SessionPaneProps) {
  const session = state.live;
  let id = session ? sessions.get(session) : 0;
  if (session && id === undefined) { id = ++nextSession; sessions.set(session, id); }
  return <SessionPaneView key={`${id}:${state.paneId}:${currentViewIncarnation()}`} {...props} />;
}

function SessionPaneView({ includeBack, handlers, scroll, parts = defaultParts }: SessionPaneProps) {
  useSyncExternalStore(subscribeSessionUI, sessionUIRevision);
  const root = useRef<HTMLDivElement>(null);
  const selected = selectedAgent();
  const model = paneModel();
  const shown = useRef(model);
  if (!state.termSelect) shown.current = model;
  const { Terminal, RowBar, Dock } = parts;

  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    if (includeBack) armSwipeHint(host);
    finishSessionPaint(scroll);
  }, [includeBack, state.termSelect]);
  useLayoutEffect(() => {
    if (queuedKind() === "expand" && morphingPane() === state.paneId && root.current) shareOpening(root.current);
  });

  return <div ref={root} className="pane-root" data-react-guided-pane="">
    <SessionChrome selected={selected} includeBack={includeBack} handlers={handlers} />
    {!selected ? <p className="empty-sub">{t("err.paneGone")}</p> : <>
      <AppNotice />
      <Terminal model={shown.current} />
      <div className="session-extras"><RowBar model={shown.current} /></div>
      {state.termSelect ? <div className="select-bar">
        <p className="select-hint">{t("term.selectHint")}</p>
        <Button className="btn btn-small" onClick={() => toggleTermSelect(false)}>{t("term.done")}</Button>
      </div> : <Dock includeBack={includeBack} />}
    </>}
  </div>;
}
