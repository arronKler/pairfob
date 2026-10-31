import { Ellipsis } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { t } from "../../lib/i18n";
import type { WorkspaceEntry } from "../../lib/workspace";
import { Button, Chevron } from "../../shared/ui/primitives";
import { useLiveSession } from "../computers/hooks";
import { useCapabilities } from "../operations/hooks";
import { loadDirectory, loadWorkspaceFile } from "./actions";
import { bindWorkspaceFileActions, openWorkspaceFileMenu, workspaceMutationTarget } from "./file-actions";
import { FileIcon } from "./file-icon";
import { formatModifiedAge } from "./format";
import { DirMark, GitMark } from "./git-mark";
import type { GitMarks } from "./git-marks";
import type { WorkspaceSnapshot } from "./model";
import { workspacePaneCwd } from "./store";

/** A path as a row the list can draw: no size, no time and no revision, so no rename or delete from here. */
export function pathEntry(path: string): WorkspaceEntry {
  return { name: path.split("/").pop() || path, path, kind: "file", size: 0, modified_ms: 0, hidden: false };
}

/**
 * `recent` names a row that stands outside the directory's own listing: a
 * recently opened file, one the agent's turn wrote, or a search result. The
 * same file may also be listed below, so the row's controls are keyed apart
 * (`data-trigger-of` is what focus and the overlays find a row by), and it
 * says which folder it is in.
 */
export function FileRow({ entry, snapshot, marks, recent }: {
  entry: WorkspaceEntry; snapshot: WorkspaceSnapshot; marks: GitMarks; recent?: "recent" | "turn" | "search";
}) {
  const open = useRef<HTMLButtonElement>(null);
  const session = useLiveSession();
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
  const classes = ["workspace-row", `workspace-${entry.kind}`, entry.hidden && "is-hidden", recent && "is-recent", recent && `is-${recent}`,
    !recent && snapshot.detailPath === entry.path && "active", pending && "is-busy"].filter(Boolean).join(" ");
  // A recent file says where it lives; a row of the directory has no folder to name.
  const folder = entry.path.slice(0, Math.max(0, entry.path.length - entry.name.length - 1));
  const trigger = recent ? `${recent}:${entry.path}` : entry.path;
  return <div className={classes} role="listitem">
    <Button
      ref={open}
      className="workspace-row-main"
      data-trigger-of={trigger}
      disabled={entry.kind !== "directory" && !isFile}
      aria-busy={pending || undefined}
      onClick={onOpen}
    >
      <span className="workspace-entry-icon" aria-hidden="true">
        <FileIcon kind={entry.kind} name={entry.name} />
      </span>
      <span className="workspace-row-body">
        <span className="workspace-row-name">{entry.name}</span>
        {recent && <span className="workspace-row-meta workspace-row-folder">{folder || t("workspace.repoRoot")}</span>}
      </span>
      {pending && <span className="spinner workspace-row-spinner" aria-hidden="true" />}
      {mark && <GitMark kind={mark} />}
      {isFile && entry.modified_ms > 0 && <span className="workspace-row-meta workspace-row-age">{formatModifiedAge(entry.modified_ms)}</span>}
      {changedBelow > 0 && <DirMark count={changedBelow} truncated={marks.truncated} />}
      {entry.kind === "directory" && <Chevron />}
    </Button>
    {isFile && <Button
      className="workspace-row-more"
      aria-label={t("workspace.fileActions", { name: entry.name })}
      aria-haspopup="dialog"
      data-trigger-of={trigger}
      disabled={busy}
      onClick={() => openWorkspaceFileMenu(entry)}
    ><Ellipsis size={18} aria-hidden="true" /></Button>}
  </div>;
}

