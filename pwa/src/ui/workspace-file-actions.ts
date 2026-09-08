import { askConfirm, askText } from "../lib/dom";
import { t } from "../lib/i18n";
import { ProtocolError } from "../lib/protocol/errors";
import type { WorkspaceEntry } from "../lib/workspace";
import { messageOf, state } from "../state";
import { render } from "../paint";
import { invalidateWorkspaceFiles, refreshWorkspace, workspaceModel } from "../workspace";
import { openFileMenu } from "./react/file-menu";
import { bindObjectPress } from "./press-menu";
import "../styles/workspace-file-actions.scss";

export function bindWorkspaceFileActions(row: HTMLElement, entry: WorkspaceEntry): () => void {
  const session = state.live;
  const { paneId, descriptor, directory } = workspaceModel;
  const root = descriptor?.root;
  const revision = entry.revision;
  const cwd = state.agents.find((pane) => pane.paneId === paneId)?.cwd;
  if (!session || !root || !revision || entry.kind !== "file") return () => {};
  if (!state.operationCapabilities.rename_file && !state.operationCapabilities.delete_file) return () => {};
  const current = () => state.live === session && state.screen === "workspace"
    && workspaceModel.paneId === paneId && workspaceModel.descriptor?.root === root
    && workspaceModel.directory === directory
    && state.agents.find((pane) => pane.paneId === paneId)?.cwd === cwd;
  const act = async (rename: boolean) => {
    const capability = rename ? "rename_file" : "delete_file";
    if (!current() || state.operationBusy || !state.operationCapabilities[capability]) return;
    let newName = "";
    if (rename) {
      const value = await askText(t("fileActions.rename"), entry.name, 255);
      if (value === null || value === entry.name) return;
      if (!value.trim() || value === "." || value === ".." || value.toLowerCase() === ".git" || /[/\\\p{Cc}]/u.test(value) || new TextEncoder().encode(value).length > 255) {
        if (current()) { workspaceModel.error = t("fileActions.invalidName"); render(); }
        return;
      }
      newName = value;
    } else if (!await askConfirm(t("fileActions.confirmDelete", { name: entry.name }), t("fileActions.delete"))) return;
    if (!current() || state.operationBusy || !state.operationCapabilities[capability]) return;
    state.operationBusy = true;
    workspaceModel.error = "";
    render();
    let errorText = "";
    try {
      if (rename) await session.workspaceRename(paneId, root, entry.path, newName, entry.size, entry.modified_ms, revision);
      else await session.workspaceDelete(paneId, root, entry.path, entry.size, entry.modified_ms, revision);
    } catch (error) {
      errorText = error instanceof ProtocolError && error.code === "conflict" ? t("fileActions.conflict") : messageOf(error);
    } finally {
      invalidateWorkspaceFiles(session, root);
      if (state.live === session) state.operationBusy = false;
    }
    if (!current()) {
      if (state.live === session) render();
      return;
    }
    // Refresh even on an uncertain result; never replay the mutation.
    workspaceModel.view = "browser";
    await refreshWorkspace();
    if (current() && errorText) {
      workspaceModel.error = errorText;
      render();
    }
  };
  const open = () => {
    if (!current() || state.operationBusy) return;
    openFileMenu(entry.name,
      state.operationCapabilities.rename_file ? () => act(true) : undefined,
      state.operationCapabilities.delete_file ? () => act(false) : undefined);
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
