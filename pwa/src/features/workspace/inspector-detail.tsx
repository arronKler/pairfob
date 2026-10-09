import { ChevronDown } from "lucide-react";
import type { KeyboardEvent } from "react";
import { t } from "../../lib/i18n";
import type { GitChangeKind } from "../../lib/workspace";
import { Button } from "../../shared/ui/primitives";
import { closeWorkspaceDetail } from "./actions";
import { guardBackPress } from "./back-press";
import { DiffBody, DiffStats, LayerSwitch, useDiffView } from "./diff";
import { DiffStepper } from "./diff-stepper";
import { plainEscape } from "./escape";
import { DetailMoreButton, FileActions, FileBody, FileMeta, useFileView } from "./file-detail";
import { GitMark } from "./git-mark";
import type { WorkspaceSnapshot } from "./model";
import { useInlineNote } from "./note-inline";
import { DiffNotesBar } from "./notes";

/**
 * The inspector's one column has no room for the list beside an open file, so
 * the list collapses into this: the open item's name, which leads back to it.
 * The full path stays one hover or one ⋯ away. The list comes up under the
 * pointer with the repository title where the chip was, so a doubled press is
 * guarded as on any way back.
 */
function ListSwitch({ path, mark }: { path: string; mark?: GitChangeKind }) {
  const name = path.split("/").pop() || path;
  return <Button className="inspector-switch-file" aria-label={t("inspector.backToList", { name })} title={path}
    onClick={(event) => {
      guardBackPress(event);
      closeWorkspaceDetail();
    }}>
    <ChevronDown size={14} aria-hidden="true" />
    <span className="workspace-detail-name">{name}</span>
    {mark && <GitMark kind={mark} />}
  </Button>;
}

/** A source file in the inspector: the switcher line, then the same body the page shows. */
export function InspectorFile({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const view = useFileView(snapshot);
  return <section className="workspace-detail-view" aria-label={t("workspace.file")}>
    <div className="workspace-detail-head inspector-switch">
      {/* The changes chip beside it already carries the file's mark. */}
      <ListSwitch path={view.path} />
      <FileMeta snapshot={snapshot} view={view} />
      <FileActions view={view} />
    </div>
    <FileBody snapshot={snapshot} view={view} />
  </section>;
}

/**
 * A diff in the inspector. The switcher line carries what the page spreads over
 * its info bar and footer — layer, counts, previous/next — and the footer is
 * left to notes: the invitation to pin one, then the bar that sends them to the
 * agent in the session next to it. A note is written in place, under its line.
 */
export function InspectorDiff({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const view = useDiffView(snapshot);
  const { diff, layers } = view;
  const note = useInlineNote(view.diffKey);
  // The form takes its own Escape. Pressed anywhere else in the diff while a
  // note is open, the note is still what is on top: it is set aside first.
  const setOpenNoteAside = (event: KeyboardEvent<HTMLElement>) => {
    if (!note.note || !plainEscape(event.nativeEvent) || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    note.setAside();
  };
  return <section className="workspace-detail-view workspace-diff-view" aria-label={t("workspace.diff")} onKeyDown={setOpenNoteAside}>
    <div className="workspace-detail-head inspector-switch">
      <ListSwitch path={view.path} mark={view.kind} />
      {layers.length > 1 ? <LayerSwitch snapshot={snapshot} layers={layers} />
        : <span className="workspace-layer-label">{t(snapshot.diffLayer === "staged" ? "workspace.staged" : "workspace.worktree")}</span>}
      <DiffStats snapshot={snapshot} />
      <span className="workspace-detail-actions">
        <DiffStepper snapshot={snapshot} />
        <DetailMoreButton />
      </span>
    </div>
    <DiffBody snapshot={snapshot} view={view} onEditNote={note.open} hint={false} inline={note} parked={note.parked} />
    <div className="workspace-diff-footer">
      {diff && !diff.binary && <DiffNotesBar key={view.diffKey} path={diff.path} layer={snapshot.diffLayer} paneId={snapshot.paneId} beside />}
      {view.invitesNotes && <p className="workspace-diff-hint">{t("diffNotes.tapHint")}</p>}
    </div>
  </section>;
}
