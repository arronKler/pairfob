import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { loadGitDiff, loadWorkspaceFile, refreshWorkspace } from "./actions";
import { ChangeList } from "./changes";
import { FileList } from "./files";
import type { WorkspaceSnapshot } from "./model";
import { ChangePending, ListPending } from "./pending";

function retryCurrent(snapshot: WorkspaceSnapshot): void {
  if (snapshot.view === "file" && snapshot.detailPath) void loadWorkspaceFile(snapshot.detailPath);
  else if (snapshot.view === "diff" && snapshot.detailPath) void loadGitDiff(snapshot.detailPath, snapshot.diffLayer);
  else void refreshWorkspace();
}

function navHasContent(snapshot: WorkspaceSnapshot): boolean {
  if (snapshot.tab === "files") return snapshot.entries.length > 0;
  return snapshot.status !== null;
}

function WorkspaceFeedback({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  if (!snapshot.error) return null;
  return <div className="workspace-feedback workspace-error workspace-feedback-pane" role="alert">
    <p>{snapshot.error}</p>
    <Button className="btn btn-small" onClick={() => retryCurrent(snapshot)}>{t("ft.retry")}</Button>
  </div>;
}

/** A failed action over content that is still valid: say why above it, keep the list. */
function WorkspaceErrorBar({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return <div className="workspace-feedback workspace-error workspace-feedback-bar" role="alert">
    <p>{snapshot.error}</p>
    <Button className="btn btn-small" onClick={() => retryCurrent(snapshot)}>{t("workspace.refresh")}</Button>
  </div>;
}

/**
 * The list the current tab shows, or what stands in for it: the failure when
 * there is nothing to keep, the skeleton while a slow first read is pending.
 * The workspace screen's navigator and the inspector's list are both this.
 */
export function WorkspaceBrowser({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const browsing = snapshot.view === "browser";
  const pending = browsing && snapshot.loading && snapshot.pendingReveal && !navHasContent(snapshot);
  return <>
    {browsing && snapshot.error && navHasContent(snapshot) && <WorkspaceErrorBar snapshot={snapshot} />}
    {browsing && snapshot.error && !navHasContent(snapshot) ? <WorkspaceFeedback snapshot={snapshot} />
      : pending ? (snapshot.tab === "files" ? <ListPending /> : <ChangePending />)
      : snapshot.tab === "files" ? <FileList snapshot={snapshot} />
      : <ChangeList snapshot={snapshot} />}
  </>;
}
