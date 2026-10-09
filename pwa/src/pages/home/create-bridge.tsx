/**
 * Create bridge.
 *
 * Every "new" entry — the floating button, a workspace heading's +, the board's
 * "+ tab", a workspace menu and the empty list — opens the same create sheet.
 * This file gathers what the sheet needs from the domains when the entry is
 * pressed, and turns the reader's answer into the existing mutation, so the
 * operation owner, busy marker and "open the new pane" behavior stay the ones
 * the controller already runs. Each mutation carries its own operation id and
 * is never retried here.
 */
import { Plus } from "lucide-react";
import { useContext } from "react";
import { capabilityEnabled, advertisedAgentKinds } from "../../features/operations/capabilities-store";
import { computersStore, liveSession } from "../../features/computers/catalog-store";
import { liveAgents, selectedAgent } from "../../features/dashboard/catalog-store";
import { runtimeStore } from "../../features/connection/runtime-store";
import { boardStore } from "../../features/board/layout-store";
import { paneActivated } from "../../features/settings/preferences-store";
import { createSelectedTab, createWorktreeFrom, startNewConversation } from "../../features/operations/controller";
import { loadCreateMemory, rememberCreate } from "../../features/operations/create-memory";
import { askCreate, NEW_WORKSPACE, type CreateRequest, type CreateWorkspaceOption } from "../../features/operations/create-sheet";
import { loadLastAgentKind } from "../../features/operations/operation-form-model";
import { computerTitle } from "../../lib/computer-catalog";
import type { DashboardAgentCard } from "../../lib/dashboard";
import { t } from "../../lib/i18n";
import { MenuChoice, MenuGroup, showActionSheet, type ActionSheetController } from "../../shared/ui/overlay";
import { PopoverKindContext } from "../../shared/ui/overlay/popover-frame";
import { AgentAvatar } from "../../shared/ui/primitives";
import { currentScreen } from "../../app/navigation-store";

type Anchors = Map<string, DashboardAgentCard>;

/**
 * One anchor pane per workspace, the context first, then in the list's order:
 * the workspace the reader opened last leads, ties keep the computer's order.
 */
function workspaceChoices(first: string | undefined): { options: CreateWorkspaceOption[]; anchors: Anchors } {
  const anchors: Anchors = new Map();
  const activated = paneActivated();
  const latest = new Map<string, number>();
  for (const agent of liveAgents() as DashboardAgentCard[]) {
    if (!agent.workspaceId) continue;
    if (!anchors.has(agent.workspaceId)) anchors.set(agent.workspaceId, agent);
    latest.set(agent.workspaceId, Math.max(latest.get(agent.workspaceId) ?? 0, activated[agent.paneId] ?? 0));
  }
  const ids = [...anchors.keys()].sort((a, b) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0));
  const ordered = first && anchors.has(first) ? [first, ...ids.filter((id) => id !== first)] : ids;
  return {
    anchors,
    options: ordered.map((id) => {
      const agent = anchors.get(id)!;
      return { id, label: agent.workspaceLabel || t("workspace.unnamed"), path: agent.workspaceCwd || "" };
    }),
  };
}

/** The workspace the reader is looking at: the board's, else the open pane's. */
function contextWorkspace(): string | undefined {
  if (currentScreen() === "board") return boardStore.get().boardWorkspaceId || undefined;
  return selectedAgent()?.workspaceId || undefined;
}

function hostName(): string {
  const pair = computersStore.get().credential;
  return runtimeStore.get().herdHost || (pair ? computerTitle(pair) : "") || t("settings.currentComputer");
}

function run(request: CreateRequest, anchors: Anchors): void {
  if (request.kind === "tab") {
    const anchor = anchors.get(request.workspaceId);
    if (!anchor) return;
    rememberCreate({ kind: request.agentKind, workspaceId: request.workspaceId });
    void createSelectedTab(anchor, {
      ...(request.agentKind ? { agent_kind: request.agentKind } : {}),
      ...(request.label ? { label: request.label } : {}),
    });
  } else if (request.kind === "conversation") {
    rememberCreate({ kind: request.agentKind, cwd: request.cwd });
    void startNewConversation({
      cwd: request.cwd,
      ...(request.agentKind ? { agent_kind: request.agentKind } : {}),
      ...(request.label ? { label: request.label } : {}),
    });
  } else {
    rememberCreate({ kind: "", cwd: request.cwd });
    createWorktreeFrom({
      cwd: request.cwd,
      ...(request.branch ? { branch: request.branch } : {}),
      ...(request.base ? { base: request.base } : {}),
      ...(request.label ? { label: request.label } : {}),
    });
  }
}

/**
 * Open the create sheet; `workspaceId` preselects it, `newWorkspace` starts on a
 * new one, and `dir` also preselects that directory for it.
 */
export async function openCreateSheet(options: { workspaceId?: string; newWorkspace?: boolean; dir?: string } = {}): Promise<void> {
  if (liveSession()?.isConnected() !== true) return;
  const canCreateTab = capabilityEnabled("create_tab");
  const canCreateWorkspace = capabilityEnabled("create_conversation");
  if (!canCreateTab && !canCreateWorkspace) return;
  const { options: workspaces, anchors } = workspaceChoices(options.workspaceId ?? contextWorkspace());
  const kinds = [...advertisedAgentKinds()];
  const request = await askCreate({
    host: hostName(),
    workspaces,
    initial: options.newWorkspace || options.dir || !workspaces.length ? NEW_WORKSPACE : workspaces[0].id,
    ...(options.dir ? { initialDir: options.dir } : {}),
    kinds,
    memory: loadCreateMemory(),
    lastKind: loadLastAgentKind(kinds),
    canCreateTab,
    canCreateWorkspace,
    canCreateWorktree: capabilityEnabled("create_worktree"),
  });
  // The sheet may have been open across a disconnect or a computer switch.
  if (!request || liveSession()?.isConnected() !== true) return;
  run(request, anchors);
}

type QuickCombo = { key: string; kind: string; workspace: string; create: () => void };

/**
 * The recent combinations and the way to the full sheet. As a menu its title is
 * not drawn, so the recents carry their own caption and the last row says what
 * it creates; the sheet keeps the short list under its title.
 */
function QuickCreateList({ modal, combos }: { modal: ActionSheetController; combos: QuickCombo[] }) {
  const menu = useContext(PopoverKindContext) === "menu";
  const recents = combos.map((combo) => (
    <MenuChoice key={combo.key} modal={modal} icon={<AgentAvatar kind={combo.kind} size="sm" />}
      title={combo.kind || t("create.terminal")} detail={combo.workspace} action={combo.create} />
  ));
  const more = (
    <MenuChoice modal={modal} icon={<Plus size={18} aria-hidden="true" />}
      title={t(menu ? "rail.createMore" : "create.quickMore")} action={() => openCreateSheet()} />
  );
  if (!menu) return <>{recents}{more}</>;
  return (
    <>
      <MenuGroup label={t("create.recent")}>
        <h3 className="menu-section-title" aria-hidden="true">{t("create.recent")}</h3>
        {recents}
      </MenuGroup>
      <MenuGroup>{more}</MenuGroup>
    </>
  );
}

/**
 * The last few "kind in workspace" combinations, each created in one step, plus
 * the full sheet. A hold on a create button opens it as a sheet; a mouse or the
 * keyboard on the desk gets a menu under `anchor`, or at the pointer without one.
 * With nothing to offer it is the full sheet.
 */
export function openQuickCreate(anchor?: Element | null): void {
  if (liveSession()?.isConnected() !== true) return;
  if (!capabilityEnabled("create_tab")) {
    void openCreateSheet();
    return;
  }
  const kinds = advertisedAgentKinds();
  const { options, anchors } = workspaceChoices(undefined);
  const combos = loadCreateMemory().recents.filter((combo) =>
    anchors.has(combo.workspaceId) && (combo.kind === "" || kinds.includes(combo.kind)));
  if (!combos.length) {
    void openCreateSheet();
    return;
  }
  const list = combos.map((combo): QuickCombo => ({
    key: `${combo.kind}@${combo.workspaceId}`,
    kind: combo.kind,
    workspace: options.find((item) => item.id === combo.workspaceId)!.label,
    create: () => run({ kind: "tab", workspaceId: combo.workspaceId, agentKind: combo.kind, label: "" }, anchors),
  }));
  showActionSheet(t("create.quickTitle"), (modal) => <QuickCreateList modal={modal} combos={list} />,
    { popover: "menu", anchor });
}
