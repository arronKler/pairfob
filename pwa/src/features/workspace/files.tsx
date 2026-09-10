import { Fragment, useLayoutEffect, useRef } from "react";
import { useCapabilities } from "../operations/hooks";
import { liveSession } from "../computers/catalog-store";
import { t } from "../../lib/i18n";
import { workspaceBreadcrumbs, type WorkspaceEntry } from "../../lib/workspace";
import { Button, Chevron } from "../../shared/ui/primitives";
import { loadDirectory, loadWorkspaceFile } from "./actions";
import { bindWorkspaceFileActions } from "./file-actions";
import { FileIcon } from "./file-icon";
import { formatBytes, formatModified } from "./format";
import type { WorkspaceSnapshot } from "./model";

import { workspacePaneCwd } from "./store";

function FileRow({ entry, snapshot }: { entry: WorkspaceEntry; snapshot: WorkspaceSnapshot }) {
  const row = useRef<HTMLButtonElement>(null);
  const session = liveSession();
  const paneId = snapshot.paneId;
  const root = snapshot.descriptor?.root;
  const directory = snapshot.directory;
  const cwd = workspacePaneCwd(paneId);
  // Subscribed snapshot: a capability change rebinds the row's menu actions.
  const capabilities = useCapabilities();
  const canRename = capabilities.operationCapabilities.rename_file;
  const canDelete = capabilities.operationCapabilities.delete_file;
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
    className={`workspace-row workspace-${entry.kind}${entry.hidden ? " is-hidden" : ""}${snapshot.detailPath === entry.path ? " active" : ""}`}
    role="listitem"
    disabled={entry.kind !== "directory" && entry.kind !== "file"}
    onClick={onOpen}
  >
    <span className="workspace-entry-icon" aria-hidden="true">
      <FileIcon kind={entry.kind} name={entry.name} />
    </span>
    <span className="workspace-row-body">
      <span className="workspace-row-name">{entry.name}</span>
      {entry.kind === "file" && <span className="workspace-row-meta">{`${formatBytes(entry.size)} · ${formatModified(entry.modified_ms)}`}</span>}
    </span>
    <Chevron />
  </Button>;
}

export function FileList({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const reveal = snapshot.revealNav;
  return <section className={`workspace-panel${reveal ? " workspace-reveal" : ""}`}>
    <nav className="workspace-breadcrumbs" aria-label={t("workspace.files")}>
      {workspaceBreadcrumbs(snapshot.directory).map((crumb, index) => (
        <Fragment key={`${crumb.path}:${index}`}>
          {index > 0 && <span className="workspace-crumb-sep">/</span>}
          <Button className="workspace-crumb" onClick={() => loadDirectory(crumb.path)}>
            {crumb.path ? crumb.label : t("workspace.root")}
          </Button>
        </Fragment>
      ))}
    </nav>
    <div className="workspace-list" role="list">
      {snapshot.entries.map((entry) => <FileRow key={entry.path} entry={entry} snapshot={snapshot} />)}
      {!snapshot.loading && !snapshot.error && !snapshot.entries.length &&
        <p className="workspace-empty">{t("workspace.empty")}</p>}
    </div>
    {snapshot.nextCursor && (
      <Button className="workspace-more" disabled={snapshot.loadingMore} onClick={() => loadDirectory(snapshot.directory, true)}>
        {snapshot.loadingMore ? t("workspace.loading") : t("workspace.loadMore")}
      </Button>
    )}
    {snapshot.directoryTruncated && <p className="workspace-limit">{t("workspace.directoryTruncated")}</p>}
  </section>;
}
