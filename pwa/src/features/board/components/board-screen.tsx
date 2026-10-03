import { ChevronDown, Folder, Minus, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { BackButton, Button, StatusDot, StatusLine } from "../../../shared/ui/primitives";
import { MenuChoice, showActionSheet, useObjectPress } from "../../../shared/ui/overlay";
import { t } from "../../../lib/i18n";
// AppNotice is the connected App notice (chrome barrel seam); HerdBanners is the
// connection feature's own pure banner component.
import { AppNotice } from "../../../app/notice";
import { HerdBanners } from "../../../features/connection/herd-banners";
import type { BoardSpaceView, BoardTabChip, BoardViewModel } from "../model/board-view";
import { scheduleRailVisibility } from "../rail/visibility";
import { BoardCanvasView, type BoardCanvasController } from "./board-canvas";

/** Narrow intents the board chrome can fire; the page binds them to actions. */
export type BoardScreenActions = {
  back(): void;
  selectWorkspace(workspaceId: string): void;
  selectTab(tabId: string): void;
  /** "+": the shared "新建窗格" sheet on the board's workspace. */
  createTab(): void;
  /** A hold on "+": recent combinations in one step, like the home create button. */
  quickCreate(): void;
  /** Long-press, right-click or the title's ⋯: rename, new, close for that tab. */
  tabMenu(tabId: string): void;
  fit(): void;
  zoom(direction: 1 | -1): void;
};

function SpaceMarks({ space }: { space: BoardSpaceView }) {
  return <>
    {space.blockedCount > 0 ? <b className="board-mark is-blocked">{t("list.markBlocked", { count: String(space.blockedCount) })}</b> : null}
    {space.doneCount > 0 ? <b className="board-mark is-done">{t("list.markDone", { count: String(space.doneCount) })}</b> : null}
  </>;
}

/** The workspace switcher behind the board title, with the same marks as the list. */
function openWorkspaceSheet(view: BoardViewModel, select: (workspaceId: string) => void): void {
  showActionSheet(view.spaceAria, (modal) => (
    <>
      {view.spaces.map((space) => (
        <MenuChoice key={space.id} modal={modal} icon={<Folder size={18} aria-hidden="true" />}
          title={space.label}
          detail={space.path || space.blockedCount || space.doneCount
            ? <><SpaceMarks space={space} />{space.path ? <span className="mono">{space.path}</span> : null}</>
            : undefined}
          selected={space.selected}
          action={space.selected ? undefined : () => select(space.id)} />
      ))}
      {!view.spaces.length ? <p className="empty-sub">{view.spacesEmpty}</p> : null}
    </>
  ));
}

/** One tab of the strip; a hold, right-click or the context-menu key opens its menu. */
function BoardTabButton({ tab, actions }: { tab: BoardTabChip; actions: BoardScreenActions }) {
  const press = useObjectPress(() => actions.tabMenu(tab.id));
  return (
    <Button ref={press} className={`seg-item board-tab${tab.selected ? " on" : ""}`} role="tab" aria-selected={tab.selected}
      tabIndex={tab.selected ? 0 : -1} onClick={() => actions.selectTab(tab.id)}>
      {tab.label}{tab.attention ? <>
        <i className={`seg-dot is-${tab.attention}`} aria-hidden="true" />
        <span className="sr-only">{t(tab.attention === "blocked" ? "board.tabWaiting" : "board.tabDone")}</span>
      </> : null}
    </Button>
  );
}

function NewTabButton({ create, actions }: { create: NonNullable<BoardViewModel["create"]>; actions: BoardScreenActions }) {
  const press = useObjectPress(actions.quickCreate, !create.disabled);
  return (
    <Button ref={press} className="icon-btn board-tab-new" aria-label={create.label} title={t("boardMenu.newTab")}
      disabled={create.disabled} onClick={actions.createTab}>
      <Plus size={20} aria-hidden="true" />
    </Button>
  );
}

/** Arrow keys move along the tabs, like the segmented controls elsewhere. */
function stripKeys(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  event.preventDefault();
  tabs[(current + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length].focus();
}

/**
 * Zoom as the reader meets it: on a phone a pill that appears only once the
 * camera left the whole-tab fit; on the desk a small bar. `percent` is the
 * camera scale; null when the page does not track it (then only Fit shows).
 */
export function BoardZoomControls({ percent, atFit, actions, view }: {
  percent: number | null; atFit: boolean; actions: Pick<BoardScreenActions, "fit" | "zoom">; view: BoardViewModel;
}) {
  return (
    <div className="board-zoom" role="group" aria-label={t("board.zoomGroup")} data-at-fit={atFit ? "" : undefined}>
      <Button className="icon-btn board-zoom-step" aria-label={view.zoom.out} onClick={() => actions.zoom(-1)}>
        <Minus size={18} aria-hidden="true" />
      </Button>
      {percent !== null ? <output className="board-zoom-pct" aria-live="off">{t("boardMenu.zoomPercent", { n: percent })}</output> : null}
      <Button className="icon-btn board-zoom-step" aria-label={view.zoom.in} onClick={() => actions.zoom(1)}>
        <Plus size={18} aria-hidden="true" />
      </Button>
      <Button className="board-zoom-fit" aria-label={view.zoom.fit} onClick={actions.fit}>{view.zoom.fitLabel}</Button>
    </div>
  );
}

/**
 * Board screen presentation.
 *
 * Everything it shows comes from `view`; everything it does goes through
 * `actions` and `controller`. The title follows the session list's host title:
 * the workspace (tap to switch) over its path and waiting/done counts, with the
 * tab menu on ⋯. The tabs are a scrollable segmented strip beside "+". The
 * connected page may hand in its own zoom control (it follows the camera);
 * without one the fit-only control shows. On a phone tab root there is no back
 * button — the tab bar leaves the board — while elsewhere the board keeps back
 * and the status line. The two DOM lifecycles it owns are explicit effects with
 * cleanup: strip measurement after each commit, and releasing the remote scroll
 * controller when the board is really being left.
 */
export function BoardScreenView({
  view,
  actions,
  controller,
  showBack = true,
  zoomControl,
  notices,
}: {
  view: BoardViewModel;
  actions: BoardScreenActions;
  controller: BoardCanvasController;
  showBack?: boolean;
  zoomControl?: ReactNode;
  /** Page-owned notices (the new-split offer) that float with the rest, above the tab bar. */
  notices?: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRailRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() =>
    scheduleRailVisibility({
      root: rootRef.current,
      tabRail: tabRailRef.current,
      tabs: tabsRef.current,
    }),
  );
  // Owned per setup: a replaced controller releases its own scroll lifetime.
  useEffect(() => () => controller.releaseScrollOnLeave(), [controller]);
  const space = view.workspace;
  const selectedTab = view.tabs.find((tab) => tab.selected);
  const stale = view.status.tone === "warn" || view.status.tone === "pending";
  return (
    <div ref={rootRef} className="board-shell">
      <header className="board-chrome">
        {showBack ? <BackButton onBack={actions.back} label={view.back} /> : <h1 className="sr-only">{view.title}</h1>}
        {/* No workspace yet: a plain title, not a switcher with nothing in it. */}
        {space ? (
          <Button className="host-title board-title" aria-haspopup="dialog" aria-label={view.spaceAria}
            onClick={() => openWorkspaceSheet(view, actions.selectWorkspace)}>
            <span className="host-title-text">
              <span className="host-title-name board-title-name">{space.label}<ChevronDown size={16} aria-hidden="true" /></span>
              {space.path || space.blockedCount || space.doneCount ? (
                <span className="host-title-line board-title-line">
                  {space.path ? <span className="mono board-title-path">{space.path}</span> : null}
                  <SpaceMarks space={space} />
                </span>
              ) : null}
            </span>
          </Button>
        ) : (
          <span className="host-title board-title is-static" aria-hidden={showBack ? undefined : true}>
            <span className="host-title-text"><span className="host-title-name board-title-name">{view.title}</span></span>
          </span>
        )}
        {selectedTab ? (
          <Button className="icon-btn board-tab-menu" aria-haspopup="dialog" aria-label={t("boardMenu.tabActions")}
            onClick={() => actions.tabMenu(selectedTab.id)}>
            <MoreHorizontal size={20} aria-hidden="true" />
          </Button>
        ) : null}
      </header>
      {showBack ? <StatusLine status={view.status} /> : null}
      {view.tabs.length || view.create ? (
        <div ref={tabRailRef} className="board-rail">
          <div ref={tabsRef} className="seg is-scroll board-tabs" role="tablist" aria-label={view.tabAria} onKeyDown={stripKeys}>
            {view.tabs.map((tab) => <BoardTabButton key={tab.id} tab={tab} actions={actions} />)}
          </div>
          {view.create ? <NewTabButton create={view.create} actions={actions} /> : null}
        </div>
      ) : null}
      {/* Stale: the picture is the last snapshot, and every layout action is refused with a reason. */}
      <div className={`board-body${stale ? " is-stale" : ""}`}>
        <BoardCanvasView canvas={view.canvas} controller={controller} />
        {/* Notices float over the canvas, so an operation's feedback never reflows it (and never moves the camera off fit). */}
        <div className="board-float">
          {stale && !showBack ? <p className={`board-status is-${view.status.tone}`} role="status"><StatusDot tone={view.status.tone} />{view.status.text}</p> : null}
          <HerdBanners tone={view.status.tone} />
          <AppNotice />
          {notices}
        </div>
        {view.canvas.layout
          ? zoomControl ?? <BoardZoomControls percent={null} atFit={false} actions={actions} view={view} />
          : null}
      </div>
    </div>
  );
}
