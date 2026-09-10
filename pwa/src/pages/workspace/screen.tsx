import { useCallback, useState } from "react";
import type { DiffNoteTarget } from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import { AppNotice, useAppNotice } from "../../app/notice";
import { BackButton, Button } from "../../shared/ui/primitives";
import {
  bumpWorkspaceNotes,
  closeWorkspaceDetail,
  ensureBranches,
  leaveWorkspace,
  loadGitDiff,
  loadWorkspaceFile,
  refreshWorkspace,
  showWorkspaceTab,
  useWorkspace,
  type WorkspaceSnapshot,
} from "../../features/workspace";
import { BranchSheet } from "../../features/workspace/branches";
import { ChangeList } from "../../features/workspace/changes";
import { DiffDetail } from "../../features/workspace/diff";
import { FileDetail } from "../../features/workspace/file-detail";
import { FileList } from "../../features/workspace/files";
import { branchLabel } from "../../features/workspace/format";
import { DiffNoteEditor } from "../../features/workspace/notes";
import { ChangePending, ListPending } from "../../features/workspace/pending";

function workspaceBack(snapshot: WorkspaceSnapshot): void {
  if (snapshot.view === "browser") leaveWorkspace();
  else closeWorkspaceDetail();
}

function retryCurrent(snapshot: WorkspaceSnapshot): void {
  if (snapshot.view === "file" && snapshot.detailPath) void loadWorkspaceFile(snapshot.detailPath);
  else if (snapshot.view === "diff" && snapshot.detailPath) void loadGitDiff(snapshot.detailPath, snapshot.diffLayer);
  else void refreshWorkspace();
}

function navHasContent(snapshot: WorkspaceSnapshot): boolean {
  if (snapshot.tab === "files") return snapshot.entries.length > 0;
  return snapshot.status !== null;
}

function WorkspaceHeader({ snapshot, onBranches }: { snapshot: WorkspaceSnapshot; onBranches: () => void }) {
  return <header className="workspace-chrome">
    <BackButton onBack={() => workspaceBack(snapshot)} label={snapshot.view === "browser" ? t("workspace.back") : t("workspace.closeDetail")} />
    <div className="workspace-title">
      <strong className="workspace-name">{snapshot.descriptor?.name || t("workspace.title")}</strong>
      <span className="workspace-root">{snapshot.descriptor?.root || ""}</span>
    </div>
    <div className="workspace-actions">
      {snapshot.descriptor?.features.git_branches && (
        <Button className="workspace-branch" disabled={snapshot.loadingBranches} aria-label={t("workspace.branches")} onClick={onBranches}>
          {branchLabel(snapshot.descriptor?.git)}
        </Button>
      )}
      <Button className="icon-btn workspace-refresh" aria-label={t("workspace.refresh")} disabled={snapshot.loading} onClick={refreshWorkspace} />
      {snapshot.view !== "browser" && (
        <Button className="icon-btn workspace-dismiss" aria-label={t("workspace.dismiss")} title={t("workspace.dismiss")} onClick={leaveWorkspace} />
      )}
    </div>
  </header>;
}

function WorkspaceTabs({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const count = snapshot.status?.changes.length ?? 0;
  return <div className="workspace-tabs" role="tablist">
    <Button
      className={`workspace-tab${snapshot.tab === "files" ? " on" : ""}`}
      role="tab"
      aria-selected={snapshot.tab === "files"}
      onClick={() => showWorkspaceTab("files")}
    >{t("workspace.files")}</Button>
    {snapshot.descriptor?.features.git_status && (
      <Button
        className={`workspace-tab${snapshot.tab === "changes" ? " on" : ""}`}
        role="tab"
        aria-selected={snapshot.tab === "changes"}
        onClick={() => showWorkspaceTab("changes")}
      >
        {t("workspace.changes")}
        {count > 0 && <span className="workspace-count">{String(count)}</span>}
      </Button>
    )}
  </div>;
}

function WorkspaceFeedback({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  if (!snapshot.error) return null;
  return <div className="workspace-feedback workspace-error workspace-feedback-pane" role="alert">
    <p>{snapshot.error}</p>
    <Button className="btn btn-small" onClick={() => retryCurrent(snapshot)}>{t("ft.retry")}</Button>
  </div>;
}

function WorkspaceNotice() {
  const notice = useAppNotice();
  if (!notice) return null;
  return <div className="workspace-app-notice"><AppNotice /></div>;
}

function EmptyDetail({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return <section className="workspace-detail-empty">
    <strong>{snapshot.descriptor?.name || t("workspace.title")}</strong>
    <p>{snapshot.descriptor?.root || ""}</p>
  </section>;
}

export function WorkspaceScreen() {
  const snapshot = useWorkspace();
  const [noteTarget, setNoteTarget] = useState<DiffNoteTarget | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const closeNote = useCallback((changed: boolean) => {
    setNoteTarget(null);
    if (changed) bumpWorkspaceNotes();
  }, []);
  const openBranches = useCallback(async () => {
    const branches = await ensureBranches();
    if (branches) setBranchOpen(true);
  }, []);

  const pendingNav = snapshot.view === "browser" && snapshot.loading && snapshot.pendingReveal && !navHasContent(snapshot);

  return <>
    <div className={`workspace-shell${snapshot.view === "browser" ? "" : " detail"}`}>
      <WorkspaceHeader snapshot={snapshot} onBranches={() => void openBranches()} />
      <WorkspaceNotice />
      <div className="workspace-body">
        <aside className="workspace-nav">
          <WorkspaceTabs snapshot={snapshot} />
          {snapshot.view === "browser" && snapshot.error ? <WorkspaceFeedback snapshot={snapshot} />
            : pendingNav ? (snapshot.tab === "files" ? <ListPending /> : <ChangePending />)
            : snapshot.tab === "files" ? <FileList snapshot={snapshot} />
            : <ChangeList snapshot={snapshot} />}
        </aside>
        <main className="workspace-main">
          {snapshot.view === "file" ? <FileDetail snapshot={snapshot} />
            : snapshot.view === "diff" ? <DiffDetail snapshot={snapshot} onEditNote={setNoteTarget} />
            : <EmptyDetail snapshot={snapshot} />}
        </main>
      </div>
    </div>
    {noteTarget && <DiffNoteEditor target={noteTarget} onClose={closeNote} />}
    {branchOpen && snapshot.branches && <BranchSheet branches={snapshot.branches} onClose={() => setBranchOpen(false)} />}
  </>;
}
