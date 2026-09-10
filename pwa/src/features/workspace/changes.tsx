import { gitChangeKind, gitLayers, type GitChange, type GitLayer } from "../../lib/workspace";
import { t } from "../../lib/i18n";
import { Button, Chevron } from "../../shared/ui/primitives";
import { loadGitDiff, showMoreWorkspaceChanges, toggleWorkspaceChangeGroup } from "./actions";
import { CHANGE_CODES, changeKindLabel, layerLabel } from "./format";
import { FileIcon } from "./file-icon";
import type { WorkspaceSnapshot } from "./model";


function ChangeRow({ change, layer, snapshot }: { change: GitChange; layer: GitLayer; snapshot: WorkspaceSnapshot }) {
  const kind = gitChangeKind(change, layer);
  const active = snapshot.view === "diff" && snapshot.detailPath === change.path && snapshot.diffLayer === layer;
  const directory = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
  return <Button
    className={`workspace-change status-${kind}${active ? " active" : ""}`}
    aria-label={`${change.path} · ${layerLabel(change, layer)} · ${changeKindLabel(kind)}`}
    onClick={() => loadGitDiff(change.path, layer)}
  >
    <FileIcon kind="file" path={change.path} />
    <span className="workspace-change-head">
      <span className="workspace-row-name">{change.path.split("/").pop() || change.path}</span>
      {directory ? <span className="workspace-row-meta">{directory}</span> : null}
      {change.original_path ? <span className="workspace-rename">{t("workspace.renamed", { path: change.original_path })}</span> : null}
    </span>
    <span className="workspace-change-mark" title={changeKindLabel(kind)} aria-hidden="true">{CHANGE_CODES[kind]}</span>
  </Button>;
}

function ChangeGroup({ layer, changes, snapshot }: { layer: GitLayer; changes: GitChange[]; snapshot: WorkspaceSnapshot }) {
  const expanded = snapshot.changeGroupsExpanded[layer];
  const label = layer === "staged" ? t("workspace.groupStaged") : t("workspace.groupWorktree");
  return <section className={`workspace-change-group workspace-change-group-${layer}`}>
    <Button className="workspace-change-group-title" aria-expanded={expanded} aria-label={label} onClick={() => toggleWorkspaceChangeGroup(layer)}>
      <Chevron className="group-chev" />
      <span className="workspace-change-group-name">{label}</span>
      <span className="workspace-change-group-count">{String(changes.length)}</span>
    </Button>
    {expanded && <div className="workspace-change-rows">
      {changes.map((change) => <ChangeRow key={`${layer}:${change.path}`} change={change} layer={layer} snapshot={snapshot} />)}
    </div>}
  </section>;
}

export function ChangeList({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const status = snapshot.status;
  const changes = status?.changes ?? [];
  const visible = changes.slice(0, snapshot.changeLimit);
  const staged = visible.filter((change) => gitLayers(change).includes("staged"));
  const worktree = visible.filter((change) => gitLayers(change).includes("worktree"));
  const reveal = snapshot.revealNav;
  return <section className={`workspace-panel workspace-changes${reveal ? " workspace-reveal" : ""}`}>
    {status && <div className="workspace-status-summary">
      <strong className="workspace-status-branch">{status.branch || t("workspace.detached")}</strong>
      {status.ahead ? <span className="workspace-sync">{t("workspace.ahead", { count: status.ahead })}</span> : null}
      {status.behind ? <span className="workspace-sync">{t("workspace.behind", { count: status.behind })}</span> : null}
    </div>}
    <div className="workspace-change-groups">
      {staged.length > 0 && <ChangeGroup layer="staged" changes={staged} snapshot={snapshot} />}
      {worktree.length > 0 && <ChangeGroup layer="worktree" changes={worktree} snapshot={snapshot} />}
      {!snapshot.loading && !snapshot.error && !changes.length &&
        <p className="workspace-empty">{t("workspace.noChanges")}</p>}
    </div>
    {changes.length > snapshot.changeLimit && (
      <Button className="workspace-more" onClick={showMoreWorkspaceChanges}>
        {t("workspace.showMoreChanges", { count: changes.length - snapshot.changeLimit })}
      </Button>
    )}
  </section>;
}
