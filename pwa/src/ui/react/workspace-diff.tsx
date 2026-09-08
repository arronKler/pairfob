import { useLayoutEffect, useRef } from "react";
import { diffNoteTarget, diffNotesFor, type DiffNoteTarget } from "../../lib/diff-notes";
import { parseDiffLines, type DiffLine } from "../../lib/workspace";
import { t } from "../../lib/i18n";
import { isWorkspacePendingReveal, loadGitDiff, refreshWorkspace, workspaceModel } from "../../workspace";
import { Button } from "./chrome";
import { DiffNoteCards, DiffNotesBar, diffLineHasNote, diffNoteLineLabel, openNoteEditorAllowed } from "./workspace-notes";
import { DiffPending, ReservedStat } from "./workspace-pending";

const MAX_RENDERED_DIFF_LINES = 800;

let lastDiffScroll: { key: string; top: number; left: number } | null = null;

export function captureDiffScroll(host: ParentNode | null): void {
  const prev = host?.querySelector<HTMLElement>(".workspace-diff");
  const prevKey = prev?.dataset.diffKey;
  lastDiffScroll = prev && prevKey ? { key: prevKey, top: prev.scrollTop, left: prev.scrollLeft } : null;
}

function retryCurrent(): void {
  if (workspaceModel.detailPath) void loadGitDiff(workspaceModel.detailPath, workspaceModel.diffLayer);
  else void refreshWorkspace();
}

function DiffLineRow({
  line, noteable, path, onEdit,
}: {
  line: DiffLine; noteable: boolean; path: string; onEdit: (target: DiffNoteTarget) => void;
}) {
  const target = noteable ? diffNoteTarget(path, workspaceModel.diffLayer, line) : null;
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

export function DiffDetail({ onEditNote }: { onEditNote: (target: DiffNoteTarget) => void }) {
  const diff = workspaceModel.diff;
  const tableRef = useRef<HTMLDivElement>(null);
  const parsed = diff && !diff.binary ? parseDiffLines(diff.patch) : [];
  const noteable = Boolean(diff && !diff.truncated);
  const diffKey = diff ? `${diff.path}:${workspaceModel.diffLayer}` : "";

  useLayoutEffect(() => {
    const next = tableRef.current;
    const scroll = lastDiffScroll;
    if (!next) return;
    const same = scroll?.key === diffKey;
    const apply = () => {
      if (tableRef.current !== next || next.dataset.diffKey !== diffKey) return;
      next.scrollLeft = same ? scroll!.left : 0;
      next.scrollTop = same ? scroll!.top : 0;
    };
    apply();
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(apply);
      return () => cancelAnimationFrame(frame);
    }
  });

  return <section className="workspace-detail-view workspace-diff-view" aria-label={t("workspace.diff")}>
    <div className="workspace-detail-head">
      <strong className="workspace-detail-name">{diff?.path || workspaceModel.detailPath}</strong>
      <span className="workspace-layer-label">{workspaceModel.diffLayer === "staged" ? t("workspace.staged") : t("workspace.worktree")}</span>
      {diff ? (
        <>
          <span className="workspace-additions">{t("workspace.additions", { count: diff.additions })}</span>
          <span className="workspace-deletions">{t("workspace.deletions", { count: diff.deletions })}</span>
        </>
      ) : workspaceModel.loading ? (
        <><ReservedStat className="workspace-additions" text={null} /><ReservedStat className="workspace-deletions" text={null} /></>
      ) : null}
    </div>
    {workspaceModel.error ? (
      <div className="workspace-feedback workspace-error workspace-feedback-pane" role="alert">
        <p>{workspaceModel.error}</p>
        <Button className="btn btn-small" onClick={retryCurrent}>{t("ft.retry")}</Button>
      </div>
    ) : !diff ? (
      workspaceModel.loading && isWorkspacePendingReveal() ? <DiffPending /> : null
    ) : diff.binary ? (
      <p className="workspace-empty">{t("workspace.binary")}</p>
    ) : !parsed.length || !diff.patch ? (
      <p className="workspace-empty">{t("workspace.diffEmpty")}</p>
    ) : (
      <>
        {noteable && !diffNotesFor(diff.path, workspaceModel.diffLayer).length &&
          <p className="workspace-diff-hint">{t("diffNotes.tapHint")}</p>}
        <div ref={tableRef} className="workspace-diff" role="table" data-diff-key={diffKey}>
          {parsed.slice(0, MAX_RENDERED_DIFF_LINES).map((line, index) => (
            <DiffLineRow key={index} line={line} noteable={noteable} path={diff.path} onEdit={onEditNote} />
          ))}
        </div>
        {parsed.length > MAX_RENDERED_DIFF_LINES &&
          <p className="workspace-limit">{t("workspace.diffRenderLimit", { count: MAX_RENDERED_DIFF_LINES })}</p>}
        <DiffNotesBar path={diff.path} layer={workspaceModel.diffLayer} />
      </>
    )}
    {diff?.truncated && <p className="workspace-limit">{`${t("workspace.diffTruncated")} ${t("diffNotes.truncated")}`}</p>}
  </section>;
}
