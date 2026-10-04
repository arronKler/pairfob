import { ChevronRight, Columns2, Copy, GitBranch, Info, LayoutGrid, Pencil, Plus, RotateCw, Trash2, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AgentInformation } from "./agent-information";
import { PaneDisplaySettings, PaneModeSetting } from "./pane-menu-settings";
import { NewTabPage, RenamePage, SplitPage } from "./pane-menu-pages";
import { WorktreePage, worktreeBranch } from "./pane-worktree-pages";
import { PaneLayoutPage, useTabLayout } from "./pane-layout-page";
import { useStatusUnverifiable } from "./session-chrome";
import { useCapabilities } from "../../operations/hooks";
import { liveSession } from "../../computers/catalog-store";
import { selectedAgent } from "../../dashboard/catalog-store";
import { useDashboard } from "../../dashboard/hooks";
import { usePreferences } from "../../settings/hooks";
import { isAgentChat, isFullTerminal, openPaneId, livePaneText } from "../session-store";
import { paneTermMode } from "../../settings/preferences-store";
import { agentStatusLabel, agentTitle } from "../../../lib/dashboard";
import { parseAnsi } from "../../../lib/ansi";
import { t } from "../../../lib/i18n";
import type { DashboardAgentCard as AgentCard } from "../../../lib/dashboard";
import { closePaneConfirmed, layoutSelectedPane, paneIsRunning } from "../../../features/operations/controller";
import { fullTerminalScreenText, retryFullTerminal } from "../full-terminal/full-terminal";
import { showActionSheet, type ActionSheetController } from "../../../shared/ui/overlay/action-sheet";
import { MenuGroup, MenuRow, MenuTile, MenuTiles } from "../../../shared/ui/overlay/menu-controls";
import { useSheetNav, type SheetNav } from "../../../shared/ui/overlay/sheet-stack";
import { AgentAvatar, Button } from "../../../shared/ui/primitives";
import { PanePage } from "./pane-page";

export function fillSelectedPane(): void { void layoutSelectedPane("zoom"); }

type MenuContext = { modal: ActionSheetController; agent: AgentCard | undefined; full: boolean; chat: boolean };

/** Copy the screen as plain text; the count is what the reader sees confirmed. */
async function copyScreenLines(paneId: string): Promise<number | null> {
  const full = isFullTerminal();
  const text = full ? fullTerminalScreenText(paneId) : livePaneText();
  const lines = full ? text.split("\n") : parseAnsi(text).map((line) => line.text);
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  if (!lines.length) return 0;
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    return lines.length;
  } catch {
    return null;
  }
}

/** A row that opens a page, with its current value on the trailing side. */
function PageRow({ icon, label, value, onClick }: { icon: ReactNode; label: string; value?: string; onClick: () => void }) {
  return <Button className="menu-row pane-page-row" onClick={onClick}>
    <span className="menu-row-icon" aria-hidden="true">{icon}</span>
    <span className="menu-row-label">{label}</span>
    {value ? <span className="pane-row-value">{value}</span> : null}
    <ChevronRight className="menu-row-next" size={18} aria-hidden="true" />
  </Button>;
}

/** Who this sheet acts on, as the list card and the header name it; tapping the path copies it. */
function IdentityHead({ modal, agent, onCopied }: { modal: ActionSheetController; agent: AgentCard; onCopied: (text: string) => void }) {
  const { listGroup } = usePreferences();
  const stale = useStatusUnverifiable();
  const current = useDashboard().agents.find((item) => item.paneId === agent.paneId) ?? agent;
  const status = current.agent ? (stale ? t("status.unverifiable") : agentStatusLabel(current)) : "";
  const path = current.cwd;
  const copy = async () => {
    try { await navigator.clipboard.writeText(path); onCopied(t("pm.pathCopied")); } catch { onCopied(t("err.copyDenied")); }
  };
  return <div className="pane-head">
    <AgentAvatar kind={current.agent} size="lg" status={current.agent ? (stale ? "unknown" : current.status) : undefined} />
    <div className="pane-head-id">
      <b>{agentTitle(current, listGroup)}</b>
      {path ? <Button className="pane-head-path" aria-label={t("pm.copyPathAria", { path })} onClick={() => void copy()}>
        <Copy size={12} aria-hidden="true" /><span>{path}</span></Button> : null}
      {status ? <span className={`pane-head-status is-${stale ? "unknown" : current.status}`}>{status}</span> : null}
    </div>
    <Button className="icon-btn pane-head-close" aria-label={t("close")} onClick={modal.dismiss}><X size={18} aria-hidden="true" /></Button>
  </div>;
}

/**
 * Closing asks in place: the subject, what closing does and, while an agent
 * is still busy, a louder warning. No dialog stacked on the sheet.
 */
function CloseZone({ modal, agent }: { modal: ActionSheetController; agent: AgentCard }) {
  const [asking, setAsking] = useState(false);
  const { listGroup } = usePreferences();
  const confirm = useRef<HTMLDivElement>(null);
  // The zone sits at the foot of a tall sheet: without this the question opens
  // below the fold on a phone and the tap looks like it did nothing.
  useLayoutEffect(() => {
    if (asking) confirm.current?.scrollIntoView?.({ block: "nearest" });
  }, [asking]);
  return <MenuGroup className="menu-danger-zone">
    <MenuRow icon={<Trash2 size={18} />} label={t("pm.closePane")} danger onClick={() => setAsking((value) => !value)} />
    {asking && <div ref={confirm} className="pane-confirm" role="group" aria-label={t("confirm.closePaneTitle")}>
      <div className="pane-confirm-subject">
        <AgentAvatar kind={agent.agent} status={agent.agent ? agent.status : undefined} />
        <span><b>{agentTitle(agent, listGroup)}</b>{agent.cwd ? <small>{agent.cwd}</small> : null}</span>
      </div>
      <p>{t("confirm.closePaneEffect")}</p>
      {paneIsRunning(agent) ? <p className="pane-confirm-warn">{t("confirm.closeRunning")}</p> : null}
      <div className="pane-confirm-actions">
        <Button className="btn" onClick={() => setAsking(false)}>{t("cancel")}</Button>
        <Button className="btn btn-danger" data-autofocus="" onClick={() => modal.close(() => closePaneConfirmed(agent))}>{t("pm.closePane")}</Button>
      </div>
    </div>}
  </MenuGroup>;
}

function pushPage(nav: SheetNav, key: string, title: string, render: () => ReactNode): void {
  nav.push({ key, title, render });
}

/**
 * The pane sheet, top to bottom: who it acts on, the mode, four frequent
 * actions, input and display settings that apply in place, the session's
 * pages, and closing on its own at the end. Every follow-up is a page pushed
 * inside this one sheet.
 */
function PaneMenu({ modal, agent, full, chat }: MenuContext) {
  const nav = useSheetNav()!;
  const caps = useCapabilities().operationCapabilities;
  const [status, setStatus] = useState("");
  const [copying, setCopying] = useState(false);
  const [copyOwner] = useState(() => ({ paneId: openPaneId(), session: liveSession() }));
  const layout = useTabLayout(agent);
  const worktrees = caps.list_worktrees || caps.create_worktree || caps.open_worktree;
  const session = liveSession();
  const copy = async () => {
    if (openPaneId() !== copyOwner.paneId || liveSession() !== copyOwner.session || isAgentChat()) {
      setStatus(t("pm.copyChanged"));
      return;
    }
    setCopying(true);
    const lines = await copyScreenLines(copyOwner.paneId);
    setCopying(false);
    setStatus(lines === null ? t("err.copyDenied") : lines === 0 ? t("pm.copyEmpty") : t("pm.copiedLines", { n: String(lines) }));
  };
  const layoutValue = !layout ? "" : layout.zoomed ? t("pm.layoutZoomed") : t("pm.layoutCells", { n: String(layout.panes.length) });
  return <PanePage className="pane-menu-root">
    {agent && <IdentityHead modal={modal} agent={agent} onCopied={setStatus} />}
    <PaneModeSetting modal={modal} mode={paneTermMode(openPaneId())} />
    <MenuTiles>
      {!chat && <MenuTile icon={<Copy size={22} />} label={t("pm.tileCopy")} aria={t("menu.copyScreen")} disabled={copying} onClick={() => void copy()} />}
      {caps.create_tab && agent && <MenuTile icon={<Plus size={22} />} label={t("pm.tileNewTab")} aria={t("menu.newTab")}
        onClick={() => pushPage(nav, "tab", t("pm.newTabTitle"), () => <NewTabPage modal={modal} agent={agent} />)} />}
      {caps.split_pane && agent && <MenuTile icon={<Columns2 size={22} />} label={t("pm.tileSplit")} aria={t("menu.split")}
        onClick={() => pushPage(nav, "split", t("pm.splitTitle"), () => <SplitPage modal={modal} agent={agent} />)} />}
      {agent && <MenuTile icon={<Pencil size={22} />} label={t("pm.tileRename")} aria={t("menu.renamePane")}
        onClick={() => pushPage(nav, "rename", t("pm.renameTitle"), () => <RenamePage modal={modal} agent={agent} />)} />}
    </MenuTiles>
    <p className="pane-menu-status" role="status">{status || (!chat ? t("pm.copyHint") : "")}</p>
    {!chat && <h3 className="pane-group-title">{t("pm.groupDisplay")}</h3>}
    <PaneDisplaySettings modal={modal} full={full} chat={chat} />
    <h3 className="pane-group-title">{t("pm.groupSession")}</h3>
    <MenuGroup label={t("pm.groupSession")}>
      {full && <MenuRow icon={<RotateCw size={18} />} label={t("pane.reconnect")} modal={modal} action={retryFullTerminal} />}
      {agent && <PageRow icon={<LayoutGrid size={18} />} label={t("pm.layout")} value={layoutValue}
        onClick={() => pushPage(nav, "layout", t("pm.layout"), () => <PaneLayoutPage modal={modal} agent={agent} />)} />}
      {worktrees && agent && <PageRow icon={<GitBranch size={18} />} label={t("menu.worktree")} value={worktreeBranch(agent)}
        onClick={() => pushPage(nav, "worktree", t("menu.worktree"), () => <WorktreePage modal={modal} agent={agent} />)} />}
      {agent && session && <PageRow icon={<Info size={18} />} label={t("pm.agentInfo")}
        onClick={() => pushPage(nav, "info", t("pm.agentInfo"), () => <AgentInformation agent={agent} session={session} />)} />}
    </MenuGroup>
    {agent && <CloseZone modal={modal} agent={agent} />}
  </PanePage>;
}

export function openPaneMenu(): void {
  const agent = selectedAgent();
  const full = isFullTerminal();
  const chat = isAgentChat();
  showActionSheet(t("pane.menuTitle"), modal => <PaneMenu modal={modal} agent={agent} full={full} chat={chat} />,
    { className: "pane-menu-sheet" });
}
