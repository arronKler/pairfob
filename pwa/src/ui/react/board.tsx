import { useEffect, useRef } from "react";
import { t } from "../../lib/i18n";
import { tabsInWorkspace } from "../../lib/layout";
import { state } from "../../state";
import {
  closeBoard,
  markRailOverflow,
  newTabInBoard,
  revealSelection,
  selectTab,
  selectWorkspace,
  tabLabel,
  workspaceLabel,
} from "../board";
import { fitCurrentBoard, nudgeBoardZoom, releaseBoardScroll } from "../board-canvas";
import { herdStatus } from "../chrome";
import { BoardCanvas } from "./board-canvas";
import { AppNotice, BackButton, Button, HerdBanners, StatusLine } from "./chrome";

function BoardRailChip({
  label,
  className,
  onClick,
  selected,
  disabled,
  tab,
}: {
  label: string;
  className: string;
  onClick: () => void;
  selected?: boolean;
  disabled?: boolean;
  tab?: boolean;
}) {
  return (
    <Button
      className={className}
      role={tab ? "tab" : undefined}
      aria-selected={tab ? selected : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
    </Button>
  );
}

export function BoardScreen() {
  const rootRef = useRef<HTMLDivElement>(null);
  const spaceRailRef = useRef<HTMLDivElement>(null);
  const spacesRef = useRef<HTMLDivElement>(null);
  const tabRailRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const status = herdStatus();
  const current = state.workspaceList.find((item) => item.id === state.boardWorkspaceId);
  const tabs = tabsInWorkspace(state.tabList, state.boardWorkspaceId);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const root = rootRef.current;
      const spaceRail = spaceRailRef.current;
      const spaces = spacesRef.current;
      const tabRail = tabRailRef.current;
      const tabRow = tabsRef.current;
      if (spaceRail && spaces) markRailOverflow(spaceRail, spaces);
      if (tabRail && tabRow) markRailOverflow(tabRail, tabRow);
      if (root) revealSelection(root);
    });
    return () => cancelAnimationFrame(id);
  });
  useEffect(() => {
    return () => {
      if (state.screen !== "board") releaseBoardScroll();
    };
  }, []);
  return (
    <div ref={rootRef} className="board-shell">
      <header className="board-chrome">
        <BackButton onBack={closeBoard} label={t("board.back")} />
        <div className="board-title">
          <strong className="board-name">{t("board.title")}</strong>
          {current ? <span className="board-sub">{workspaceLabel(current.id, current.label)}</span> : null}
        </div>
        <div className="board-zoom">
          <Button className="icon-btn" aria-label={t("board.zoomOut")} onClick={() => nudgeBoardZoom(-1)}>−</Button>
          <Button className="text-link" aria-label={t("board.fitAria")} onClick={fitCurrentBoard}>{t("board.fit")}</Button>
          <Button className="icon-btn" aria-label={t("board.zoomIn")} onClick={() => nudgeBoardZoom(1)}>+</Button>
        </div>
      </header>
      <StatusLine status={status} />
      <HerdBanners tone={status.tone} />
      <AppNotice />
      <div ref={spaceRailRef} className="board-rail">
        <div ref={spacesRef} className="board-spaces" role="tablist" aria-label={t("board.workspaceAria")}>
          {state.workspaceList.map((space) => {
            const on = space.id === state.boardWorkspaceId;
            return (
              <BoardRailChip
                key={space.id}
                label={workspaceLabel(space.id, space.label)}
                className={`board-chip${on ? " on" : ""}`}
                tab
                selected={on}
                onClick={() => selectWorkspace(space.id)}
              />
            );
          })}
          {!state.workspaceList.length ? <p className="empty-sub">{t("board.empty")}</p> : null}
        </div>
      </div>
      <div ref={tabRailRef} className="board-rail">
        <div ref={tabsRef} className="board-tabs" role="tablist" aria-label={t("board.tabAria")}>
          {tabs.map((tab, index) => {
            const on = tab.id === state.boardTabId;
            return (
              <BoardRailChip
                key={tab.id}
                label={tabLabel(tab, index)}
                className={`board-tab${on ? " on" : ""}`}
                tab
                selected={on}
                onClick={() => selectTab(tab.id)}
              />
            );
          })}
          {state.operationCapabilities.create_tab ? (
            <BoardRailChip
              label={state.operationBusy ? t("home.creating") : t("board.newTab")}
              className="board-tab-new"
              disabled={state.operationBusy || !state.live?.isConnected() || !state.boardWorkspaceId}
              onClick={newTabInBoard}
            />
          ) : null}
        </div>
      </div>
      <BoardCanvas />
    </div>
  );
}
