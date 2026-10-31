import { PenLine } from "lucide-react";
import { diffNoteCounts } from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import type { GitLayer } from "../../lib/workspace";
import { showActionSheet, type ActionSheetController } from "../../shared/ui/overlay/action-sheet";
import { MenuGroup, MenuRow } from "../../shared/ui/overlay/menu-controls";
import { useLiveSession } from "../computers/hooks";
import { loadGitDiff } from "./actions";
import { getWorkspaceSnapshot } from "./store";
import { ownFilesDialog } from "./surface-dialogs";

/**
 * Where the pane's unsent notes are: every file and layer that holds some,
 * with how many. "Send all" sends notes the reader is not looking at, and a
 * note can outlive its change (committed, reverted or staged since), which
 * takes its file out of the list of changes. This is the way to each of them:
 * a row opens that file's diff, where its notes are read, edited, sent or
 * discarded.
 */

const nameOf = (path: string): string => path.split("/").pop() || path;
const folderOf = (path: string): string => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : t("workspace.repoRoot");

function Waiting({ modal }: { modal: ActionSheetController }) {
  const snapshot = getWorkspaceSnapshot();
  const rows = [...diffNoteCounts(useLiveSession(), snapshot.paneId)].map(([key, count]) => {
    const layer = key.slice(0, key.indexOf(":")) as GitLayer;
    return { key, layer, path: key.slice(key.indexOf(":") + 1), count };
  }).sort((left, right) => left.path.localeCompare(right.path) || (left.layer === right.layer ? 0 : left.layer === "staged" ? -1 : 1));
  return <MenuGroup label={t("diffNotes.waitingTitle")}>
    {rows.map((row) => <MenuRow key={row.key} modal={modal} action={() => loadGitDiff(row.path, row.layer)}
      icon={<PenLine size={18} />} label={nameOf(row.path)}
      detail={[folderOf(row.path), t(row.layer === "staged" ? "workspace.staged" : "workspace.worktree"), t("workspace.noteCount", { count: row.count })].join(" · ")} />)}
  </MenuGroup>;
}

/** Open the list at the control that asked for it. */
export function openWaitingNotes(anchor: HTMLElement): void {
  ownFilesDialog(() => showActionSheet(t("diffNotes.waitingTitle"), (modal) => <Waiting modal={modal} />,
    { className: "workspace-file-menu", popover: "menu", anchor }));
}
