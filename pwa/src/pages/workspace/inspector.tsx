import { useCallback, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { ensureBranches, useWorkspace, type WorkspaceSnapshot } from "../../features/workspace";
import { BranchSheet } from "../../features/workspace/branches";
import { WorkspaceBrowser } from "../../features/workspace/browser";
import { escapeFromColumn } from "../../features/workspace/escape";
import { RepoTitle } from "../../features/workspace/header";
import { InspectorDiff, InspectorFile } from "../../features/workspace/inspector-detail";
import { useInspectorFocus } from "../../features/workspace/focus-keeper";
import { InspectorHead } from "../../features/workspace/inspector-head";

/**
 * One column: the list until something is opened, then that file or diff under
 * a one-line switcher. Keyed by pane, so a branch sheet opened for one session
 * never carries over to the next. A note is written under its line, inside the
 * diff, so this holds no editor of its own.
 */
function InspectorContent({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [branchOpen, setBranchOpen] = useState(false);
  const openBranches = useCallback(async () => {
    const branches = await ensureBranches();
    if (branches) setBranchOpen(true);
  }, []);

  return <>
    {snapshot.view === "file" ? <InspectorFile snapshot={snapshot} />
      : snapshot.view === "diff" ? <InspectorDiff snapshot={snapshot} />
      : <section className="inspector-list">
        <RepoTitle snapshot={snapshot} onBranches={() => void openBranches()} />
        <WorkspaceBrowser snapshot={snapshot} />
      </section>}
    {branchOpen && snapshot.branches && <BranchSheet branches={snapshot.branches} onClose={() => setBranchOpen(false)} />}
  </>;
}

/**
 * Files and changes as a column beside the desk session.
 *
 * The session's own column already shows the app notice, so this one does not
 * repeat it the way the workspace screen has to. The column can hold focus
 * itself (`tabIndex`), which is where the keyboard rests when nothing inside
 * it has it: see `useInspectorFocus`. Esc pressed in it closes what is on top:
 * the open file or diff, then the column (`escape`).
 */
export function WorkspaceInspector() {
  const snapshot = useWorkspace();
  const column = useRef<HTMLElement>(null);
  useInspectorFocus(column, snapshot.paneId);
  return <aside ref={column} className="inspector workspace-inspector" aria-label={t("inspector.label")} tabIndex={-1}
    onKeyDown={escapeFromColumn}>
    <InspectorHead snapshot={snapshot} />
    <InspectorContent key={snapshot.paneId} snapshot={snapshot} />
  </aside>;
}
