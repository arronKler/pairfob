import { ChevronDown, Folder, Maximize, Minus, MoreHorizontal, Move, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { BackButton, Button, StatusDot, StatusLine } from "../../../shared/ui/primitives";
import { MenuChoice, showActionSheet, useObjectPress } from "../../../shared/ui/overlay";
import { t } from "../../../lib/i18n";
// AppNotice is the connected App notice (chrome barrel seam); HerdBanners is the
// connection feature's own pure banner component.
import { AppNotice } from "../../../app/notice";
import { HerdBanners } from "../../../features/connection/herd-banners";
import type { BoardCanvasModel, BoardSpaceView, BoardTabChip, BoardViewModel } from "../model/board-view";
import { handFocusOn, paneOpenButton } from "../canvas/pane-focus";
import { scheduleRailVisibility } from "../rail/visibility";
import { BoardCanvasView, type BoardCanvasController } from "./board-canvas";

/** Narrow intents the board chrome can fire; the page binds them to actions. */
export type BoardScreenActions = {
  back(): void;
  selectWorkspace(workspaceId: string): void;
  selectTab(tabId: string): void;
  /** "+": the shared "新建会话" sheet on the board's workspace. */
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
    <div className="board-sheet">
      {view.spaces.map((space) => (
        <MenuChoice key={space.id} modal={modal} icon={<Folder size={18} aria-hidden="true" />}
          title={space.label}
          detail={space.path || space.blockedCount || space.doneCount
            // The header's own line: the path, which gives way first, then the marks, a dot between each.
            ? <span className="board-space-line">
              {space.path ? <span className="mono board-space-path">{space.path}</span> : null}
              <SpaceMarks space={space} />
            </span>
            : undefined}
          selected={space.selected}
          action={space.selected ? undefined : () => select(space.id)} />
      ))}
      {!view.spaces.length ? <p className="empty-sub">{view.spacesEmpty}</p> : null}
    </div>
  ), { popover: "menu" });
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

/**
 * herdr shows one pane alone: the tab row says so and offers the way back.
 * Unlike a placement or a lift this lasts as long as the computer keeps it, so
 * the bar stands beside the tabs instead of in their place, and they stay in
 * reach. On the canvas it lay over the pane's own head wherever the stage
 * fills its window.
 */
function BoardZoomBar({ canvas, controller }: { canvas: BoardCanvasModel; controller: BoardCanvasController }) {
  const reason = controller.layoutReason("zoom");
  const bar = useRef<HTMLDivElement>(null);
  const shown = useRef(canvas.zoomedPaneId);
  shown.current = canvas.zoomedPaneId;
  // The bar leaves with the zoom. Focus that its button held (a click or Enter
  // restored the split) goes to the pane that was shown alone, where the reader
  // was looking, before the button is gone and focus with it.
  useLayoutEffect(() => {
    const node = bar.current;
    return () => { handFocusOn(node, paneOpenButton(node?.closest(".board-shell"), shown.current)); };
  }, []);
  return (
    <div ref={bar} className="board-mode-bar board-zoom-bar" role="status">
      <Maximize size={18} aria-hidden="true" />
      <p className="board-mode-text">{canvas.zoomBanner.text}</p>
      <Button className="board-mode-cancel" disabled={!!reason} title={reason || undefined}
        onClick={() => { void controller.toggleZoom(canvas.zoomedPaneId, "off"); }}>
        {canvas.zoomBanner.restore}
      </Button>
    </div>
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
 * tab menu on ⋯. The tabs are a scrollable segmented strip beside "+"; a board
 * with no tab has no such row, and its empty card offers the new session. The
 * row also carries the canvas modes' hints (`.board-mode`, filled by the
 * placement layer and shown for a lifted tile by the styles) and the bar of a
 * pane shown alone on the computer, and status feedback floats in the shell,
 * clear of the stage (`.board-float`). The
 * connected page may hand in its own zoom control (it follows the camera);
 * without one the fit-only control shows. On a phone tab root there is no back
 * button — the tab bar leaves the board — while elsewhere the board keeps back
 * and the status line; the desk board that took the list's column gets
 * `listBack` instead. The two DOM lifecycles it owns are explicit effects with
 * cleanup: strip measurement after each commit, and releasing the remote scroll
 * controller when the board is really being left.
 */
export function BoardScreenView({
  view,
  actions,
  controller,
  showBack = true,
  listBack,
  zoomControl,
  notices,
}: {
  view: BoardViewModel;
  actions: BoardScreenActions;
  controller: BoardCanvasController;
  showBack?: boolean;
  /**
   * The list gave its column to the board (the desk's narrowest tier): the
   * header leads back to it, carrying how many sessions wait on the reader as
   * the session header does. The status stays with the float, as beside the list.
   */
  listBack?: { waiting: number };
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
        {listBack && !showBack ? <span className="chrome-back">
          <BackButton onBack={actions.back}
            label={listBack.waiting ? t("chrome.backWaiting", { n: String(listBack.waiting) }) : view.back} />
          {listBack.waiting ? <span className="chrome-back-badge" aria-hidden="true">{listBack.waiting > 9 ? "9+" : listBack.waiting}</span> : null}
        </span> : null}
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
      {view.tabs.length ? (
        <div ref={tabRailRef} className="board-rail">
          <div ref={tabsRef} className="seg is-scroll board-tabs" role="tablist" aria-label={view.tabAria} onKeyDown={stripKeys}>
            {view.tabs.map((tab) => <BoardTabButton key={tab.id} tab={tab} actions={actions} />)}
          </div>
          {view.create ? <NewTabButton create={view.create} actions={actions} /> : null}
          {view.canvas.layout && view.canvas.zoomedPaneId ? <BoardZoomBar canvas={view.canvas} controller={controller} /> : null}
          {/* The row a canvas mode speaks in. A lifted tile is marked on the canvas at pointer speed,
              so its two lines wait here and the styles show the one that applies. */}
          <div className="board-mode">
            {(["held", "moved"] as const).map((state) => (
              <p key={state} className={`board-mode-bar board-mode-lift is-${state}`} aria-hidden="true">
                <Move size={18} aria-hidden="true" />
                <span className="board-mode-text">{t(state === "held" ? "boardCanvas.liftHeld" : "boardCanvas.liftMoved")}</span>
              </p>
            ))}
          </div>
        </div>
      ) : null}
      {/* Stale: the picture is the last snapshot, and every layout action is refused with a reason. */}
      <div className={`board-body${stale ? " is-stale" : ""}`}>
        {/* Without a tab there is no row for "+": the empty card offers the same sheet, drawn as the app's other create actions are. */}
        <BoardCanvasView canvas={view.canvas} controller={controller}
          emptyAction={!view.tabs.length && view.create
            ? { label: t("empty.actionCreate"), run: actions.createTab, disabled: view.create.disabled,
              icon: <Plus size={16} aria-hidden="true" /> } : undefined} />
        {view.canvas.layout
          ? zoomControl ?? <BoardZoomControls percent={null} atFit={false} actions={actions} view={view} />
          : null}
      </div>
      {/* Notices float, so an operation's feedback never reflows the canvas (and never moves the camera off fit). */}
      <div className="board-float">
        {stale && !showBack ? <p className={`board-status is-${view.status.tone}`} role="status"><StatusDot tone={view.status.tone} />{view.status.text}</p> : null}
        <HerdBanners tone={view.status.tone} />
        <AppNotice />
        {notices}
      </div>
    </div>
  );
}
