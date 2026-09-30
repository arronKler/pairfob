import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, LayoutGrid } from "lucide-react";
import { useRef, useState } from "react";
import { agentTitle, type DashboardAgentCard as AgentCard } from "../../../lib/dashboard";
import { t } from "../../../lib/i18n";
import type { LayoutDirection, ResizePaneInput } from "../../../lib/operations";
import type { TabLayoutView } from "../../../lib/layout";
import { layoutActionReason, type BoardLayoutAction, type PaneMenuModel } from "../../board/model/pane-menu";
import { paneStepMove, type DividerAxis } from "../../board/model/divider";
import { useBoard } from "../../board/hooks";
import { liveAgents } from "../../dashboard/catalog-store";
import { useDashboard } from "../../dashboard/hooks";
import { layoutSelectedPane } from "../../operations/controller";
import { useCapabilities } from "../../operations/hooks";
import { useConnection } from "../../connection/hooks";
import { openPane } from "../../connection/controller";
import { liveSession } from "../../computers/catalog-store";
import { usePreferences } from "../../settings/hooks";
import { openBoard } from "../../../pages/board/board-bridge";
import { MenuGroup, MenuRow, MenuSetting, MenuSwitch } from "../../../shared/ui/overlay/menu-controls";
import type { ActionSheetController } from "../../../shared/ui/overlay/action-sheet";
import { Button } from "../../../shared/ui/primitives";
import { PanePage } from "./pane-page";
import { LayoutPreview, type CellStatus } from "./pane-layout-preview";

export { cellStyle, layoutBoxes, layoutRatio, type CellBox } from "./pane-layout-preview";

const SWAPS: Array<{ direction: LayoutDirection; label: "form.swapLeft" | "form.swapRight" | "form.swapUp" | "form.swapDown"; Icon: typeof ArrowLeft }> = [
  { direction: "left", label: "form.swapLeft", Icon: ArrowLeft }, { direction: "right", label: "form.swapRight", Icon: ArrowRight },
  { direction: "up", label: "form.swapUp", Icon: ArrowUp }, { direction: "down", label: "form.swapDown", Icon: ArrowDown },
];

/** The layout of the tab this pane sits in, from the board's snapshot. */
export function useTabLayout(agent: Pick<AgentCard, "workspaceId" | "tabId"> | undefined): TabLayoutView | null {
  const board = useBoard();
  if (!agent) return null;
  return board.layouts.find(item => item.workspaceId === agent.workspaceId && item.tabId === agent.tabId) ?? null;
}

/**
 * Layout, pushed inside the pane sheet. The preview draws the tab the way the
 * board does and is the control (see `LayoutPreview`). Every mutation carries
 * its own operation id (never retried) and the preview redraws from the
 * refreshed snapshot rather than guessing the result. The steppers stay under
 * "Fine adjustments" for keyboard and screen readers.
 */
export function PaneLayoutPage({ modal, agent }: { modal: ActionSheetController; agent: AgentCard }) {
  const { operationBusy, operationCapabilities: caps } = useCapabilities();
  const agents = useDashboard().agents;
  const { listGroup } = usePreferences();
  const { networkOnline } = useConnection();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const pendingRef = useRef(false);
  const layout = useTabLayout(agent);
  const model: PaneMenuModel = { title: "", subtitle: "", entries: [], notice: "", layout, paneId: agent.paneId,
    disabledReason: !networkOnline || !liveSession()?.isConnected() ? t("boardMenu.offline")
      : operationBusy || pending ? t("boardMenu.busy") : "" };
  const split = !!layout && layout.panes.length > 1;
  const valid = () => liveAgents().some(pane => pane.paneId === agent.paneId && pane.tabId === agent.tabId);

  const run = async (work: () => Promise<unknown>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setMessage("");
    try { await work(); } finally { pendingRef.current = false; setPending(false); }
  };
  const swap = (action: BoardLayoutAction) => {
    if (layoutActionReason(model, action)) return;
    void run(() => layoutSelectedPane("swap", agent, { valid, choice: { kind: "swap", direction: action.direction } }));
  };
  // herdr resolves a resize against the named pane's edge, so the request may
  // name the neighbour across the divider (see board/model/divider.ts).
  // Never fall back to this pane: its edge may hold a different divider, so a
  // missing neighbour card refuses the resize instead of moving the wrong line.
  const resize = (request: ResizePaneInput): boolean => {
    if (model.disabledReason) return false;
    const target = agents.find(card => card.paneId === request.pane_id && card.tabId === agent.tabId);
    if (!target) { setMessage(t("boardMenu.targetGone")); return false; }
    void run(() => layoutSelectedPane("resize", target, { valid, choice: { kind: "resize", direction: request.direction, amount: request.amount ?? 0.05 } }));
    return true;
  };
  const blocked = (action: BoardLayoutAction) => !!layoutActionReason(model, action);
  const step = (axis: DividerAxis, grow: boolean) => layout && !layout.zoomed ? paneStepMove(layout, agent.paneId, axis, grow) : null;
  const pane = layout?.panes.find(item => item.paneId === agent.paneId);
  const share = (part: number, whole: number) => t("layout.share", { n: Math.round((part / whole) * 100) });
  const title = (id: string) => { const item = agents.find(card => card.paneId === id); return item ? agentTitle(item, listGroup) : ""; };
  const status = (id: string): CellStatus => {
    const item = agents.find(card => card.paneId === id);
    return item?.hasAgent ? (["blocked", "working", "done"].includes(item.status) ? item.status as CellStatus : "idle") : "";
  };
  const canFill = caps.zoom_pane && (split || !!layout?.zoomed);

  return <PanePage className="pane-layout">
    {layout && <LayoutPreview layout={layout} paneId={agent.paneId} title={title} status={status} disabled={!!model.disabledReason}
      canResize={caps.resize_pane && split && !layout.zoomed} canSwap={caps.swap_pane && split && !layout.zoomed}
      onResize={resize}
      onSwap={(direction) => {
        if (!direction) { setMessage(t("pm.swapNoNeighbor")); return; }
        swap({ kind: "swap", direction });
      }}
      onOpen={(paneId) => modal.close(() => void openPane(paneId))} />}
    {!split && !layout?.zoomed ? <p className="pane-layout-single">{t("pm.single")}</p>
      : <p className="pane-layout-hint">{t(layout?.zoomed ? "pm.layoutZoomHint" : "pm.layoutHint")}</p>}
    {!caps.zoom_pane && split && <p className="empty-sub">{t("pane.splitUnsupported")}</p>}
    <MenuGroup>
      {canFill && <MenuSwitch label={t("fill.enter")} checked={!!layout?.zoomed}
        onChange={(on) => { if (!model.disabledReason) void run(() => layoutSelectedPane("zoom", agent, { valid, zoomMode: on ? "on" : "off" })); }} />}
      <MenuRow icon={<LayoutGrid size={18} />} label={t("pm.board")} next modal={modal}
        action={() => openBoard({ workspaceId: agent.workspaceId, tabId: agent.tabId })} />
    </MenuGroup>
    {split && !layout?.zoomed && (caps.resize_pane || caps.swap_pane) && <details className="pane-precise">
      <summary>{t("pm.precise")}</summary>
      {caps.resize_pane && pane && <MenuGroup className="pane-layout-resize">
        {([["layout.width", "width", "form.narrower", "form.wider", share(pane.rect.width, layout!.area.width)],
          ["layout.height", "height", "form.shorter", "form.taller", share(pane.rect.height, layout!.area.height)]] as const)
          .map(([label, axis, lessLabel, moreLabel, value]) => <MenuSetting key={label} label={t(label)}>
            <div className="menu-stepper" role="group" aria-label={t(label)}>
              <Button className="menu-stepper-btn" aria-label={t(lessLabel)} disabled={!!model.disabledReason || !step(axis, false)}
                onClick={() => { const move = step(axis, false); if (move) resize(move.request); }}>−</Button>
              <output className="menu-stepper-value" aria-live="polite">{value}</output>
              <Button className="menu-stepper-btn" aria-label={t(moreLabel)} disabled={!!model.disabledReason || !step(axis, true)}
                onClick={() => { const move = step(axis, true); if (move) resize(move.request); }}>+</Button>
            </div>
          </MenuSetting>)}
      </MenuGroup>}
      {caps.swap_pane && <MenuGroup className="pane-layout-swap">
        <div className="menu-setting-label">{t("layout.swap")}</div>
        <div className="pane-swap-grid">
          {SWAPS.map(({ direction, label, Icon }) => <Button key={direction} className="pane-swap" disabled={blocked({ kind: "swap", direction })}
            aria-label={t(label)} onClick={() => swap({ kind: "swap", direction })}><Icon size={18} aria-hidden="true" /></Button>)}
        </div>
      </MenuGroup>}
    </details>}
    <p className="pane-layout-status" role="status">{model.disabledReason || message}</p>
  </PanePage>;
}
