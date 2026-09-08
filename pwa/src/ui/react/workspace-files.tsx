import { Fragment, useLayoutEffect, useRef } from "react";
import { t } from "../../lib/i18n";
import { workspaceBreadcrumbs, type WorkspaceEntry } from "../../lib/workspace";
import { state } from "../../state";
import { loadDirectory, loadWorkspaceFile, workspaceModel } from "../../workspace";
import { bindWorkspaceFileActions } from "../workspace-file-actions";
import { Button, Chevron } from "./chrome";
import { consumeReveal } from "./workspace-pending";
import { formatBytes, formatModified } from "./workspace-format";

function FileRow({ entry }: { entry: WorkspaceEntry }) {
  const row = useRef<HTMLButtonElement>(null);
  const session = state.live;
  const { paneId, descriptor, directory } = workspaceModel;
  const root = descriptor?.root;
  const cwd = state.agents.find(pane => pane.paneId === paneId)?.cwd;
  const canRename = state.operationCapabilities.rename_file;
  const canDelete = state.operationCapabilities.delete_file;
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    return bindWorkspaceFileActions(el, entry);
  }, [entry, session, paneId, root, directory, cwd, canRename, canDelete]);
  const onOpen = () => {
    if (entry.kind === "directory") void loadDirectory(entry.path);
    else if (entry.kind === "file") void loadWorkspaceFile(entry.path);
  };
  return <Button
    ref={row}
    className={`workspace-row workspace-${entry.kind}${entry.hidden ? " is-hidden" : ""}`}
    role="listitem"
    disabled={entry.kind !== "directory" && entry.kind !== "file"}
    onClick={onOpen}
  >
    <span className="workspace-entry-icon" aria-hidden="true" />
    <span className="workspace-row-body">
      <span className="workspace-row-name">{entry.name}</span>
      {entry.kind === "file" && <span className="workspace-row-meta">{`${formatBytes(entry.size)} · ${formatModified(entry.modified_ms)}`}</span>}
    </span>
    <Chevron />
  </Button>;
}

export function FileList() {
  const reveal = consumeReveal("nav");
  return <section className={`workspace-panel${reveal ? " workspace-reveal" : ""}`}>
    <nav className="workspace-breadcrumbs" aria-label={t("workspace.files")}>
      {workspaceBreadcrumbs(workspaceModel.directory).map((crumb, index) => (
        <Fragment key={`${crumb.path}:${index}`}>
          {index > 0 && <span className="workspace-crumb-sep">/</span>}
          <Button className="workspace-crumb" onClick={() => loadDirectory(crumb.path)}>
            {crumb.path ? crumb.label : t("workspace.root")}
          </Button>
        </Fragment>
      ))}
    </nav>
    <div className="workspace-list" role="list">
      {workspaceModel.entries.map((entry) => <FileRow key={entry.path} entry={entry} />)}
      {!workspaceModel.loading && !workspaceModel.error && !workspaceModel.entries.length &&
        <p className="workspace-empty">{t("workspace.empty")}</p>}
    </div>
    {workspaceModel.nextCursor && (
      <Button className="workspace-more" disabled={workspaceModel.loadingMore} onClick={() => loadDirectory(workspaceModel.directory, true)}>
        {workspaceModel.loadingMore ? t("workspace.loading") : t("workspace.loadMore")}
      </Button>
    )}
    {workspaceModel.directoryTruncated && <p className="workspace-limit">{t("workspace.directoryTruncated")}</p>}
  </section>;
}
