import { askConfirm, askText } from "../../lib/dom";
import { t } from "../../lib/i18n";
import { ProtocolError } from "../../lib/protocol/errors";
import type { WorkspaceEntry } from "../../lib/workspace";
import { capabilityEnabled, operationBusy, setOperationBusy } from "../operations/capabilities-store";
import { liveSession } from "../computers/catalog-store";
import { currentScreen } from "../../app/navigation-store";
import { messageOf } from "../../lib/notices";
import { bindObjectPress } from "../../shared/ui/overlay/object-press";
import { openFileMenu } from "./file-menu";
import { clearWorkspaceError, markWorkspaceBrowser, refreshWorkspace } from "./actions";
import { notifyWorkspaceApp } from "./navigation";
import { getWorkspaceSnapshot, invalidateWorkspaceFiles, setWorkspaceError, workspacePaneCwd } from "./store";
import "./workspace-file-actions.scss";

export function bindWorkspaceFileActions(row: HTMLElement, entry: WorkspaceEntry): () => void {
  const session = liveSession();
  const snap = getWorkspaceSnapshot();
  const paneId = snap.paneId;
  const root = snap.descriptor?.root;
  const directory = snap.directory;
  const revision = entry.revision;
  const cwd = workspacePaneCwd(paneId);
  if (!session || !root || !revision || entry.kind !== "file") return () => {};
  if (!capabilityEnabled("rename_file") && !capabilityEnabled("delete_file")) return () => {};
  const current = () => {
    const now = getWorkspaceSnapshot();
    return liveSession() === session && currentScreen() === "workspace"
      && now.paneId === paneId && now.descriptor?.root === root
      && now.directory === directory
      && workspacePaneCwd(paneId) === cwd;
  };
  const act = async (rename: boolean) => {
    const capability = rename ? "rename_file" : "delete_file";
    if (!current() || operationBusy() || !capabilityEnabled(capability)) return;
    let newName = "";
    if (rename) {
      const value = await askText(t("fileActions.rename"), entry.name, 255);
      if (value === null || value === entry.name) return;
      if (!value.trim() || value === "." || value === ".." || value.toLowerCase() === ".git" || /[/\\\p{Cc}]/u.test(value) || new TextEncoder().encode(value).length > 255) {
        if (current()) setWorkspaceError(t("fileActions.invalidName"));
        return;
      }
      newName = value;
    } else if (!await askConfirm(t("fileActions.confirmDelete", { name: entry.name }), t("fileActions.delete"))) return;
    if (!current() || operationBusy() || !capabilityEnabled(capability)) return;
    setOperationBusy(true);
    clearWorkspaceError();
    notifyWorkspaceApp();
    // Busy publishes synchronously: a subscriber can retire this action's
    // session/workspace/file ownership or revoke the required capability during
    // that publication. Recheck the captured owner and the live capability
    // immediately before the RPC; if no longer current, release only the lock
    // this action owns and never issue a compensating mutation.
    if (!current() || !capabilityEnabled(capability)) {
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
      invalidateWorkspaceFiles(session, root);
      if (liveSession() === session) setOperationBusy(false);
    }
    if (!current()) {
      if (liveSession() === session) notifyWorkspaceApp();
      return;
    }
    // Refresh even on an uncertain result; never replay the mutation.
    markWorkspaceBrowser();
    await refreshWorkspace();
    if (current() && errorText) setWorkspaceError(errorText);
  };
  const open = () => {
    if (!current() || operationBusy()) return;
    openFileMenu(entry.name,
      capabilityEnabled("rename_file") ? () => act(true) : undefined,
      capabilityEnabled("delete_file") ? () => act(false) : undefined);
  };
  row.classList.add("workspace-file-actionable");
  row.setAttribute("aria-haspopup", "dialog");
  row.title = t("fileActions.hint");
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
    row.removeAttribute("aria-haspopup");
    if (row.title === t("fileActions.hint")) row.removeAttribute("title");
  };
}
