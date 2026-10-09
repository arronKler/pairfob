import { ArrowUp, Ellipsis, Folder } from "lucide-react";
import { Fragment, useLayoutEffect, useRef } from "react";
import { useCapabilities } from "../operations/hooks";
import { liveSession } from "../computers/catalog-store";
import { t } from "../../lib/i18n";
import { workspaceBreadcrumbs, type WorkspaceEntry } from "../../lib/workspace";
import { showActionSheet } from "../../shared/ui/overlay/action-sheet";
import { MenuGroup, MenuRow } from "../../shared/ui/overlay/menu-controls";
import { Button, Chevron } from "../../shared/ui/primitives";
import { loadDirectory, loadWorkspaceFile } from "./actions";
import { guardBackPress } from "./back-press";
import { bindWorkspaceFileActions, openWorkspaceFileMenu, workspaceMutationTarget } from "./file-actions";
import { FileIcon } from "./file-icon";
import { formatBytes, formatModified } from "./format";
import { DirMark, GitMark } from "./git-mark";
import { foldBreadcrumbs, gitMarks, type GitMarks } from "./git-marks";
import type { WorkspaceSnapshot } from "./model";

import { workspacePaneCwd } from "./store";
import { ownFilesDialog } from "./surface-dialogs";

function FileRow({ entry, snapshot, marks }: { entry: WorkspaceEntry; snapshot: WorkspaceSnapshot; marks: GitMarks }) {
  const open = useRef<HTMLButtonElement>(null);
  const session = liveSession();
  const paneId = snapshot.paneId;
  const root = snapshot.descriptor?.root;
  const directory = snapshot.directory;
  const cwd = workspacePaneCwd(paneId);
  // Subscribed snapshot: capability and busy changes rebind the row's menu.
  const capabilities = useCapabilities();
  const busy = capabilities.operationBusy;
  const canRename = capabilities.operationCapabilities.rename_file;
  const canDelete = capabilities.operationCapabilities.delete_file;
  const isFile = entry.kind === "file";
  useLayoutEffect(() => {
    const el = open.current;
    if (!el) return;
    return bindWorkspaceFileActions(el, entry);
  }, [entry, session, paneId, root, directory, cwd, canRename, canDelete]);
  const onOpen = () => {
    if (entry.kind === "directory") void loadDirectory(entry.path);
    else if (isFile) void loadWorkspaceFile(entry.path);
  };
  const mark = isFile ? marks.files.get(entry.path) : undefined;
  const changedBelow = entry.kind === "directory" ? marks.dirs.get(entry.path) ?? 0 : 0;
  const pending = busy && workspaceMutationTarget() === entry.path;
  const classes = ["workspace-row", `workspace-${entry.kind}`, entry.hidden && "is-hidden",
    snapshot.detailPath === entry.path && "active", pending && "is-busy"].filter(Boolean).join(" ");
  return <div className={classes} role="listitem">
    <Button
      ref={open}
      className="workspace-row-main"
      data-trigger-of={entry.path}
      disabled={entry.kind !== "directory" && !isFile}
      aria-busy={pending || undefined}
      onClick={onOpen}
    >
      <span className="workspace-entry-icon" aria-hidden="true">
        <FileIcon kind={entry.kind} name={entry.name} />
      </span>
      <span className="workspace-row-body">
        <span className="workspace-row-name">{entry.name}</span>
        {isFile && <span className="workspace-row-meta">{`${formatBytes(entry.size)} · ${formatModified(entry.modified_ms)}`}</span>}
      </span>
      {pending && <span className="spinner workspace-row-spinner" aria-hidden="true" />}
      {mark && <GitMark kind={mark} />}
      {changedBelow > 0 && <DirMark count={changedBelow} truncated={marks.truncated} />}
      {entry.kind === "directory" && <Chevron />}
    </Button>
    {isFile && <Button
      className="workspace-row-more"
      aria-label={t("workspace.fileActions", { name: entry.name })}
      aria-haspopup="dialog"
      data-trigger-of={entry.path}
      disabled={busy}
      onClick={() => openWorkspaceFileMenu(entry)}
    ><Ellipsis size={18} aria-hidden="true" /></Button>}
  </div>;
}

function openPathSheet(snapshot: WorkspaceSnapshot, rootLabel: string): void {
  const crumbs = workspaceBreadcrumbs(snapshot.directory);
  ownFilesDialog(() => showActionSheet(t("workspace.jumpTo"), modal => <MenuGroup>
    {crumbs.map((crumb, depth) => {
      const current = crumb.path === snapshot.directory;
      const target = current ? { onClick: () => modal.dismiss() } : { modal, action: () => loadDirectory(crumb.path) };
      return <MenuRow key={crumb.path || "."} {...target}
        icon={<span className="workspace-jump-indent" style={{ paddingLeft: `${depth * 12}px` }}><Folder size={18} /></span>}
        label={crumb.path ? crumb.label : rootLabel}
        detail={current ? t("workspace.current") : undefined}
      />;
    })}
  </MenuGroup>, { className: "workspace-path-sheet", popover: "menu" }));
}

function Breadcrumbs({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const rootLabel = snapshot.descriptor?.name || t("workspace.root");
  const crumbs = workspaceBreadcrumbs(snapshot.directory);
  const shown = foldBreadcrumbs(crumbs);
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : null;
  return <nav className="workspace-breadcrumbs" aria-label={t("workspace.files")}>
    <Button className="workspace-up" aria-label={t("workspace.upDir")} title={t("workspace.upDir")}
      disabled={parent === null} onClick={(event) => {
        if (parent === null) return;
        // Up stays under the pointer: a doubled press would climb two folders.
        guardBackPress(event);
        void loadDirectory(parent);
      }}>
      <ArrowUp size={18} aria-hidden="true" />
    </Button>
    <div className="workspace-crumbs">
      {shown.map((crumb, index) => {
        const last = index === shown.length - 1;
        return <Fragment key={`${crumb.path}:${index}`}>
          {index > 0 && <span className="workspace-crumb-sep" aria-hidden="true">/</span>}
          {"fold" in crumb
            ? <Button className="workspace-crumb workspace-crumb-fold" aria-label={t("workspace.foldedPath")} aria-haspopup="dialog"
              onClick={() => openPathSheet(snapshot, rootLabel)}><span className="workspace-crumb-label">…</span></Button>
            : <Button className={`workspace-crumb${last ? " is-current" : ""}`} aria-current={last ? "page" : undefined}
              onClick={(event) => {
                // A folder above: the trail is drawn again under the pointer, as with Up.
                if (!last) guardBackPress(event);
                void loadDirectory(crumb.path);
              }}><span className="workspace-crumb-label">{crumb.path ? crumb.label : rootLabel}</span></Button>}
        </Fragment>;
      })}
    </div>
  </nav>;
}

export function FileList({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const reveal = snapshot.revealNav;
  const marks = gitMarks(snapshot.status);
  // Directories first, each group in the daemon's order.
  const entries = [...snapshot.entries].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory"));
  return <section className={`workspace-panel${reveal ? " workspace-reveal" : ""}`}>
    <Breadcrumbs snapshot={snapshot} />
    <div className="workspace-list" role="list">
      {entries.map((entry) => <FileRow key={entry.path} entry={entry} snapshot={snapshot} marks={marks} />)}
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

