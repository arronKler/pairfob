import { Fragment } from "react";
import { highlightSource } from "../../lib/syntax-highlight";
import { t } from "../../lib/i18n";
import { isWorkspacePendingReveal, loadWorkspaceFile, refreshWorkspace, workspaceModel } from "../../workspace";
import { Button } from "./chrome";
import { formatBytes, formatModified } from "./workspace-format";
import { consumeReveal, FilePending, ReservedStat } from "./workspace-pending";

function retryCurrent(): void {
  if (workspaceModel.view === "file" && workspaceModel.detailPath) void loadWorkspaceFile(workspaceModel.detailPath);
  else void refreshWorkspace();
}

export function FileDetail() {
  const file = workspaceModel.file;
  const reveal = file ? consumeReveal("file") : false;
  return <section className="workspace-detail-view" aria-label={t("workspace.file")}>
    <div className="workspace-detail-head">
      <strong className="workspace-detail-name">{file?.path || workspaceModel.detailPath}</strong>
      {file
        ? <span className="workspace-row-meta">{`${formatBytes(file.size)} · ${formatModified(file.modified_ms)}`}</span>
        : workspaceModel.loading ? <ReservedStat className="workspace-row-meta" text={null} /> : null}
    </div>
    {workspaceModel.error ? (
      <div className="workspace-feedback workspace-error workspace-feedback-pane" role="alert">
        <p>{workspaceModel.error}</p>
        <Button className="btn btn-small" onClick={retryCurrent}>{t("ft.retry")}</Button>
      </div>
    ) : !file ? (
      workspaceModel.loading && isWorkspacePendingReveal() ? <FilePending /> : null
    ) : file.kind === "binary" ? (
      <p className="workspace-empty">{t("workspace.binary")}</p>
    ) : (
      <pre className={`workspace-code${reveal ? " workspace-reveal" : ""}`}>
        <code className="workspace-highlight">
          {highlightSource(file.path, file.content).map((token, index) => (
            <Fragment key={index}>
              {token.kind ? <span className={`syntax-${token.kind}`}>{token.text}</span> : token.text}
            </Fragment>
          ))}
        </code>
      </pre>
    )}
    {file?.truncated && <p className="workspace-limit">{t("workspace.previewTruncated")}</p>}
  </section>;
}
