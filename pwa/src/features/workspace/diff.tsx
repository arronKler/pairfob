import { useLayoutEffect, useRef, type ReactNode } from "react";
import { diffNoteTarget, diffNotesFor, type DiffNoteTarget } from "../../lib/diff-notes";
import { parseDiffLines, type DiffLine, type GitChangeKind, type GitLayer } from "../../lib/workspace";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { useCapabilities } from "../operations/hooks";
import { loadGitDiff, loadWorkspaceFile, refreshWorkspace } from "./actions";
import { useLineStops } from "./diff-line-stops";
import { DiffStepper } from "./diff-stepper";
import { DetailIdentity, DetailMoreButton } from "./file-detail";
import { changeKindLabel } from "./format";
import { GitMark } from "./git-mark";
import { changeSections, layersFor } from "./git-marks";
import type { WorkspaceSnapshot } from "./model";
import { InlineNoteEditor, type InlineNote } from "./note-inline";
import { ParkedNoteCard, type ParkedNote } from "./note-parked";
import { DiffNoteCards, DiffNotesBar, diffLineHasNote, diffNoteLineLabel, diffNotePinKey, openNoteEditorAllowed } from "./notes";
import { DiffPending, ReservedStat } from "./pending";

const MAX_RENDERED_DIFF_LINES = 800;

type DiffScrollMemory = { key: string; top: number; left: number };
let diffScrollMemory: DiffScrollMemory | null = null;

function rememberDiffScroll(el: HTMLElement, key: string): void {
  diffScrollMemory = { key, top: el.scrollTop, left: el.scrollLeft };
}

export function DiffScroller({ diffKey, children }: { diffKey: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const stops = useLineStops(ref);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mountedKey = diffKey;
    const same = diffScrollMemory?.key === mountedKey;
    el.scrollTop = same ? diffScrollMemory!.top : 0;
    el.scrollLeft = same ? diffScrollMemory!.left : 0;
    rememberDiffScroll(el, mountedKey);
    const onScroll = () => rememberDiffScroll(el, mountedKey);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      rememberDiffScroll(el, mountedKey);
      el.removeEventListener("scroll", onScroll);
    };
  }, [diffKey]);

  return <div ref={ref} className="workspace-diff" role="table" data-diff-key={diffKey} onFocus={stops.onFocus} onKeyDown={stops.onKeyDown}>
    {children}
  </div>;
}

const SIGN: Partial<Record<DiffLine["kind"], string>> = { add: "+", delete: "−" };

/**
 * One gutter: the new line number, or the old one for a deletion. When the
 * line can take a note the number itself is the keyboard target; a tap
 * anywhere on the line opens the same editor.
 */
function DiffLineRow({
  line, noteable, path, layer, onEdit, inline, parked,
}: {
  line: DiffLine; noteable: boolean; path: string; layer: GitLayer; onEdit: (target: DiffNoteTarget) => void;
  inline?: InlineNote; parked?: ParkedNote | null;
}) {
  const target = noteable ? diffNoteTarget(path, layer, line) : null;
  const noted = target ? diffLineHasNote(target) : false;
  const label = target ? t(noted ? "diffNotes.editTitle" : "diffNotes.addTitle", { line: target.line }) : undefined;
  const number = line.newLine ?? line.oldLine;
  const note = target && inline?.note && diffNotePinKey(inline.note.target) === diffNotePinKey(target) ? inline.note : null;
  const editing = note !== null;
  const numberRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  // The editor took the keyboard from this line and hands it back here when it
  // closes, so focus never drops out of the column. If the reader has already
  // moved on to another control, it stays with them.
  useLayoutEffect(() => {
    const closed = wasEditing.current && !editing;
    wasEditing.current = editing;
    if (!closed) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) numberRef.current?.focus({ preventScroll: true });
  }, [editing]);
  const open = () => {
    if (!target || !openNoteEditorAllowed(target)) return;
    onEdit(target);
  };
  return <>
    <div
      className={`workspace-diff-line diff-${line.kind}${target ? " diff-noteable" : ""}${noted ? " has-note" : ""}`}
      role="row"
      title={label}
      onClick={(event) => {
        if (!target) return;
        const sel = document.getSelection();
        if (sel && !sel.isCollapsed && event.currentTarget.contains(sel.anchorNode)) return;
        open();
      }}
    >
      {target
        // Named for its pin, so what closes under the line finds the line again (`note-line-focus`).
        ? <Button ref={numberRef} className="diff-comment-btn diff-line-number" aria-label={label} title={diffNoteLineLabel(target)}
          data-note-line={diffNotePinKey(target)} onClick={(event) => {
          event.stopPropagation();
          open();
        }}>{number === null ? "" : String(number)}</Button>
        : <span className="diff-line-number">{number === null || line.kind === "hunk" || line.kind === "meta" ? "" : String(number)}</span>}
      <span className="diff-line-sign" aria-hidden="true">{SIGN[line.kind] ?? ""}</span>
      <code className="diff-line-text">{line.text || " "}</code>
    </div>
    {target && (note && inline
      ? <InlineNoteEditor note={note} onClose={inline.close} onSetAside={inline.setAside} />
      : <DiffNoteCards target={target} onEdit={onEdit} />)}
    {target && parked && diffNotePinKey(parked.note.target) === diffNotePinKey(target) && <ParkedNoteCard parked={parked} onResume={onEdit} />}
  </>;
}

export function LayerSwitch({ snapshot, layers }: { snapshot: WorkspaceSnapshot; layers: GitLayer[] }) {
  return <div className="workspace-layer-switch" role="group" aria-label={t("workspace.layerSwitch")}>
    {layers.map((layer) => <Button key={layer} aria-pressed={snapshot.diffLayer === layer}
      onClick={() => { if (snapshot.diffLayer !== layer) void loadGitDiff(snapshot.detailPath, layer); }}>
      {layer === "staged" ? t("workspace.staged") : t("workspace.worktree")}
    </Button>)}
  </div>;
}

/** The open diff, derived once for whichever arrangement shows it: the page or the inspector. */
export type DiffView = {
  diff: WorkspaceSnapshot["diff"];
  path: string;
  parsed: DiffLine[];
  noteable: boolean;
  diffKey: string;
  layers: GitLayer[];
  kind: GitChangeKind | undefined;
  /** The diff rendered its lines, so the reader can pin notes and has none yet. */
  invitesNotes: boolean;
};

/** The open diff's file and layer: what its scroll position and its note in progress are kept by. */
export function openDiffKey(snapshot: WorkspaceSnapshot): string {
  return snapshot.diff ? `${snapshot.diff.path}:${snapshot.diffLayer}` : "";
}

export function useDiffView(snapshot: WorkspaceSnapshot): DiffView {
  const capabilities = useCapabilities();
  const diff = snapshot.diff;
  const path = diff?.path || snapshot.detailPath;
  // `diff --git`, `---`/`+++` and `index` lines repeat the header; hunks and code remain.
  const parsed = diff && !diff.binary ? parseDiffLines(diff.patch).filter((line) => line.kind !== "meta") : [];
  const noteable = Boolean(diff && !diff.truncated && capabilities.operationCapabilities.prompt_agent);
  const changes = snapshot.status?.changes ?? [];
  const sections = changeSections(changes.filter((change) => change.path === path));
  const step = [...sections.conflict, ...sections.staged, ...sections.worktree].find((item) => item.layer === snapshot.diffLayer);
  return {
    diff,
    path,
    parsed,
    noteable,
    diffKey: openDiffKey(snapshot),
    layers: layersFor(changes, path),
    kind: step?.kind,
    invitesNotes: Boolean(diff && noteable && !snapshot.error && parsed.length && diff.patch
      && !diffNotesFor(diff.path, snapshot.diffLayer).length),
  };
}

/** `+n −n`, with their room held while the diff is still on its way. */
export function DiffStats({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const diff = snapshot.diff;
  if (diff) {
    return <>
      <span className="workspace-additions">{t("workspace.additions", { count: diff.additions })}</span>
      <span className="workspace-deletions">{t("workspace.deletions", { count: diff.deletions })}</span>
    </>;
  }
  if (!snapshot.loading) return null;
  return <><ReservedStat className="workspace-additions" text={null} /><ReservedStat className="workspace-deletions" text={null} /></>;
}

/**
 * Everything between the info bar and the footer: the conflict banner, then the
 * lines or the state that stands in for them. `hint` is the page's invitation
 * to pin a note above the lines; the inspector shows it in its footer instead.
 * With `inline` the note editor opens under its line instead of as a sheet;
 * `parked` is a half-written note that is in neither, waiting under its line.
 */
export function DiffBody({ snapshot, view, onEditNote, hint = true, inline, parked }: {
  snapshot: WorkspaceSnapshot; view: DiffView; onEditNote: (target: DiffNoteTarget) => void; hint?: boolean; inline?: InlineNote;
  parked?: ParkedNote | null;
}) {
  const { diff, parsed, noteable, diffKey } = view;
  const retry = () => {
    if (snapshot.detailPath) void loadGitDiff(snapshot.detailPath, snapshot.diffLayer);
    else void refreshWorkspace();
  };
  return <>
    {view.kind === "conflict" && <p className="workspace-diff-banner" role="note">{t("workspace.conflictBanner")}</p>}
    {snapshot.error ? (
      <div className="workspace-feedback workspace-error workspace-feedback-pane" role="alert">
        <p>{snapshot.error}</p>
        <Button className="btn btn-small" onClick={retry}>{t("ft.retry")}</Button>
      </div>
    ) : !diff ? (
      snapshot.loading && snapshot.pendingReveal ? <DiffPending /> : <div className="workspace-diff-spacer" />
    ) : diff.binary ? (
      <p className="workspace-empty">{t("workspace.binary")}</p>
    ) : !parsed.length || !diff.patch ? (
      <p className="workspace-empty">{t("workspace.diffEmpty")}</p>
    ) : (
      <>
        {hint && view.invitesNotes && <p className="workspace-diff-hint">{t("diffNotes.tapHint")}</p>}
        <DiffScroller diffKey={diffKey}>
          {parsed.slice(0, MAX_RENDERED_DIFF_LINES).map((line, index) => (
            <DiffLineRow key={index} line={line} noteable={noteable} path={diff.path} layer={snapshot.diffLayer} onEdit={onEditNote} inline={inline} parked={parked} />
          ))}
        </DiffScroller>
        {parsed.length > MAX_RENDERED_DIFF_LINES &&
          <p className="workspace-limit">{t("workspace.diffRenderLimit", { count: MAX_RENDERED_DIFF_LINES })}</p>}
      </>
    )}
    {diff?.truncated && <p className="workspace-limit">{`${t("workspace.diffTruncated")} ${t("diffNotes.truncated")}`}</p>}
  </>;
}

export function DiffDetail({ snapshot, onEditNote, parked }: {
  snapshot: WorkspaceSnapshot; onEditNote: (target: DiffNoteTarget) => void; parked?: ParkedNote | null;
}) {
  const view = useDiffView(snapshot);
  const { diff, path, kind, layers } = view;
  return <section className="workspace-detail-view workspace-diff-view" aria-label={t("workspace.diff")}>
    <div className="workspace-detail-head">
      <DetailIdentity path={path} />
      {layers.length > 1 ? <LayerSwitch snapshot={snapshot} layers={layers} />
        : <>
          {kind && <GitMark kind={kind} />}
          <span className="workspace-layer-label">{[kind && changeKindLabel(kind), snapshot.diffLayer === "staged" ? t("workspace.staged") : t("workspace.worktree")].filter(Boolean).join(" · ")}</span>
        </>}
      <DiffStats snapshot={snapshot} />
      <span className="workspace-detail-actions">
        {kind !== "deleted" && <Button className="workspace-chip" onClick={() => loadWorkspaceFile(path)}>{t("workspace.openFile")}</Button>}
        <DetailMoreButton />
      </span>
    </div>
    <DiffBody snapshot={snapshot} view={view} onEditNote={onEditNote} parked={parked} />
    <div className="workspace-diff-footer">
      {diff && !diff.binary && <DiffNotesBar key={view.diffKey} path={diff.path} layer={snapshot.diffLayer} paneId={snapshot.paneId} returnView={snapshot.returnView} />}
      <DiffStepper snapshot={snapshot} />
    </div>
  </section>;
}
