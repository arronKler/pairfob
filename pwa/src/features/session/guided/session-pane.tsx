import { useLayoutEffect, useRef, useSyncExternalStore, type ComponentType } from "react";
import { useAgentCard, usePaneId, usePaneTermSelect } from "../hooks";
import { sessionOwner } from "../identity";
import { t } from "../../../lib/i18n";
import { paneModel, type PaneModel } from "./pane-model";
import { finishSessionPaint, type SessionHandlers } from "./view";
import { sessionUIRevision, subscribeSessionUI } from "./ui-revision";
import { morphingPane, queuedKind, shareOpening } from "../../../app/transition";
import { useHardwareKeyboard } from "../../../app/input-mode";
import { usePresence } from "../../../shared/react/use-presence";
import { MOTION_MS } from "../../../shared/ui/dom/motion";
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
  // What this screen decides is which pane and whether text is being selected;
  // the buffer, the follow flag and every keystroke publish below it, into the
  // terminal, the row bar and the dock that read them.
  const paneId = usePaneId();
  const selecting = usePaneTermSelect();
  const selected = useAgentCard(paneId);
  const root = useRef<HTMLDivElement>(null);
  const model = paneModel();
  const shown = useRef(model);
  if (!selecting) shown.current = model;
  const { Terminal, RowBar, Dock } = parts;
  // The field follows the keyboard, not the layout: a landscape tablet is wide
  // and still types on glass, and a back button can sit beside a mouse.
  const phone = !useHardwareKeyboard();
  // The hint outlives the mode by its exit.
  const hint = usePresence(selecting, MOTION_MS.press);

  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    finishSessionPaint(scroll);
  }, [includeBack, selecting]);
  useLayoutEffect(() => {
    if (queuedKind() === "expand" && morphingPane() === paneId && root.current) shareOpening(root.current);
  });

  return <div ref={root} className="pane-root" data-react-guided-pane="">
    <SessionChrome selected={selected} includeBack={includeBack} handlers={handlers} />
    {!selected ? <p className="empty-sub">{t("err.paneGone")}</p> : <>
      <SessionAppNotice />
      <div className="term-stage">
        <Terminal model={shown.current} />
        <RowBar model={shown.current} />
        {hint.mounted ? <SelectHint leaving={hint.leaving} /> : null}
      </div>
      {/* The dock keeps its place while selecting so the buffer does not jump under the
          finger; it is inert until selection ends. */}
      <div className="dock-slot" inert={selecting || undefined}>
        <Dock includeBack={includeBack} phone={phone} />
      </div>
    </>}
  </div>;
}
