import { HTMLPreview, isHTMLFile } from "./html-preview";
import { FileSource } from "./file-source";
import { PreviewSwitch, usePreviewControls, type PreviewControls } from "./preview-controls";
import { Ellipsis, RotateCw, WrapText } from "lucide-react";
import { useMemo } from "react";
import { highlightSource, type SyntaxToken } from "../../lib/syntax-highlight";
import { t } from "../../lib/i18n";
import type { GitChangeKind } from "../../lib/workspace";
import { Button } from "../../shared/ui/primitives";
import { loadWorkspaceFile, refreshWorkspace } from "./actions";
import { openDetailMenu } from "./detail-menu";
import { viewWorkspaceChanges } from "./file-actions";
import { FileIcon } from "./file-icon";
import { formatBytes, formatModified } from "./format";
import { GitMark } from "./git-mark";
import { gitMarks } from "./git-marks";
import { WorkspaceMedia } from "./media";
import type { WorkspaceSnapshot } from "./model";
import { FilePending, ReservedStat } from "./pending";
import { setWorkspaceWrap, useWorkspaceWrap } from "./prefs";

/**
 * Tokens regrouped per source line. Every line keeps its own "\n", so the
 * code element's text is exactly the file; numbers are CSS counters and never
 * enter a copy.
 */
function sourceLines(path: string, content: string): SyntaxToken[][] {
  const lines: SyntaxToken[][] = [[]];
  for (const token of highlightSource(path, content)) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      const text = index < parts.length - 1 ? `${part}\n` : part;
      if (text) lines[lines.length - 1].push({ ...token, text });
    });
  }
  if (lines.length > 1 && !lines[lines.length - 1].length) lines.pop();
  return lines;
}

/** Name and ⋯ repeat here on the desktop, where the header keeps the repository. */
export function DetailIdentity({ path }: { path: string }) {
  return <span className="workspace-detail-ident">
    <FileIcon kind="file" path={path} />
    <strong className="workspace-detail-name">{path}</strong>
  </span>;
}

export function DetailMoreButton() {
  return <Button className="icon-btn workspace-detail-more-inline" aria-label={t("workspace.moreActions")} aria-haspopup="dialog"
    onClick={() => openDetailMenu()}><Ellipsis size={18} aria-hidden="true" /></Button>;
}

/** The open file, derived once for whichever arrangement shows it: the page or the inspector. */
export type FileView = {
  file: WorkspaceSnapshot["file"];
  path: string;
  text: boolean;
  lines: SyntaxToken[][];
  wrap: boolean;
  preview: PreviewControls | null;
  mark: GitChangeKind | undefined;
  viewChanges: (() => void) | undefined;
  meta: string | null;
};

export function useFileView(snapshot: WorkspaceSnapshot): FileView {
  const file = snapshot.file;
  const wrap = useWorkspaceWrap();
  const preview = usePreviewControls(snapshot);
  const path = file?.path || snapshot.detailPath;
  const text = file?.kind === "text" ? file : null;
  const lines = useMemo(() => text ? sourceLines(text.path, text.content) : [], [text]);
  const mark = gitMarks(snapshot.status).files.get(path);
  const meta = file
    ? [formatBytes(file.size), formatModified(file.modified_ms), text && `${t("workspace.lines", { count: lines.length })}${file.truncated ? "+" : ""}`]
      .filter(Boolean).join(" · ")
    : null;
  return { file, path, preview: file && isHTMLFile(path) ? preview : null, text: text !== null, lines, wrap, mark, viewChanges: mark ? viewWorkspaceChanges(path) : undefined, meta };
}

/** HTML selects its view here; other files show size, age and line count. */
export function FileMeta({ snapshot, view }: { snapshot: WorkspaceSnapshot; view: FileView }) {
  if (view.preview) return <PreviewSwitch controls={view.preview} />;
  if (view.meta) return <span className="workspace-row-meta">{view.meta}</span>;
  return snapshot.loading ? <ReservedStat className="workspace-row-meta" text={null} /> : null;
}

/** File actions stay in one info bar; wrapping only applies to source. */
export function FileActions({ view }: { view: FileView }) {
  return <span className="workspace-detail-actions">
    {view.viewChanges && view.mark && <Button className="workspace-chip is-change" onClick={view.viewChanges}>
      <GitMark kind={view.mark} />{t("workspace.viewChanges")}
    </Button>}
    {view.text && (!view.preview || view.preview.mode === "source") && <Button
      className={view.preview ? "icon-btn workspace-preview-action" : "workspace-chip"}
      aria-label={t("workspace.wrap")} title={t("workspace.wrap")}
      aria-pressed={view.wrap} onClick={() => setWorkspaceWrap(!view.wrap)}>
      <WrapText size={view.preview ? 16 : 14} aria-hidden="true" />{!view.preview && t("workspace.wrap")}
    </Button>}
    {view.preview && <Button className="icon-btn workspace-preview-action" aria-label={t("preview.reload")}
      title={t("preview.reload")} onClick={view.preview.refresh}><RotateCw size={16} aria-hidden="true" /></Button>}
    <DetailMoreButton />
  </span>;
}

/** Everything below the info bar: the source, the media surface, or the state that stands in for them. */
export function FileBody({ snapshot, view }: { snapshot: WorkspaceSnapshot; view: FileView }) {
  const { file, wrap } = view;
  const retry = () => {
    if (snapshot.view === "file" && snapshot.detailPath) void loadWorkspaceFile(snapshot.detailPath);
    else void refreshWorkspace();
  };
  return <>
    {snapshot.error ? (
      <div className="workspace-feedback workspace-error workspace-feedback-pane" role="alert">
        <p>{snapshot.error}</p>
        <Button className="btn btn-small" onClick={retry}>{t("ft.retry")}</Button>
      </div>
    ) : !file ? (
      snapshot.loading && snapshot.pendingReveal ? <FilePending /> : null
    ) : view.preview ? (
      <HTMLPreview key={view.preview.key} snapshot={snapshot} wrap={wrap} controls={view.preview} />
    ) : file.kind === "binary" ? (
      <WorkspaceMedia media={snapshot.media} />
    ) : (
      <>
        <FileSource path={file.path} content={file.content} wrap={wrap} line={snapshot.sourceLine} reveal={snapshot.revealFile} />
        {/* SVG text keeps its safe source and also offers a full-download
            entry through the owned media surface (SvgHint -> loadWorkspaceMedia
            fetches the whole file); never injected inline. */}
        {snapshot.media.role === "svg" ? <WorkspaceMedia media={snapshot.media} /> : null}
      </>
    )}
    {file?.truncated && !isHTMLFile(file.path) && <p className="workspace-limit">{t("workspace.previewTruncated")}</p>}
  </>;
}

export function FileDetail({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const view = useFileView(snapshot);
  return <section className="workspace-detail-view" aria-label={t("workspace.file")}>
    <div className="workspace-detail-head">
      <DetailIdentity path={view.path} />
      <FileMeta snapshot={snapshot} view={view} />
      <FileActions view={view} />
    </div>
    <FileBody snapshot={snapshot} view={view} />
  </section>;
}
