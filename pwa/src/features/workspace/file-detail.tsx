import { Fragment } from "react";
import { highlightSource } from "../../lib/syntax-highlight";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { loadWorkspaceFile, refreshWorkspace } from "./actions";
import { FileIcon } from "./file-icon";
import { formatBytes, formatModified } from "./format";
import { WorkspaceMedia } from "./media";
import type { WorkspaceSnapshot } from "./model";
import { FilePending, ReservedStat } from "./pending";

export function FileDetail({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const file = snapshot.file;
  const reveal = Boolean(file && snapshot.revealFile);
  const retry = () => {
    if (snapshot.view === "file" && snapshot.detailPath) void loadWorkspaceFile(snapshot.detailPath);
    else void refreshWorkspace();
  };
  return <section className="workspace-detail-view" aria-label={t("workspace.file")}>
    <div className="workspace-detail-head">
      <FileIcon kind="file" path={file?.path || snapshot.detailPath} />
      <strong className="workspace-detail-name">{file?.path || snapshot.detailPath}</strong>
      {file
        ? <span className="workspace-row-meta">{`${formatBytes(file.size)} · ${formatModified(file.modified_ms)}`}</span>
        : snapshot.loading ? <ReservedStat className="workspace-row-meta" text={null} /> : null}
    </div>
    {snapshot.error ? (
      <div className="workspace-feedback workspace-error workspace-feedback-pane" role="alert">
        <p>{snapshot.error}</p>
        <Button className="btn btn-small" onClick={retry}>{t("ft.retry")}</Button>
      </div>
    ) : !file ? (
      snapshot.loading && snapshot.pendingReveal ? <FilePending /> : null
    ) : file.kind === "binary" ? (
      <WorkspaceMedia media={snapshot.media} />
    ) : (
      <>
        <pre className={`workspace-code${reveal ? " workspace-reveal" : ""}`}>
          <code className="workspace-highlight">
            {highlightSource(file.path, file.content).map((token, index) => (
              <Fragment key={index}>
                {token.kind ? <span className={`syntax-${token.kind}`}>{token.text}</span> : token.text}
              </Fragment>
            ))}
          </code>
        </pre>
        {/* SVG text keeps its safe source and also offers a full-download
            entry through the owned media surface (SvgHint -> loadWorkspaceMedia
            fetches the whole file); never injected inline. */}
        {snapshot.media.role === "svg" ? <WorkspaceMedia media={snapshot.media} /> : null}
      </>
    )}
    {file?.truncated && <p className="workspace-limit">{t("workspace.previewTruncated")}</p>}
  </section>;
}
