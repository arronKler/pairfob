import { t } from "../../lib/i18n";
import { leaveWorkspace, loadWorkspaceFile, refreshWorkspace } from "./actions";
import { copyWorkspacePath, viewWorkspaceChanges, workspaceFileMutations } from "./file-actions";
import { openFileMenu } from "./file-menu";
import { returnLabel } from "./format";
import { gitMarks } from "./git-marks";
import { getWorkspaceSnapshot } from "./store";
import { workspaceBeside } from "./surface";

/**
 * The ⋯ menu of the file preview and the diff. The preview offers rename and
 * delete while its file is still listed in the browsed directory; the diff does
 * not, so reviewing never edits files by accident.
 */
export function openDetailMenu(): void {
  const snap = getWorkspaceSnapshot();
  const path = snap.detailPath;
  if (!path || snap.view === "browser") return;
  const cut = path.lastIndexOf("/");
  const mark = gitMarks(snap.status).files.get(path) ?? null;
  const common = {
    name: cut >= 0 ? path.slice(cut + 1) : path,
    directory: cut >= 0 ? path.slice(0, cut) : t("workspace.repoRoot"),
    mark,
    copyPath: () => copyWorkspacePath(path),
    refresh: () => refreshWorkspace(),
    // Beside the session there is no workspace to leave: the column has its own close.
    closeWorkspace: workspaceBeside() ? undefined : () => leaveWorkspace(),
    closeDetail: returnLabel(snap.returnView),
  };
  if (snap.view === "diff") {
    const deleted = snap.diffLayer === "staged"
      ? snap.status?.changes.some((change) => change.path === path && change.index === "D")
      : mark === "deleted";
    openFileMenu({ ...common, openFile: deleted ? undefined : () => loadWorkspaceFile(path) });
    return;
  }
  const entry = snap.entries.find((item) => item.path === path);
  const mutations = entry ? workspaceFileMutations(entry) : {};
  openFileMenu({ ...common, viewChanges: viewWorkspaceChanges(path), rename: mutations.rename, remove: mutations.remove });
}
