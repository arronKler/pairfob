import { ChevronDown, FolderOpen, List, Plus } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import type { GitBranch } from "../../lib/workspace";
import { t } from "../../lib/i18n";
import { createSelectedWorktree, listSelectedWorktrees, openSelectedWorktree } from "../../features/operations/controller";
import { runDialogStep } from "../../features/operations/worktree-steps";
import { MenuGroup, MenuRow } from "../../shared/ui/overlay/menu-controls";
import { Button } from "../../shared/ui/primitives";
import { showError, showStatus } from "../../app/notices-store";
import { capabilityEnabled } from "../operations/capabilities-store";
import { WorkspaceDialog } from "./modal";
import { getWorkspaceSnapshot } from "./store";
import type { WorkspaceSnapshot } from "./model";

function BranchRow({ branch }: { branch: GitBranch }) {
  return <div className={`workspace-branch-row${branch.current ? " current" : ""}`}>
    <span className="workspace-branch-body">
      <strong>{branch.name}</strong>
      {branch.upstream ? <span className="workspace-row-meta">{branch.upstream}</span> : null}
    </span>
    {branch.current ? <span className="workspace-current">{t("workspace.current")}</span> : null}
  </div>;
}

function Section({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return <section className="workspace-branch-section">
    <h3 className="workspace-branch-section-title"><span>{title}</span>{aside && <small>{aside}</small>}</h3>
    {children}
  </section>;
}

async function copyRoot(root: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(root);
    showStatus(t("workspace.copied"));
  } catch {
    showError(t("workspace.copyFailed", { path: root }));
  }
}

/**
 * Read-only branches plus the worktree actions that are the safe way to switch
 * work. Actions sit first; remote branches start folded because they are the
 * long list. Picking an action is a step of this dialog (`runDialogStep`): it
 * opens over the dialog, and putting it away comes back here, under a mouse and
 * on a finger's sheet alike.
 */
export function BranchSheet({ branches, onClose }: { branches: NonNullable<WorkspaceSnapshot["branches"]>; onClose: () => void }) {
  const dismiss = useCallback(() => onClose(), [onClose]);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const root = getWorkspaceSnapshot().descriptor?.root ?? "";
  const local = branches.items.filter((branch) => branch.kind === "local");
  const remote = branches.items.filter((branch) => branch.kind === "remote");
  const worktreeActions = [
    ...(capabilityEnabled("list_worktrees") ? [{ label: t("menu.worktrees"), icon: <List size={18} />, run: listSelectedWorktrees }] : []),
    ...(capabilityEnabled("create_worktree") ? [{ label: t("menu.newWorktree"), icon: <Plus size={18} />, run: createSelectedWorktree }] : []),
    ...(capabilityEnabled("open_worktree") ? [{ label: t("menu.openWorktree"), icon: <FolderOpen size={18} />, run: openSelectedWorktree }] : []),
  ];
  return <WorkspaceDialog
    className="modal sheet workspace-branch-sheet"
    titleId="workspace-branch-title"
    title={t("workspace.branches")}
    sheet
    onDismiss={dismiss}
  >
    {root && <div className="workspace-root-card">
      <code>{root}</code>
      <Button className="workspace-root-copy" onClick={() => void copyRoot(root)}>{t("workspace.copy")}</Button>
    </div>}
    {worktreeActions.length > 0 && <Section title={t("workspace.worktreeSection")}>
      <MenuGroup>
        {worktreeActions.map((action) => <MenuRow key={action.label} icon={action.icon} label={action.label} next
          onClick={() => runDialogStep(action.run, onClose)} />)}
      </MenuGroup>
    </Section>}
    <Section title={t("workspace.localBranches")} aside={t("workspace.readOnly")}>
      {local.length > 0
        ? <div className="workspace-branch-list">{local.map((branch) => <BranchRow key={`local:${branch.name}`} branch={branch} />)}</div>
        : <p className="empty-sub">{t("workspace.noBranches")}</p>}
    </Section>
    {remote.length > 0 && <Section title={t("workspace.remoteBranches")}>
      <div className="workspace-branch-list">
        <Button className="workspace-remote-toggle" aria-expanded={remoteOpen} onClick={() => setRemoteOpen((open) => !open)}>
          <span>{remoteOpen ? t("workspace.hideRemote") : t("workspace.showRemote", { count: remote.length })}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </Button>
        {remoteOpen && remote.map((branch) => <BranchRow key={`remote:${branch.name}`} branch={branch} />)}
      </div>
    </Section>}
  </WorkspaceDialog>;
}
