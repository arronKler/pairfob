import { useLayoutEffect, useRef, useSyncExternalStore, type ComponentType } from "react";
import { useDashboard } from "../../dashboard/hooks";
import { useSession } from "../hooks";
import { agentFromDashboardSnapshot } from "../agents";
import { sessionOwner } from "../identity";
import { t } from "../../../lib/i18n";
import { paneModel, type PaneModel } from "./pane-model";
import { finishSessionPaint, type SessionHandlers } from "./view";
import { sessionUIRevision, subscribeSessionUI } from "./ui-revision";
import { morphingPane, queuedKind, shareOpening } from "../../../app/transition";
import { useHardwareKeyboard } from "../../../app/input-mode";
import { SessionAppNotice } from "../session-notice";
import { SelectHint } from "./select-hint";
import { SessionChrome } from "./session-chrome";
import { SessionTerminal } from "./session-terminal";
import { SessionRowBar } from "./session-rowbar";
import { SessionDock } from "./session-dock";

type SessionParts = {
  Terminal: ComponentType<{ model: PaneModel }>;
  RowBar: ComponentType<{ model: PaneModel }>;
  Dock: ComponentType<{ includeBack: boolean; phone?: boolean }>;
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
  // The field follows the keyboard, not the layout: a landscape tablet is wide
  // and still types on glass, and a back button can sit beside a mouse.
  const phone = !useHardwareKeyboard();

  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    finishSessionPaint(scroll);
  }, [includeBack, session.termSelect]);
  useLayoutEffect(() => {
    if (queuedKind() === "expand" && morphingPane() === session.paneId && root.current) shareOpening(root.current);
  });

  return <div ref={root} className="pane-root" data-react-guided-pane="">
    <SessionChrome selected={selected} includeBack={includeBack} handlers={handlers} />
    {!selected ? <p className="empty-sub">{t("err.paneGone")}</p> : <>
      <SessionAppNotice />
      <div className="term-stage">
        <Terminal model={shown.current} />
        <RowBar model={shown.current} />
        {session.termSelect ? <SelectHint /> : null}
      </div>
      {/* The dock keeps its place while selecting so the buffer does not jump under the
          finger; it is inert until selection ends. */}
      <div className="dock-slot" inert={session.termSelect || undefined}>
        <Dock includeBack={includeBack} phone={phone} />
      </div>
    </>}
  </div>;
}
