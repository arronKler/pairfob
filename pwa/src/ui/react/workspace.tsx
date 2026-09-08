import { useCallback, useState } from "react";
import type { DiffNoteTarget } from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import { render } from "../../paint";
import { app } from "../../state";
import {
  closeWorkspaceDetail,
  ensureBranches,
  isWorkspacePendingReveal,
  leaveWorkspace,
  loadGitDiff,
  loadWorkspaceFile,
  refreshWorkspace,
  showWorkspaceTab,
  workspaceModel,
} from "../../workspace";
import { AppNotice, BackButton, Button, useAppNotice } from "./chrome";
import { BranchSheet } from "./workspace-branches";
import { ChangeList } from "./workspace-changes";
import { DiffDetail, captureDiffScroll } from "./workspace-diff";
import { FileDetail } from "./workspace-file-detail";
import { FileList } from "./workspace-files";
import { branchLabel } from "./workspace-format";
import { DiffNoteEditor } from "./workspace-notes";
import { ChangePending, ListPending } from "./workspace-pending";

function workspaceBack(): void {
  if (workspaceModel.view === "browser") leaveWorkspace();
  else closeWorkspaceDetail();
}

function retryCurrent(): void {
  if (workspaceModel.view === "file" && workspaceModel.detailPath) void loadWorkspaceFile(workspaceModel.detailPath);
  else if (workspaceModel.view === "diff" && workspaceModel.detailPath) void loadGitDiff(workspaceModel.detailPath, workspaceModel.diffLayer);
  else void refreshWorkspace();
}

function navHasContent(): boolean {
  if (workspaceModel.tab === "files") return workspaceModel.entries.length > 0;
  return workspaceModel.status !== null;
}

function WorkspaceHeader({ onBranches }: { onBranches: () => void }) {
  return <header className="workspace-chrome">
    <BackButton onBack={workspaceBack} label={workspaceModel.view === "browser" ? t("workspace.back") : t("workspace.closeDetail")} />
    <div className="workspace-title">
      <strong className="workspace-name">{workspaceModel.descriptor?.name || t("workspace.title")}</strong>
      <span className="workspace-root">{workspaceModel.descriptor?.root || ""}</span>
    </div>
    <div className="workspace-actions">
      {workspaceModel.descriptor?.features.git_branches && (
        <Button className="workspace-branch" disabled={workspaceModel.loadingBranches} aria-label={t("workspace.branches")} onClick={onBranches}>
          {branchLabel()}
        </Button>
      )}
      <Button className="icon-btn workspace-refresh" aria-label={t("workspace.refresh")} disabled={workspaceModel.loading} onClick={refreshWorkspace} />
      {workspaceModel.view !== "browser" && (
        <Button className="icon-btn workspace-dismiss" aria-label={t("workspace.dismiss")} title={t("workspace.dismiss")} onClick={leaveWorkspace} />
      )}
    </div>
  </header>;
}

function WorkspaceTabs() {
  const count = workspaceModel.status?.changes.length ?? 0;
  return <div className="workspace-tabs" role="tablist">
    <Button
      className={`workspace-tab${workspaceModel.tab === "files" ? " on" : ""}`}
      role="tab"
      aria-selected={workspaceModel.tab === "files"}
      onClick={() => showWorkspaceTab("files")}
    >{t("workspace.files")}</Button>
    {workspaceModel.descriptor?.features.git_status && (
      <Button
        className={`workspace-tab${workspaceModel.tab === "changes" ? " on" : ""}`}
        role="tab"
        aria-selected={workspaceModel.tab === "changes"}
        onClick={() => showWorkspaceTab("changes")}
      >
        {t("workspace.changes")}
        {count > 0 && <span className="workspace-count">{String(count)}</span>}
      </Button>
    )}
  </div>;
}

function WorkspaceFeedback() {
  if (!workspaceModel.error) return null;
  return <div className="workspace-feedback workspace-error workspace-feedback-pane" role="alert">
    <p>{workspaceModel.error}</p>
    <Button className="btn btn-small" onClick={retryCurrent}>{t("ft.retry")}</Button>
  </div>;
}

function WorkspaceNotice() {
  const notice = useAppNotice();
  if (!notice) return null;
  return <div className="workspace-app-notice"><AppNotice /></div>;
}

function EmptyDetail() {
  return <section className="workspace-detail-empty">
    <strong>{workspaceModel.descriptor?.name || t("workspace.title")}</strong>
    <p>{workspaceModel.descriptor?.root || ""}</p>
  </section>;
}

export function WorkspaceScreen() {
  captureDiffScroll(app);
  const [noteTarget, setNoteTarget] = useState<DiffNoteTarget | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const closeNote = useCallback((changed: boolean) => {
    setNoteTarget(null);
    if (changed) render();
  }, []);
  const openBranches = useCallback(async () => {
    const branches = await ensureBranches();
    if (branches) setBranchOpen(true);
  }, []);

  const pendingNav = workspaceModel.view === "browser" && workspaceModel.loading && isWorkspacePendingReveal() && !navHasContent();

  return <>
    <div className={`workspace-shell${workspaceModel.view === "browser" ? "" : " detail"}`}>
      <WorkspaceHeader onBranches={() => void openBranches()} />
      <WorkspaceNotice />
      <div className="workspace-body">
        <aside className="workspace-nav">
          <WorkspaceTabs />
          {workspaceModel.view === "browser" && workspaceModel.error ? <WorkspaceFeedback />
            : pendingNav ? (workspaceModel.tab === "files" ? <ListPending /> : <ChangePending />)
            : workspaceModel.tab === "files" ? <FileList />
            : <ChangeList />}
        </aside>
        <main className="workspace-main">
          {workspaceModel.view === "file" ? <FileDetail />
            : workspaceModel.view === "diff" ? <DiffDetail onEditNote={setNoteTarget} />
            : <EmptyDetail />}
        </main>
      </div>
    </div>
    {noteTarget && <DiffNoteEditor target={noteTarget} onClose={closeNote} />}
    {branchOpen && workspaceModel.branches && <BranchSheet branches={workspaceModel.branches} onClose={() => setBranchOpen(false)} />}
  </>;
}
