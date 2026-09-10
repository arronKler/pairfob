import { useCallback } from "react";
import type { GitBranch } from "../../lib/workspace";
import { t } from "../../lib/i18n";
import { createSelectedWorktree, listSelectedWorktrees, openSelectedWorktree } from "../../features/operations/controller";
import { capabilityEnabled } from "../operations/capabilities-store";
import { SheetItem, WorkspaceDialog } from "./modal";
import type { WorkspaceSnapshot } from "./model";

function BranchRows({ branches, kind }: { branches: readonly GitBranch[]; kind: GitBranch["kind"] }) {
  return branches.filter((branch) => branch.kind === kind).map((branch) => (
    <div key={`${kind}:${branch.name}`} className={`workspace-branch-row${branch.current ? " current" : ""}`}>
      <span className="workspace-branch-body">
        <strong>{branch.name}</strong>
        {branch.upstream ? <span className="workspace-row-meta">{branch.upstream}</span> : null}
      </span>
      {branch.current ? <span className="workspace-current">{t("workspace.current")}</span> : null}
    </div>
  ));
}

export function BranchSheet({ branches, onClose }: { branches: NonNullable<WorkspaceSnapshot["branches"]>; onClose: () => void }) {
  const dismiss = useCallback(() => onClose(), [onClose]);
  const local = branches.items.filter((branch) => branch.kind === "local");
  const remote = branches.items.filter((branch) => branch.kind === "remote");
  const worktreeActions = [
    ...(capabilityEnabled("list_worktrees") ? [{ label: t("menu.worktrees"), run: listSelectedWorktrees }] : []),
    ...(capabilityEnabled("create_worktree") ? [{ label: t("menu.newWorktree"), run: createSelectedWorktree }] : []),
    ...(capabilityEnabled("open_worktree") ? [{ label: t("menu.openWorktree"), run: openSelectedWorktree }] : []),
  ];
  return <WorkspaceDialog
    className="modal sheet"
    titleId="workspace-branch-title"
    title={t("workspace.branches")}
    sheet
    onDismiss={dismiss}
  >
    <p className="empty-sub">{t("workspace.branchReadOnly")}</p>
    {local.length > 0 && <h3 className="menu-section-title">{t("workspace.localBranches")}</h3>}
    <BranchRows branches={branches.items} kind="local" />
    {remote.length > 0 && <h3 className="menu-section-title">{t("workspace.remoteBranches")}</h3>}
    <BranchRows branches={branches.items} kind="remote" />
    {!local.length && !remote.length && <p className="empty-sub">{t("workspace.noBranches")}</p>}
    {worktreeActions.length > 0 && <h3 className="menu-section-title">{t("workspace.worktreeActions")}</h3>}
    {worktreeActions.map((action) => (
      <SheetItem key={action.label} label={action.label} onPick={() => {
        onClose();
        window.setTimeout(() => void action.run(), 0);
      }} />
    ))}
    <SheetItem label={t("cancel")} onPick={onClose} />
  </WorkspaceDialog>;
}
