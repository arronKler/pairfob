import { useLayoutEffect, useRef, type ReactNode } from "react";
import { diffNoteTarget, diffNotesFor, type DiffNoteTarget } from "../../lib/diff-notes";
import { parseDiffLines, type DiffLine, type GitLayer } from "../../lib/workspace";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { loadGitDiff, refreshWorkspace } from "./actions";
import { FileIcon } from "./file-icon";
import type { WorkspaceSnapshot } from "./model";
import { DiffNoteCards, DiffNotesBar, diffLineHasNote, diffNoteLineLabel, openNoteEditorAllowed } from "./notes";
import { DiffPending, ReservedStat } from "./pending";

const MAX_RENDERED_DIFF_LINES = 800;

type DiffScrollMemory = { key: string; top: number; left: number };
let diffScrollMemory: DiffScrollMemory | null = null;

function rememberDiffScroll(el: HTMLElement, key: string): void {
  diffScrollMemory = { key, top: el.scrollTop, left: el.scrollLeft };
}

export function DiffScroller({ diffKey, children }: { diffKey: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

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

  return <div ref={ref} className="workspace-diff" role="table" data-diff-key={diffKey}>
    {children}
  </div>;
}

function DiffLineRow({
  line, noteable, path, layer, onEdit,
}: {
  line: DiffLine; noteable: boolean; path: string; layer: GitLayer; onEdit: (target: DiffNoteTarget) => void;
}) {
  const target = noteable ? diffNoteTarget(path, layer, line) : null;
  const noted = target ? diffLineHasNote(target) : false;
  const label = target ? t(noted ? "diffNotes.editTitle" : "diffNotes.addTitle", { line: target.line }) : undefined;
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
      {target && <Button className="diff-comment-btn" aria-label={label} title={diffNoteLineLabel(target)} onClick={(event) => {
        event.stopPropagation();
        open();
      }}>+</Button>}
      <span className="diff-line-number">{line.oldLine === null ? "" : String(line.oldLine)}</span>
      <span className="diff-line-number">{line.newLine === null ? "" : String(line.newLine)}</span>
      <code className="diff-line-text">{line.text || " "}</code>
    </div>
    {target && <DiffNoteCards target={target} onEdit={onEdit} />}
  </>;
}

export function DiffDetail({ snapshot, onEditNote }: { snapshot: WorkspaceSnapshot; onEditNote: (target: DiffNoteTarget) => void }) {
  const diff = snapshot.diff;
  const parsed = diff && !diff.binary ? parseDiffLines(diff.patch) : [];
  const noteable = Boolean(diff && !diff.truncated);
  const diffKey = diff ? `${diff.path}:${snapshot.diffLayer}` : "";
  const retry = () => {
    if (snapshot.detailPath) void loadGitDiff(snapshot.detailPath, snapshot.diffLayer);
    else void refreshWorkspace();
  };

  return <section className="workspace-detail-view workspace-diff-view" aria-label={t("workspace.diff")}>
    <div className="workspace-detail-head">
      <FileIcon kind="file" path={diff?.path || snapshot.detailPath} />
      <strong className="workspace-detail-name">{diff?.path || snapshot.detailPath}</strong>
      <span className="workspace-layer-label">{snapshot.diffLayer === "staged" ? t("workspace.staged") : t("workspace.worktree")}</span>
      {diff ? (
        <>
          <span className="workspace-additions">{t("workspace.additions", { count: diff.additions })}</span>
          <span className="workspace-deletions">{t("workspace.deletions", { count: diff.deletions })}</span>
        </>
      ) : snapshot.loading ? (
        <><ReservedStat className="workspace-additions" text={null} /><ReservedStat className="workspace-deletions" text={null} /></>
      ) : null}
    </div>
    {snapshot.error ? (
      <div className="workspace-feedback workspace-error workspace-feedback-pane" role="alert">
        <p>{snapshot.error}</p>
        <Button className="btn btn-small" onClick={retry}>{t("ft.retry")}</Button>
      </div>
    ) : !diff ? (
      snapshot.loading && snapshot.pendingReveal ? <DiffPending /> : null
    ) : diff.binary ? (
      <p className="workspace-empty">{t("workspace.binary")}</p>
    ) : !parsed.length || !diff.patch ? (
      <p className="workspace-empty">{t("workspace.diffEmpty")}</p>
    ) : (
      <>
        {noteable && !diffNotesFor(diff.path, snapshot.diffLayer).length &&
          <p className="workspace-diff-hint">{t("diffNotes.tapHint")}</p>}
        <DiffScroller diffKey={diffKey}>
          {parsed.slice(0, MAX_RENDERED_DIFF_LINES).map((line, index) => (
            <DiffLineRow key={index} line={line} noteable={noteable} path={diff.path} layer={snapshot.diffLayer} onEdit={onEditNote} />
          ))}
        </DiffScroller>
        {parsed.length > MAX_RENDERED_DIFF_LINES &&
          <p className="workspace-limit">{t("workspace.diffRenderLimit", { count: MAX_RENDERED_DIFF_LINES })}</p>}
        <DiffNotesBar path={diff.path} layer={snapshot.diffLayer} />
      </>
    )}
    {diff?.truncated && <p className="workspace-limit">{`${t("workspace.diffTruncated")} ${t("diffNotes.truncated")}`}</p>}
  </section>;
}
