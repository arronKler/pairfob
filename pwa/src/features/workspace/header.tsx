import { ChevronDown, Ellipsis, GitBranch, RefreshCw } from "lucide-react";
import { useSyncExternalStore } from "react";
import { ROOMY_QUERY } from "../../app/viewport";
import { t } from "../../lib/i18n";
import { BackButton, Button } from "../../shared/ui/primitives";
import { closeWorkspaceDetail, leaveWorkspace, refreshWorkspace } from "./actions";
import { openDetailMenu } from "./detail-menu";
import { backLabel } from "./format";
import type { WorkspaceSnapshot } from "./model";

/** `main ↑2 ↓1`, or `HEAD 1a2b3c4d` when detached. */
function branchParts(snapshot: WorkspaceSnapshot): { branch: string; sync: string } | null {
  const git = snapshot.descriptor?.git;
  const status = snapshot.status;
  if (!git && !status) return null;
  const name = status ? status.branch : git?.branch ?? null;
  const head = status?.head || git?.head || "";
  const branch = name || `${t("workspace.detached")} ${head.slice(0, 8)}`;
  const sync = [status?.ahead ? `↑${status.ahead}` : "", status?.behind ? `↓${status.behind}` : ""].filter(Boolean).join(" ");
  return { branch, sync };
}

/** The repository's name over its branch and root; a button to the branch sheet when the daemon lists branches. */
export function RepoTitle({ snapshot, onBranches }: { snapshot: WorkspaceSnapshot; onBranches: () => void }) {
  const name = snapshot.descriptor?.name || t("workspace.title");
  const root = snapshot.descriptor?.root || "";
  const parts = branchParts(snapshot);
  const line = <span className="workspace-subline">
    {parts && <>
      <GitBranch className="workspace-subline-icon" size={12} aria-hidden="true" />
      <span className="workspace-subline-branch">{parts.branch}</span>
      {parts.sync && <span className="workspace-subline-sync">{parts.sync}</span>}
      <span className="workspace-subline-sep" aria-hidden="true">·</span>
    </>}
    <span className="workspace-root">{root}</span>
  </span>;
  if (!snapshot.descriptor?.features.git_branches) {
    return <div className="workspace-title workspace-repo-title"><strong className="workspace-name">{name}</strong>{line}</div>;
  }
  return <Button className="workspace-title workspace-repo-title workspace-branch is-button" disabled={snapshot.loadingBranches}
    aria-label={t("workspace.openBranches", { name, branch: parts?.branch ?? "" })} aria-haspopup="dialog" onClick={onBranches}>
    <strong className="workspace-name">{name}</strong>
    <span className="workspace-subline-row">{line}<ChevronDown className="workspace-subline-open" size={12} aria-hidden="true" /></span>
  </Button>;
}

function DetailTitle({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const path = snapshot.file?.path || snapshot.diff?.path || snapshot.detailPath;
  const cut = path.lastIndexOf("/");
  return <div className="workspace-title workspace-detail-title">
    <strong className="workspace-name">{cut >= 0 ? path.slice(cut + 1) : path}</strong>
    <span className="workspace-root">{cut >= 0 ? path.slice(0, cut) : t("workspace.repoRoot")}</span>
  </div>;
}

function subscribeSideBySide(listener: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(ROOMY_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

const sideBySide = (): boolean => typeof window.matchMedia === "function" && window.matchMedia(ROOMY_QUERY).matches;

/**
 * The screen shows the list and the open file together. The style sheet makes
 * that arrangement on the same query (`workspace.scss`), so the header and the
 * layout change together.
 */
function useSideBySide(): boolean {
  return useSyncExternalStore(subscribeSideBySide, sideBySide);
}

/**
 * Browse: back to the session, the repository title (opens branches), refresh.
 * Detail on a phone: back to the list, the file's name over its folder, ⋯.
 * Side by side the list never left, so back has only the session to go to;
 * the header keeps the repository and puts ⋯ on the detail pane.
 */
export function WorkspaceHeader({ snapshot, onBranches }: { snapshot: WorkspaceSnapshot; onBranches: () => void }) {
  const detail = snapshot.view !== "browser";
  const together = useSideBySide();
  /** One pane at a time and the detail is on top: back uncovers the list. */
  const stacked = detail && !together;
  return <header className={`workspace-chrome${detail ? " is-detail" : ""}`}>
    <BackButton onBack={() => stacked ? closeWorkspaceDetail() : leaveWorkspace()}
      label={stacked ? t("workspace.closeDetail") : backLabel(snapshot.returnView)} />
    <RepoTitle snapshot={snapshot} onBranches={onBranches} />
    {detail && <DetailTitle snapshot={snapshot} />}
    <div className="workspace-actions">
      <Button className="icon-btn workspace-refresh" aria-label={t("workspace.refresh")} disabled={snapshot.loading} onClick={refreshWorkspace}>
        <RefreshCw size={18} aria-hidden="true" />
      </Button>
      {detail && <Button className="icon-btn workspace-detail-more" aria-label={t("workspace.moreActions")} aria-haspopup="dialog"
        onClick={() => openDetailMenu()}><Ellipsis size={20} aria-hidden="true" /></Button>}
    </div>
  </header>;
}
