import { useEffect, useRef } from "react";
import { BackButton, Button, StatusLine } from "../../../shared/ui/primitives";
// AppNotice is the connected App notice (chrome barrel seam); HerdBanners is the
// connection feature's own pure banner component.
import { AppNotice } from "../../../app/notice";
import { HerdBanners } from "../../../features/connection/herd-banners";
import type { BoardViewModel } from "../model/board-view";
import { scheduleRailVisibility } from "../rail/visibility";
import { BoardCanvasView, type BoardCanvasController } from "./board-canvas";

/** Narrow intents the board chrome can fire; the page binds them to actions. */
export type BoardScreenActions = {
  back(): void;
  selectWorkspace(workspaceId: string): void;
  selectTab(tabId: string): void;
  createTab(): void;
  fit(): void;
  zoom(direction: 1 | -1): void;
};

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

/**
 * Board screen presentation.
 *
 * Everything it shows comes from `view`; everything it does goes through
 * `actions` and `controller`. The two DOM lifecycles it owns are explicit
 * effects with cleanup: rail measurement after each commit, and releasing the
 * remote scroll controller when the board is really being left.
 */
export function BoardScreenView({
  view,
  actions,
  controller,
}: {
  view: BoardViewModel;
  actions: BoardScreenActions;
  controller: BoardCanvasController;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const spaceRailRef = useRef<HTMLDivElement>(null);
  const spacesRef = useRef<HTMLDivElement>(null);
  const tabRailRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() =>
    scheduleRailVisibility({
      root: rootRef.current,
      spaceRail: spaceRailRef.current,
      spaces: spacesRef.current,
      tabRail: tabRailRef.current,
      tabs: tabsRef.current,
    }),
  );
  // Owned per setup: a replaced controller releases its own scroll lifetime.
  useEffect(() => () => controller.releaseScrollOnLeave(), [controller]);
  return (
    <div ref={rootRef} className="board-shell">
      <header className="board-chrome">
        <BackButton onBack={actions.back} label={view.back} />
        <div className="board-title">
          <strong className="board-name">{view.title}</strong>
          {view.sub ? <span className="board-sub">{view.sub}</span> : null}
        </div>
        <div className="board-zoom">
          <Button className="icon-btn" aria-label={view.zoom.out} onClick={() => actions.zoom(-1)}>−</Button>
          <Button className="text-link" aria-label={view.zoom.fit} onClick={actions.fit}>{view.zoom.fitLabel}</Button>
          <Button className="icon-btn" aria-label={view.zoom.in} onClick={() => actions.zoom(1)}>+</Button>
        </div>
      </header>
      <StatusLine status={view.status} />
      <HerdBanners tone={view.status.tone} />
      <AppNotice />
      <div ref={spaceRailRef} className="board-rail">
        <div ref={spacesRef} className="board-spaces" role="tablist" aria-label={view.spaceAria}>
          {view.spaces.map((space) => (
            <BoardRailChip
              key={space.id}
              label={space.label}
              className={`board-chip${space.selected ? " on" : ""}`}
              tab
              selected={space.selected}
              onClick={() => actions.selectWorkspace(space.id)}
            />
          ))}
          {!view.spaces.length ? <p className="empty-sub">{view.spacesEmpty}</p> : null}
        </div>
      </div>
      <div ref={tabRailRef} className="board-rail">
        <div ref={tabsRef} className="board-tabs" role="tablist" aria-label={view.tabAria}>
          {view.tabs.map((tab) => (
            <BoardRailChip
              key={tab.id}
              label={tab.label}
              className={`board-tab${tab.selected ? " on" : ""}`}
              tab
              selected={tab.selected}
              onClick={() => actions.selectTab(tab.id)}
            />
          ))}
          {view.create ? (
            <BoardRailChip
              label={view.create.label}
              className="board-tab-new"
              disabled={view.create.disabled}
              onClick={actions.createTab}
            />
          ) : null}
        </div>
      </div>
      <BoardCanvasView canvas={view.canvas} controller={controller} />
    </div>
  );
}
