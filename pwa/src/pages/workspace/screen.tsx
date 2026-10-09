import { useCallback, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { AppNotice, useAppNotice } from "../../app/notice";
import {
  ensureBranches,
  useWorkspace,
  type WorkspaceSnapshot,
} from "../../features/workspace";
import { BranchSheet } from "../../features/workspace/branches";
import { WorkspaceBrowser } from "../../features/workspace/browser";
import { DiffDetail, openDiffKey } from "../../features/workspace/diff";
import { useScreenEscape } from "../../features/workspace/escape";
import { FileDetail } from "../../features/workspace/file-detail";
import { useScreenFocus } from "../../features/workspace/focus-keeper";
import { WorkspaceHeader } from "../../features/workspace/header";
import { useSheetNote } from "../../features/workspace/note-sheet";
import { DiffNoteEditor } from "../../features/workspace/notes";
import { useTabOrder } from "../../features/workspace/tab-order";
import { WorkspaceTabStrip } from "../../features/workspace/tab-strip";

function WorkspaceTabs({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const order = useTabOrder();
  // Without Git status there is only one view, so no tab strip at all.
  if (!snapshot.descriptor?.features.git_status) return null;
  return <WorkspaceTabStrip snapshot={snapshot} order={order} kind="workspace" label={t("workspace.title")} />;
}

function WorkspaceNotice() {
  const notice = useAppNotice();
  if (!notice) return null;
  return <div className="workspace-app-notice"><AppNotice /></div>;
}

function EmptyDetail({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return <section className="workspace-detail-empty">
    <strong>{snapshot.descriptor?.name || t("workspace.title")}</strong>
    <p>{snapshot.descriptor?.root || ""}</p>
  </section>;
}

export function WorkspaceScreen() {
  const snapshot = useWorkspace();
  const note = useSheetNote(openDiffKey(snapshot));
  const [branchOpen, setBranchOpen] = useState(false);
  const openBranches = useCallback(async () => {
    const branches = await ensureBranches();
    if (branches) setBranchOpen(true);
  }, []);
  const shell = useRef<HTMLDivElement>(null);
  useScreenFocus(shell);
  useScreenEscape();

  return <>
    <div ref={shell} className={`workspace-shell${snapshot.view === "browser" ? "" : " detail"}`}>
      <WorkspaceHeader snapshot={snapshot} onBranches={() => void openBranches()} />
      <WorkspaceNotice />
      <div className="workspace-body">
        <aside className="workspace-nav">
          <WorkspaceTabs snapshot={snapshot} />
          <WorkspaceBrowser snapshot={snapshot} />
        </aside>
        <main className="workspace-main">
          {snapshot.view === "file" ? <FileDetail snapshot={snapshot} />
            : snapshot.view === "diff" ? <DiffDetail snapshot={snapshot} onEditNote={note.open} parked={note.parked} />
            : <EmptyDetail snapshot={snapshot} />}
        </main>
      </div>
    </div>
    {note.editing && <DiffNoteEditor target={note.editing.target} startWith={note.editing.startWith} onDraft={note.draft} onClose={note.close} onSetAside={note.setAside} />}
    {branchOpen && snapshot.branches && <BranchSheet branches={snapshot.branches} onClose={() => setBranchOpen(false)} />}
  </>;
}
