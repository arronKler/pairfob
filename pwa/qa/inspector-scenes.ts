import { isRoomy } from "../src/app/viewport";
import { diffNoteScope, diffNoteTarget, upsertDiffNote } from "../src/lib/diff-notes";
import { parseDiffLines } from "../src/lib/workspace";
import { bumpWorkspaceNotes, getWorkspaceSnapshot, loadGitDiff, loadWorkspaceFile, showWorkspaceTab } from "../src/features/workspace";
import { toggleWorkspaceInspector } from "../src/features/workspace/inspector";
import { inspectorOpen } from "../src/features/workspace/inspector-store";
import * as data from "./data";

/**
 * The files-and-changes inspector beside the open session.
 *
 * A scene opens it with the header files button's own action and then walks
 * the column to its tab, file or diff with the workspace actions a press in
 * the column fires. Nothing here closes it: the baseline reset takes the
 * session off the page, and the inspector's own lifetime follows that.
 *
 * The column needs 900 px. Below that the choice is only parked, exactly as
 * when a window with the inspector open is dragged narrow: the scene shows the
 * plain session, and the tab or detail is not loaded.
 */

const DETAIL_PATH = "src/app.ts";
const NOTE_BODY = "Keep the exported `ready` flag: the smoke test still imports it.";

/** Bounded wait on the workspace model; a scene that never loads fails instead of rendering half a column. */
async function modelSettles(what: string, done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`QA inspector scene: the workspace model never reached "${what}"`);
}

function loaded(): boolean {
  const model = getWorkspaceSnapshot();
  return model.paneId === data.PANE && model.descriptor !== null && model.status !== null && !model.loading;
}

/** Pin a note to the first added line of the diff on screen, as saving the editor under it does, minus its toast. */
function saveLineNote(): void {
  const diff = getWorkspaceSnapshot().diff;
  const line = parseDiffLines(diff?.patch ?? "").find((entry) => entry.kind === "add");
  const target = diff && line ? diffNoteTarget(diff.path, diff.layer, line) : null;
  if (!target || !upsertDiffNote(target, NOTE_BODY, diffNoteScope())) {
    throw new Error("QA inspector scene: the fixture diff has no line to pin a note to");
  }
  bumpWorkspaceNotes();
}

/** Open the inspector beside the pane the scene selected and show what `name` ends in. */
export async function openInspectorScene(name: string): Promise<void> {
  if (!inspectorOpen()) toggleWorkspaceInspector();
  if (!isRoomy()) return;
  await modelSettles("loaded", loaded);
  if (name.endsWith("-files") || name.endsWith("-file")) {
    showWorkspaceTab("files");
    if (name.endsWith("-file")) await loadWorkspaceFile(DETAIL_PATH);
  } else if (name.includes("-diff")) {
    await loadGitDiff(DETAIL_PATH, "worktree");
    if (name.endsWith("-note")) saveLineNote();
  }
  // A first look at a pane opens on its changes, which is the remaining case.
  await modelSettles("settled", loaded);
}
