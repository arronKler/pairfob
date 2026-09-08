import { gitChangeKind, gitLayers, type GitChange, type GitLayer } from "../../lib/workspace";
import { t } from "../../lib/i18n";
import { loadGitDiff, showMoreWorkspaceChanges, toggleWorkspaceChangeGroup, workspaceModel } from "../../workspace";
import { Button, Chevron } from "./chrome";
import { CHANGE_CODES, changeKindLabel, layerLabel } from "./workspace-format";
import { consumeReveal } from "./workspace-pending";

function ChangeRow({ change, layer }: { change: GitChange; layer: GitLayer }) {
  const kind = gitChangeKind(change, layer);
  const active = workspaceModel.view === "diff" && workspaceModel.detailPath === change.path && workspaceModel.diffLayer === layer;
  const directory = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
  return <Button
    className={`workspace-change status-${kind}${active ? " active" : ""}`}
    aria-label={`${change.path} · ${layerLabel(change, layer)} · ${changeKindLabel(kind)}`}
    onClick={() => loadGitDiff(change.path, layer)}
  >
    <span className="workspace-change-head">
      <span className="workspace-row-name">{change.path.split("/").pop() || change.path}</span>
      {directory ? <span className="workspace-row-meta">{directory}</span> : null}
      {change.original_path ? <span className="workspace-rename">{t("workspace.renamed", { path: change.original_path })}</span> : null}
    </span>
    <span className="workspace-change-mark" title={changeKindLabel(kind)} aria-hidden="true">{CHANGE_CODES[kind]}</span>
  </Button>;
}

function ChangeGroup({ layer, changes }: { layer: GitLayer; changes: GitChange[] }) {
  const expanded = workspaceModel.changeGroupsExpanded[layer];
  const label = layer === "staged" ? t("workspace.groupStaged") : t("workspace.groupWorktree");
  return <section className={`workspace-change-group workspace-change-group-${layer}`}>
    <Button className="workspace-change-group-title" aria-expanded={expanded} aria-label={label} onClick={() => toggleWorkspaceChangeGroup(layer)}>
      <Chevron className="group-chev" />
      <span className="workspace-change-group-name">{label}</span>
      <span className="workspace-change-group-count">{String(changes.length)}</span>
    </Button>
    {expanded && <div className="workspace-change-rows">
      {changes.map((change) => <ChangeRow key={`${layer}:${change.path}`} change={change} layer={layer} />)}
    </div>}
  </section>;
}

export function ChangeList() {
  const status = workspaceModel.status;
  const changes = status?.changes ?? [];
  const visible = changes.slice(0, workspaceModel.changeLimit);
  const staged = visible.filter((change) => gitLayers(change).includes("staged"));
  const worktree = visible.filter((change) => gitLayers(change).includes("worktree"));
  const reveal = consumeReveal("nav");
  return <section className={`workspace-panel workspace-changes${reveal ? " workspace-reveal" : ""}`}>
    {status && <div className="workspace-status-summary">
      <strong className="workspace-status-branch">{status.branch || t("workspace.detached")}</strong>
      {status.ahead ? <span className="workspace-sync">{t("workspace.ahead", { count: status.ahead })}</span> : null}
      {status.behind ? <span className="workspace-sync">{t("workspace.behind", { count: status.behind })}</span> : null}
    </div>}
    <div className="workspace-change-groups">
      {staged.length > 0 && <ChangeGroup layer="staged" changes={staged} />}
      {worktree.length > 0 && <ChangeGroup layer="worktree" changes={worktree} />}
      {!workspaceModel.loading && !workspaceModel.error && !changes.length &&
        <p className="workspace-empty">{t("workspace.noChanges")}</p>}
    </div>
    {changes.length > workspaceModel.changeLimit && (
      <Button className="workspace-more" onClick={showMoreWorkspaceChanges}>
        {t("workspace.showMoreChanges", { count: changes.length - workspaceModel.changeLimit })}
      </Button>
    )}
  </section>;
}
