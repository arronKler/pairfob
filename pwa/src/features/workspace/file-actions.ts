import { askConfirm, askText } from "../../lib/dom";
import { t } from "../../lib/i18n";
import { ProtocolError } from "../../lib/protocol/errors";
import type { WorkspaceEntry } from "../../lib/workspace";
import { capabilityEnabled, operationBusy, setOperationBusy } from "../operations/capabilities-store";
import { liveSession } from "../computers/catalog-store";
import { showError, showStatus } from "../../app/notices-store";
import { messageOf } from "../../lib/notices";
import { bindObjectPress } from "../../shared/ui/overlay/object-press";
import { openFileMenu, type FileMenuSpec } from "./file-menu";
import { clearWorkspaceError, loadGitDiff, markWorkspaceBrowser, refreshWorkspace } from "./actions";
import { noteRowRenamed } from "./focus-landing";
import { fileNameProblem, gitMarks, layersFor } from "./git-marks";
import { notifyWorkspaceApp } from "./navigation";
import { getWorkspaceSnapshot, invalidateWorkspaceFiles, setWorkspaceError, workspacePaneCwd } from "./store";
import { ownFilesDialog } from "./surface-dialogs";
import { workspacePresented } from "./surface";
import "./workspace-file-actions.scss";

/** The file a rename/delete is in flight for, so its row can show busy. */
let mutationTarget = "";

export function workspaceMutationTarget(): string {
  return mutationTarget;
}

const NAME_PROBLEMS = {
  empty: "workspace.nameEmpty",
  reserved: "workspace.nameReserved",
  separator: "workspace.nameSeparator",
  tooLong: "workspace.nameTooLong",
} as const;

function nameProblemText(value: string): string | null {
  const problem = fileNameProblem(value);
  return problem ? t(NAME_PROBLEMS[problem]) : null;
}

/** Absolute path when the root is known; the clipboard gets what a shell accepts. */
export async function copyWorkspacePath(path: string): Promise<void> {
  const root = getWorkspaceSnapshot().descriptor?.root;
  const text = root ? `${root.replace(/\/+$/, "")}/${path}` : path;
  try {
    await navigator.clipboard.writeText(text);
    showStatus(t("workspace.copied"));
  } catch {
    showError(t("workspace.copyFailed", { path: text }));
  }
}

/** Open the file's diff in the layer the list marks (worktree first). */
export function viewWorkspaceChanges(path: string): (() => void) | undefined {
  const snap = getWorkspaceSnapshot();
  if (!snap.descriptor?.features.git_diff || !snap.status) return undefined;
  const layers = layersFor(snap.status.changes, path);
  if (!layers.length) return undefined;
  const layer = layers.includes("worktree") ? "worktree" : layers[0];
  return () => void loadGitDiff(path, layer);
}

/**
 * Rename/delete for one listed file, bound to the session, pane, root and
 * directory that listed it. Each is present only while its capability is.
 */
export function workspaceFileMutations(entry: WorkspaceEntry): { rename?: () => Promise<void>; remove?: () => Promise<void> } {
  const session = liveSession();
  const snap = getWorkspaceSnapshot();
  const paneId = snap.paneId;
  const root = snap.descriptor?.root;
  const directory = snap.directory;
  const revision = entry.revision;
  const cwd = workspacePaneCwd(paneId);
  if (!session || !root || !revision || entry.kind !== "file") return {};
  const current = () => {
    const now = getWorkspaceSnapshot();
    return liveSession() === session && workspacePresented()
      && now.paneId === paneId && now.descriptor?.root === root
      && now.directory === directory
      && workspacePaneCwd(paneId) === cwd;
  };
  const act = async (rename: boolean) => {
    const capability = rename ? "rename_file" : "delete_file";
    if (!current() || operationBusy() || !capabilityEnabled(capability)) return;
    let newName = "";
    if (rename) {
      const value = await ownFilesDialog(() => askText({ title: t("fileActions.rename"), initial: entry.name, maxLength: 255,
        label: t("text.fileName"), allowEmpty: false, hint: t("workspace.nameRule"), validate: nameProblemText }));
      if (value === null || value === entry.name) return;
      if (fileNameProblem(value)) {
        if (current()) setWorkspaceError(t("fileActions.invalidName"));
        return;
      }
      newName = value;
    } else if (!await ownFilesDialog(() => askConfirm({ title: t("confirm.deleteFileTitle"), subject: { name: entry.name, detail: entry.path && entry.path !== entry.name ? entry.path : undefined },
      message: t("confirm.deleteFileEffect"), confirmLabel: t("fileActions.delete") }))) return;
    if (!current() || operationBusy() || !capabilityEnabled(capability)) return;
    mutationTarget = entry.path;
    setOperationBusy(true);
    clearWorkspaceError();
    notifyWorkspaceApp();
    // Busy publishes synchronously: a subscriber can retire this action's
    // session/workspace/file ownership or revoke the required capability during
    // that publication. Recheck the captured owner and the live capability
    // immediately before the RPC; if no longer current, release only the lock
    // this action owns and never issue a compensating mutation.
    if (!current() || !capabilityEnabled(capability)) {
      mutationTarget = "";
      if (liveSession() === session) setOperationBusy(false);
      return;
    }
    let errorText = "";
    try {
      if (rename) await session.workspaceRename(paneId, root, entry.path, newName, entry.size, entry.modified_ms, revision);
      else await session.workspaceDelete(paneId, root, entry.path, entry.size, entry.modified_ms, revision);
    } catch (error) {
      errorText = error instanceof ProtocolError && error.code === "conflict" ? t("fileActions.conflict") : messageOf(error);
    } finally {
      mutationTarget = "";
      invalidateWorkspaceFiles(session, root);
      if (liveSession() === session) setOperationBusy(false);
    }
    if (!current()) {
      if (liveSession() === session) notifyWorkspaceApp();
      return;
    }
    // The row keeps the reader's place under its new name.
    if (rename && !errorText) noteRowRenamed(entry.path, `${entry.path.slice(0, entry.path.length - entry.name.length)}${newName}`);
    // Refresh even on an uncertain result; never replay the mutation.
    markWorkspaceBrowser();
    await refreshWorkspace();
    if (!current()) return;
    if (errorText) setWorkspaceError(errorText);
    else showStatus(rename ? t("workspace.renamedTo", { name: newName }) : t("workspace.deletedFile", { name: entry.name }));
  };
  return {
    ...(capabilityEnabled("rename_file") ? { rename: () => act(true) } : {}),
    ...(capabilityEnabled("delete_file") ? { remove: () => act(false) } : {}),
  };
}

/** The sheet a file row's ⋯, long-press and context menu all open. */
export function openWorkspaceFileMenu(entry: WorkspaceEntry, extra: Partial<FileMenuSpec> = {}): void {
  if (entry.kind !== "file" || operationBusy()) return;
  const snap = getWorkspaceSnapshot();
  const mutations = workspaceFileMutations(entry);
  openFileMenu({
    name: entry.name,
    directory: entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : t("workspace.repoRoot"),
    mark: gitMarks(snap.status).files.get(entry.path) ?? null,
    viewChanges: viewWorkspaceChanges(entry.path),
    copyPath: () => copyWorkspacePath(entry.path),
    rename: mutations.rename,
    remove: mutations.remove,
    ...extra,
  });
}

/** Long-press and the keyboard context-menu keys open the row's file menu. */
export function bindWorkspaceFileActions(row: HTMLElement, entry: WorkspaceEntry): () => void {
  if (entry.kind !== "file") return () => {};
  const open = () => {
    if (!workspacePresented() || operationBusy()) return;
    openWorkspaceFileMenu(entry);
  };
  row.classList.add("workspace-file-actionable");
  const stopPress = bindObjectPress(row, open);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      open();
    }
  };
  row.addEventListener("keydown", onKey);
  return () => {
    stopPress();
    row.removeEventListener("keydown", onKey);
    row.classList.remove("workspace-file-actionable");
  };
}
