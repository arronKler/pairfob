import { ArrowLeftRight, ArrowRight, Columns2, Maximize, Minimize, Pencil, SlidersHorizontal, Trash2 } from "lucide-react";
import { Fragment, useEffect, type ReactNode } from "react";
import { currentScreen, navigationStore } from "../../app/navigation-store";
import { noticesStore, showStatus } from "../../app/notices-store";
import { agentStatusLabel, agentTitle, type DashboardAgentCard } from "../../lib/dashboard";
import { t, type CopyKey } from "../../lib/i18n";
import { boardStore, liveBoardCatalog } from "../../features/board/layout-store";
import {
  boardInteractionStore,
  clearBoardInteraction,
  highlightBoardPane,
  startBoardPlacement,
} from "../../features/board/interaction-store";
import { liveSession, computersStore, currentDaemonId } from "../../features/computers/catalog-store";
import { connectionStore, networkOnline } from "../../features/connection/connection-store";
import { dashboardStore, liveAgents } from "../../features/dashboard/catalog-store";
import { capabilitiesStore, operationBusy, operationCapabilities } from "../../features/operations/capabilities-store";
import { closePane, layoutSelectedPane, renamePane } from "../../features/operations/controller";
import { paneMenuEntries, panePosition, type BoardPaneAction, type PaneMenuGroup, type PaneMenuModel } from "../../features/board/model/pane-menu";
import { MenuChoice } from "../../shared/ui/overlay";
import { SheetFrame, type ActionSheetController, type SheetAction } from "../../shared/ui/overlay/action-sheet";
import { presentModal } from "../../shared/ui/overlay/modal";
import { createDomainUpdates, useDomainUpdates } from "../domain-updates";
import { openBoardResizeSheet } from "./resize-sheet";

const updates = createDomainUpdates([
  { store: navigationStore }, { store: boardStore }, { store: dashboardStore },
  { store: computersStore }, { store: connectionStore }, { store: capabilitiesStore }, { store: noticesStore },
]);

const GROUP_TITLE: Record<PaneMenuGroup, CopyKey> = {
  pane: "boardMenu.groupPane", layout: "boardMenu.groupLayout", manage: "boardMenu.groupManage",
};
const ICON: Record<BoardPaneAction, (zoomed: boolean) => ReactNode> = {
  open: () => <ArrowRight size={18} aria-hidden="true" />,
  rename: () => <Pencil size={18} aria-hidden="true" />,
  split: () => <Columns2 size={18} aria-hidden="true" />,
  resize: () => <SlidersHorizontal size={18} aria-hidden="true" />,
  swap: () => <ArrowLeftRight size={18} aria-hidden="true" />,
  zoom: (zoomed) => zoomed ? <Minimize size={18} aria-hidden="true" /> : <Maximize size={18} aria-hidden="true" />,
  close: () => <Trash2 size={18} aria-hidden="true" />,
};

type MenuDriver = { valid(): boolean; read(): PaneMenuModel; run(action: BoardPaneAction): SheetAction };

/**
 * The pane menu, grouped like the session row menu: this session, its layout,
 * then management. It re-reads the live model on every domain publish, so a
 * disconnect or a busy lock disables rows in place with the reason as detail,
 * and a pane that leaves the board closes the menu.
 */
function LivePaneMenu({ modal, driver }: { modal: ActionSheetController; driver: MenuDriver }) {
  useDomainUpdates(updates);
  const valid = driver.valid();
  useEffect(() => {
    if (!valid) queueMicrotask(() => {
      modal.dismiss();
      if (currentScreen() === "board") showStatus(t("boardMenu.targetGone"));
    });
  }, [valid, modal]);
  const model = driver.read();
  const zoomed = !!model.layout?.zoomed;
  return <div className="board-sheet board-pane-menu">
    {(["pane", "layout", "manage"] as const).map((group) => {
      const entries = model.entries.filter((entry) => entry.group === group);
      if (!entries.length) return null;
      return <Fragment key={group}>
        <h3 className="menu-section-title">{t(GROUP_TITLE[group])}</h3>
        {entries.map((entry) => <MenuChoice key={entry.id} modal={modal} icon={ICON[entry.id](zoomed)} title={entry.label}
          detail={entry.reason || entry.detail} disabled={!!entry.reason} danger={entry.danger} action={driver.run(entry.id)} />)}
      </Fragment>;
    })}
    {model.notice ? <p className="board-sheet-note" role="status">{model.notice}</p> : null}
  </div>;
}

/** Capture identity once; never select a session pane just to operate on a tile. */
export async function openBoardPaneMenu(paneId: string, _anchor: { x: number; y: number }, tile: HTMLElement,
  ports: { openPane(paneId: string, tile?: HTMLElement): void; revealPane(paneId: string): void }): Promise<void> {
  const session = liveSession();
  const daemonId = currentDaemonId();
  const catalog = liveBoardCatalog();
  const agent = liveAgents().find(pane => pane.paneId === paneId && pane.tabId === catalog.tabId && pane.workspaceId === catalog.workspaceId);
  if (!agent || !agent.tabId || !session || currentScreen() !== "board") return;
  const tabId = agent.tabId;
  let invalidated = false;
  const valid = () => {
    const current = liveBoardCatalog();
    invalidated ||= liveSession() !== session || currentDaemonId() !== daemonId || currentScreen() !== "board"
      || current.tabId !== catalog.tabId || current.workspaceId !== catalog.workspaceId
      || !liveAgents().some(pane => pane.paneId === paneId && pane.tabId === agent.tabId && pane.workspaceId === agent.workspaceId);
    return !invalidated;
  };
  // Observe departures even if a caller changes tabs and returns before React paints.
  const releaseScope = updates.subscribe(() => { valid(); });
  const card = () => (liveAgents().find(pane => pane.paneId === paneId) ?? agent) as DashboardAgentCard;
  const read = (): PaneMenuModel => {
    const current = card();
    const layout = liveBoardCatalog().layouts.find(layout => layout.tabId === agent.tabId) ?? null;
    const disabledReason = !session.isConnected() || !networkOnline() ? t("boardMenu.offline")
      : operationBusy() ? t("boardMenu.busy") : "";
    return { title: agentTitle(current), subtitle: [agentStatusLabel(current), current.tabLabel || current.tabId, panePosition(layout, paneId)]
      .filter(Boolean).join(" · "),
      paneId, layout, disabledReason, entries: paneMenuEntries(operationCapabilities(), layout, disabledReason),
      notice: noticesStore.get().notice?.text ?? "" };
  };
  const options = { valid };
  // Each row's action runs after the sheet closed, and only if the row still could.
  const run = (action: BoardPaneAction): SheetAction => async () => {
    const model = read();
    if (!valid() || !model.entries.some(entry => entry.id === action && !entry.reason)) return;
    switch (action) {
      case "open": ports.openPane(paneId, tile); break;
      case "rename": await renamePane(card(), options); break;
      case "split": startBoardPlacement("split", paneId, tabId); break;
      case "swap": startBoardPlacement("swap", paneId, tabId); break;
      case "resize": openBoardResizeSheet(paneId); break;
      case "zoom": await layoutSelectedPane("zoom", card(), { ...options, zoomMode: model.layout?.zoomed ? "off" : "on" }); break;
      case "close": await closePane(card(), options); break;
    }
  };
  const trigger = tile.querySelector<HTMLElement>(".board-pane-open") ?? tile;
  if (!tile.contains(document.activeElement)) trigger.focus({ preventScroll: true });
  highlightBoardPane(paneId, tabId);
  try {
    const initial = read();
    const modal = presentModal<SheetAction>(controller => (
      <SheetFrame modal={controller} title={initial.title} subtitle={initial.subtitle} className="board-pane-sheet">
        <LivePaneMenu modal={controller} driver={{ valid, read, run }} />
      </SheetFrame>
    ), { replaceKey: "board-pane-menu" });
    const action = await modal.result;
    if (action && valid()) await action();
  } finally {
    releaseScope();
    const interaction = boardInteractionStore.get();
    // A created-pane notice owns its own highlight lifetime; a placement the
    // menu started keeps its target and only drops the menu highlight.
    if (interaction.placementKind) highlightBoardPane("", interaction.tabId);
    else if (!interaction.createdPaneId) clearBoardInteraction();
    if (currentScreen() === "board" && !document.querySelector("dialog[open]")) {
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>(".board-pane-open, .board-tab")?.focus({ preventScroll: true });
    }
  }
}
